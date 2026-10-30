-- =====================================================================
-- CHILL ZONE — серверная логика (RPC)
-- Все публичные функции принимают один аргумент p jsonb.
-- =====================================================================

-- ---------- Вспомогательные ----------
create or replace function _setting(k text) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as
$$ select value from settings where key = k $$;

create or replace function _tz() returns text
language sql stable security definer set search_path = public, extensions, pg_temp as
$$ select coalesce(_setting('timezone')#>>'{}', 'Europe/Moscow') $$;

create or replace function _local(ts timestamptz) returns timestamp
language sql stable security definer set search_path = public, extensions, pg_temp as
$$ select ts at time zone _tz() $$;

create or replace function _sha(t text) returns text
language sql immutable set search_path = public, extensions, pg_temp as
$$ select encode(extensions.digest(coalesce(t,''), 'sha256'), 'hex') $$;

create or replace function _rand_code(len int) returns text
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(len); r text := ''; i int;
begin
  for i in 0..len-1 loop r := r || substr(alphabet, (get_byte(b,i) % 32) + 1, 1); end loop;
  return r;
end $$;

create or replace function _audit(actor text, bid uuid, act text, det jsonb default '{}') returns void
language sql volatile security definer set search_path = public, extensions, pg_temp as
$$ insert into audit_log(actor, booking_id, action, details) values (actor, bid, act, coalesce(det,'{}'::jsonb)) $$;

create or replace function _status_ru(s text) returns text language sql immutable as $$
  select case s
    when 'awaiting_payment' then 'Ожидает оплаты'
    when 'receipt_sent' then 'Чек отправлен'
    when 'pending_review' then 'Ожидает проверки'
    when 'payment_verified' then 'Оплата проверена'
    when 'confirmed' then 'Подтверждено'
    when 'rejected' then 'Отклонено'
    when 'cancelled' then 'Отменено'
    when 'expired' then 'Время истекло'
    else s end $$;

-- Уведомление: всегда в админ-панели; в Telegram — только если интеграция включена и pg_net подключён.
create or replace function _notify(ev text, bid uuid, msg text) returns void
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare tg jsonb := _setting('telegram'); st text := 'in_app';
begin
  if coalesce((tg->>'enabled')::boolean, false) and coalesce(tg->>'bot_token','') <> '' and coalesce(tg->>'chat_id','') <> '' then
    if to_regproc('net.http_post') is not null then
      begin
        execute 'select net.http_post(url := $1, body := $2, headers := $3)'
          using 'https://api.telegram.org/bot' || (tg->>'bot_token') || '/sendMessage',
                jsonb_build_object('chat_id', tg->>'chat_id', 'text', 'CHILL ZONE: ' || msg),
                '{"Content-Type":"application/json"}'::jsonb;
        st := 'telegram_queued';
      exception when others then st := 'telegram_error';
      end;
    else
      st := 'telegram_not_available';
    end if;
  end if;
  insert into notifications(event, booking_id, message, channel_status) values (ev, bid, msg, st);
end $$;

-- Освобождение просроченных удержаний (вызывается перед каждой проверкой доступности)
create or replace function _expire_holds() returns void
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare r record;
begin
  for r in update bookings set status = 'expired', updated_at = now()
           where status = 'awaiting_payment' and hold_until is not null and hold_until < now()
           returning id, code loop
    update booking_slots set active = false where booking_id = r.id;
    perform _audit('system', r.id, 'expired', jsonb_build_object('code', r.code));
  end loop;
end $$;

-- Открыто ли в этот момент по расписанию wh (общему клуба или своему у устройства)
create or replace function _open_by(wh jsonb, ts timestamptz) returns boolean
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare lt timestamp := _local(ts); t time := lt::time;
  d int := extract(isodow from lt)::int; pd int; today jsonb; prev jsonb; o time; c time;
begin
  if wh is null or coalesce((wh->>'always_open')::boolean, true) then return true; end if;
  pd := case when d = 1 then 7 else d - 1 end;
  today := wh->'days'->(d::text); prev := wh->'days'->(pd::text);
  if today is not null and not coalesce((today->>'closed')::boolean,false) then
    o := (today->>'open')::time; c := (today->>'close')::time;
    if o < c and t >= o and t < c then return true; end if;
    if o >= c and t >= o then return true; end if;
  end if;
  if prev is not null and not coalesce((prev->>'closed')::boolean,false) then
    o := (prev->>'open')::time; c := (prev->>'close')::time;
    if o >= c and t < c then return true; end if;
  end if;
  return false;
end $$;

create or replace function _is_open(ts timestamptz) returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as
$$ select _open_by(_setting('work_hours'), ts) $$;

create or replace function _in_window(t time, f time, tt time) returns boolean language sql immutable as $$
  select case when f is null or tt is null then true
              when f < tt then t >= f and t < tt
              else t >= f or t < tt end $$;

-- Ресурсы, которые занимает бронь оборудования
create or replace function _resources_for(eq_id text) returns text[]
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select case when eq_id = 'room'
    then array(select id from equipment where kind not in ('room','tv') order by id) || array['room']
    else array[eq_id] end $$;

-- ---------- Расчёт стоимости ----------
create or replace function _quote(eq_id text, st timestamptz, paid_min int, ppl int, student boolean) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare
  e equipment; room jsonb := _setting('room'); night jsonb := _setting('night');
  seg_start timestamptz; lt timestamp; rate numeric; base numeric; r tariff_rules;
  base_sum numeric := 0; extra_sum numeric := 0; extra_people int := 0; extra_price numeric := 0;
  lines jsonb := '{}'::jsonb; label text; disc_pct numeric := 0; disc_label text := null; p promotions;
  bonus int := 0; bonus_label text := null; tier jsonb; is_night boolean := false; total numeric; due numeric;
  en timestamptz; student_pct numeric := coalesce((_setting('student_discount_percent')#>>'{}')::numeric, 0); i int; nseg int;
begin
  select * into e from equipment where id = eq_id;
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  if e.price_per_hour is null then return jsonb_build_object('price_set', false); end if;
  base := e.price_per_hour;
  if e.kind = 'room' then
    extra_people := greatest(coalesce(ppl,1) - coalesce((room->>'base_people')::int, 5), 0);
    extra_price := coalesce((room->>'extra_person_price')::numeric, 0);
  end if;
  nseg := paid_min / 30;
  for i in 0..nseg-1 loop
    seg_start := st + make_interval(mins => i*30);
    lt := _local(seg_start);
    rate := base; label := 'Базовый тариф';
    select * into r from tariff_rules t
      where t.is_active
        and (t.applies_to = 'all' or t.applies_to = 'kind:' || e.kind or t.applies_to = 'id:' || e.id)
        and (t.days is null or cardinality(t.days) = 0 or extract(isodow from lt)::int = any(t.days))
        and (t.dates is null or cardinality(t.dates) = 0 or lt::date = any(t.dates))
        and _in_window(lt::time, t.time_from, t.time_to)
      order by t.priority desc, t.created_at desc limit 1;
    if found then
      label := r.name;
      if r.mode = 'price' then rate := r.value; else rate := round(base * (100 - r.value) / 100); end if;
    end if;
    base_sum := base_sum + rate / 2;
    extra_sum := extra_sum + extra_people * extra_price / 2;
    lines := jsonb_set(lines, array[label || '|' || rate::text],
      to_jsonb(coalesce((lines->>(label || '|' || rate::text))::int, 0) + 30));
    if coalesce((night->>'enabled')::boolean, false)
       and _in_window(lt::time, (night->>'start')::time, (night->>'end')::time) then
      is_night := true;
    end if;
  end loop;

  -- скидки: студенческая или акция (берётся лучшая, не суммируются)
  if student and student_pct > 0 then disc_pct := student_pct; disc_label := 'Студенческая скидка'; end if;
  for p in select * from promotions where is_active and type = 'discount'
             and (starts_on is null or starts_on <= _local(st)::date)
             and (ends_on is null or ends_on >= _local(st)::date) loop
    if (coalesce(p.config->>'applies_to','all') in ('all', 'kind:' || e.kind, 'id:' || e.id))
       and paid_min >= coalesce((p.config->>'min_minutes')::int, 0)
       and coalesce((p.config->>'percent')::numeric,0) > disc_pct then
      disc_pct := (p.config->>'percent')::numeric; disc_label := p.title;
    end if;
  end loop;
  -- бонусное время
  for p in select * from promotions where is_active and type = 'bonus_time'
             and (starts_on is null or starts_on <= _local(st)::date)
             and (ends_on is null or ends_on >= _local(st)::date) loop
    if coalesce(p.config->>'applies_to','all') in ('all', 'kind:' || e.kind, 'id:' || e.id) then
      for tier in select * from jsonb_array_elements(coalesce(p.config->'tiers','[]'::jsonb)) loop
        if paid_min >= (tier->>'min_minutes')::int and (tier->>'bonus_minutes')::int > bonus then
          bonus := (tier->>'bonus_minutes')::int; bonus_label := p.title;
        end if;
      end loop;
    end if;
  end loop;

  total := round(base_sum * (100 - disc_pct) / 100) + round(extra_sum);
  due := total;
  if is_night then due := least(total, coalesce((night->>'prepay')::numeric, total)); end if;
  en := st + make_interval(mins => paid_min + bonus);

  return jsonb_build_object(
    'price_set', true,
    'base_rate', base,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('label', split_part(k,'|',1), 'rate', split_part(k,'|',2)::numeric, 'minutes', v::int)), '[]'::jsonb) from jsonb_each_text(lines) as x(k,v)),
    'base_sum', round(base_sum),
    'extra_people', extra_people, 'extra_person_price', extra_price, 'extra_sum', round(extra_sum),
    'discount_percent', disc_pct, 'discount_label', disc_label, 'discount_sum', round(base_sum) - round(base_sum * (100 - disc_pct) / 100),
    'bonus_minutes', bonus, 'bonus_label', bonus_label,
    'is_night', is_night, 'night', case when is_night then night else null end,
    'paid_minutes', paid_min, 'starts_at', st, 'ends_at', en,
    'total', total::int, 'due_now', due::int);
end $$;

-- Проверка параметров бронирования (общая для сайта и админки)
create or replace function _validate_slot(e equipment, st timestamptz, paid_min int, from_admin boolean) returns void
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare durs jsonb := _setting('durations'); cd jsonb := _setting('custom_duration');
  horizon int := coalesce((_setting('booking_horizon_days')#>>'{}')::int, 30); i int;
begin
  if st is null or paid_min is null then raise exception 'BAD_INPUT'; end if;
  if extract(second from st) <> 0 or extract(minute from st)::int % 30 <> 0 then raise exception 'BAD_TIME'; end if;
  if paid_min <= 0 or paid_min % 30 <> 0 or paid_min > 24*60 then raise exception 'BAD_DURATION'; end if;
  if not from_admin then
    if not (durs @> to_jsonb(paid_min))
       and not (coalesce((cd->>'enabled')::boolean,false)
                and paid_min >= coalesce((cd->>'min')::int,30) and paid_min <= coalesce((cd->>'max')::int,720)) then
      raise exception 'BAD_DURATION';
    end if;
    if st < now() - interval '5 minutes' then raise exception 'TIME_IN_PAST'; end if;
    if st > now() + make_interval(days => horizon) then raise exception 'TOO_FAR'; end if;
    if not e.bookable or not e.is_active or e.status <> 'ok' then raise exception 'EQUIPMENT_UNAVAILABLE'; end if;
    for i in 0..(paid_min/30)-1 loop
      if not _is_open(st + make_interval(mins => i*30)) then raise exception 'CLOSED_HOURS'; end if;
      if e.schedule is not null and not _open_by(e.schedule, st + make_interval(mins => i*30)) then raise exception 'CLOSED_HOURS'; end if;
    end loop;
  end if;
end $$;

-- Занять слоты; при пересечении — ошибка SLOT_TAKEN
create or replace function _occupy(bid uuid, blid uuid, eq_id text, st timestamptz, en timestamptz) returns void
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare res text;
begin
  if eq_id <> 'room' and exists (select 1 from booking_slots where active and resource = 'room' and period && tstzrange(st, en)) then
    raise exception 'SLOT_TAKEN';
  end if;
  foreach res in array _resources_for(eq_id) loop
    insert into booking_slots(booking_id, block_id, resource, period) values (bid, blid, res, tstzrange(st, en));
  end loop;
exception when exclusion_violation then
  raise exception 'SLOT_TAKEN';
end $$;

create or replace function _norm_phone(ph text) returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(ph,''), '\D', '', 'g');
begin
  if length(d) = 11 and left(d,1) = '8' then d := '7' || substr(d,2); end if;
  if length(d) = 10 and left(d,1) = '9' then d := '7' || d; end if;
  if length(d) < 10 or length(d) > 15 then return null; end if;
  return d;
end $$;

create or replace function _booking_public(b bookings) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object(
    'code', b.code, 'equipment_id', b.equipment_id, 'equipment_name', b.equipment_name,
    'customer_name', b.customer_name, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'paid_minutes', b.paid_minutes, 'bonus_minutes', b.bonus_minutes, 'people', b.people,
    'total', b.total, 'due_now', b.due_now, 'is_night', b.is_night, 'quote', b.quote,
    'status', b.status, 'status_ru', _status_ru(b.status), 'payment_status', b.payment_status,
    'hold_until', b.hold_until, 'created_at', b.created_at, 'server_now', now(),
    'has_receipt', exists(select 1 from receipts r where r.booking_id = b.id),
    'payment', _setting('payment'))
$$;

-- =====================================================================
-- ПУБЛИЧНЫЕ ФУНКЦИИ
-- =====================================================================

create or replace function get_public_data(p jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _expire_holds();
  return jsonb_build_object(
    'server_now', now(),
    'equipment', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'kind', e.kind, 'description', e.description, 'features', e.features,
        'price_per_hour', e.price_per_hour, 'max_players', e.max_players, 'bookable', e.bookable,
        'status', e.status, 'status_note', e.status_note, 'photo_url', e.photo_url, 'has_photo', e.has_photo,
        'map_x', e.map_x, 'map_y', e.map_y, 'map_rot', e.map_rot, 'link_to', e.link_to, 'sort', e.sort,
        'map_scale', e.map_scale, 'model', e.model, 'label', e.label, 'schedule', e.schedule,
        'busy_now', exists(select 1 from booking_slots s where s.active and s.period @> now()
                           and (s.resource = e.id or (e.kind = 'room' and s.resource <> 'room') or s.resource = 'room'))
      ) order by e.sort, e.id), '[]'::jsonb) from equipment e where e.is_active),
    'settings', jsonb_build_object(
        'timezone', _tz(), 'hold_minutes', _setting('hold_minutes'), 'durations', _setting('durations'),
        'custom_duration', _setting('custom_duration'), 'booking_horizon_days', _setting('booking_horizon_days'),
        'work_hours', _setting('work_hours'), 'room', _setting('room'),
        'student_discount_percent', _setting('student_discount_percent'), 'night', _setting('night'),
        'payment', _setting('payment'), 'contacts', _setting('contacts')),
    'promotions', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'description', description,
        'type', type, 'config', config, 'starts_on', starts_on, 'ends_on', ends_on) order by sort, created_at), '[]'::jsonb)
        from promotions where is_active and (ends_on is null or ends_on >= _local(now())::date)),
    'tariffs', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'applies_to', applies_to,
        'days', days, 'dates', dates, 'time_from', time_from, 'time_to', time_to, 'mode', mode, 'value', value) order by priority desc), '[]'::jsonb)
        from tariff_rules where is_active)
  );
end $$;

create or replace function get_equipment_photo(p jsonb) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('id', equipment_id, 'src', 'data:' || mime || ';base64,' || data)
  from equipment_photos where equipment_id = p->>'id' $$;

-- Занятые интервалы для устройства на дату (без личных данных)
create or replace function get_availability(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare eq_id text := p->>'equipment_id'; d date := (p->>'date')::date; f timestamptz; t timestamptz; res text[];
begin
  perform _expire_holds();
  f := (d::timestamp - interval '1 day') at time zone _tz();
  t := (d::timestamp + interval '3 day') at time zone _tz();
  res := case when eq_id = 'room' then _resources_for('room') else array[eq_id, 'room'] end;
  return jsonb_build_object('server_now', now(), 'busy', (
    select coalesce(jsonb_agg(jsonb_build_object('from', lower(x.period), 'to', upper(x.period))), '[]'::jsonb)
    from (select distinct period from booking_slots s where s.active and s.resource = any(res) and s.period && tstzrange(f, t)) x));
end $$;

-- Какие ресурсы заняты в интервале (для раскраски 3D-схемы)
create or replace function get_occupancy(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare f timestamptz := (p->>'from')::timestamptz; t timestamptz := (p->>'to')::timestamptz; room_busy boolean;
begin
  perform _expire_holds();
  if t <= f then raise exception 'BAD_INPUT'; end if;
  select exists(select 1 from booking_slots where active and resource = 'room' and period && tstzrange(f,t)) into room_busy;
  return jsonb_build_object('room_booked', room_busy, 'busy', (
    select coalesce(jsonb_agg(distinct resource), '[]'::jsonb) from booking_slots
    where active and resource <> 'room' and period && tstzrange(f,t)));
end $$;

create or replace function quote_booking(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
begin
  return _quote(p->>'equipment_id', (p->>'starts_at')::timestamptz, (p->>'paid_minutes')::int,
                coalesce((p->>'people')::int, 1), coalesce((p->>'is_student')::boolean, false));
end $$;

create or replace function create_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare e equipment; st timestamptz := (p->>'starts_at')::timestamptz; pm int := (p->>'paid_minutes')::int;
  ppl int := coalesce((p->>'people')::int, 1); stud boolean := coalesce((p->>'is_student')::boolean, false);
  nm text := btrim(coalesce(p->>'name','')); ph text := _norm_phone(p->>'phone'); q jsonb; b bookings;
  tok text := encode(extensions.gen_random_bytes(24), 'hex'); cd text; cid uuid; hold int := coalesce((_setting('hold_minutes')#>>'{}')::int, 15);
  room jsonb := _setting('room');
begin
  perform _expire_holds();
  select * into e from equipment where id = p->>'equipment_id';
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  if length(nm) < 2 or length(nm) > 60 then raise exception 'BAD_NAME'; end if;
  if ph is null then raise exception 'BAD_PHONE'; end if;
  if e.kind = 'room' then
    if ppl < 1 or ppl > coalesce((room->>'max_people')::int, 20) then raise exception 'BAD_PEOPLE'; end if;
  elsif e.max_players is not null and (ppl < 1 or ppl > e.max_players) then ppl := least(greatest(ppl,1), e.max_players);
  end if;
  perform _validate_slot(e, st, pm, false);
  q := _quote(e.id, st, pm, ppl, stud);
  if not coalesce((q->>'price_set')::boolean, false) then raise exception 'PRICE_NOT_SET'; end if;
  if (q->>'is_night')::boolean and not coalesce((p->>'age_confirmed')::boolean, false) then raise exception 'AGE_REQUIRED'; end if;
  if (select count(*) from bookings where phone = ph and status = 'awaiting_payment') >= 3 then raise exception 'TOO_MANY_PENDING'; end if;
  if (select count(*) from bookings where source = 'site' and created_at > now() - interval '10 minutes') >= 40 then raise exception 'RATE_LIMIT'; end if;

  insert into customers(phone, name, bookings_count, last_booking_at) values (ph, nm, 1, now())
    on conflict (phone) do update set name = excluded.name, bookings_count = customers.bookings_count + 1, last_booking_at = now()
    returning id into cid;
  loop
    cd := 'CZ-' || _rand_code(6);
    exit when not exists (select 1 from bookings where code = cd);
  end loop;
  insert into bookings(code, access_token_hash, customer_id, customer_name, phone, equipment_id, equipment_name, starts_at,
                       paid_minutes, bonus_minutes, ends_at, people, is_student, is_night, quote, total, due_now, status,
                       payment_status, hold_until, source, comment)
  values (cd, _sha(tok), cid, nm, ph, e.id, e.name, st, pm, (q->>'bonus_minutes')::int, (q->>'ends_at')::timestamptz,
          ppl, stud, (q->>'is_night')::boolean, q, (q->>'total')::int, (q->>'due_now')::int, 'awaiting_payment',
          'unpaid', now() + make_interval(mins => hold), 'site', left(p->>'comment', 300))
  returning * into b;
  perform _occupy(b.id, null, e.id, b.starts_at, b.ends_at);
  perform _audit('client', b.id, 'created', jsonb_build_object('total', b.total));
  perform _notify('new_booking', b.id, format('Новая заявка %s: %s, %s, %s ₽, %s', b.code, b.equipment_name,
    to_char(_local(b.starts_at), 'DD.MM HH24:MI'), b.total, b.customer_name));
  return _booking_public(b) || jsonb_build_object('token', tok);
end $$;

create or replace function _client_booking(p jsonb) returns bookings
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  select * into b from bookings where code = upper(p->>'code') and access_token_hash = _sha(p->>'token');
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  return b;
end $$;

create or replace function get_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  perform _expire_holds();
  b := _client_booking(p);
  return _booking_public(b);
end $$;

create or replace function upload_receipt(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings; m text := p->>'mime'; d text := p->>'data';
begin
  perform _expire_holds();
  b := _client_booking(p);
  if b.status not in ('awaiting_payment','receipt_sent','pending_review') then raise exception 'BAD_STATUS'; end if;
  if m not in ('image/jpeg','image/png','image/webp','application/pdf') then raise exception 'BAD_FILE'; end if;
  if d is null or length(d) < 100 or length(d) > 7000000 then raise exception 'BAD_FILE'; end if;
  if (select count(*) from receipts where booking_id = b.id) >= 5 then raise exception 'TOO_MANY_FILES'; end if;
  insert into receipts(booking_id, mime, data, size_bytes) values (b.id, m, d, (length(d) * 3 / 4));
  update bookings set status = 'receipt_sent', payment_status = 'claimed', hold_until = null, updated_at = now()
    where id = b.id returning * into b;
  perform _audit('client', b.id, 'receipt_uploaded', '{}');
  perform _notify('receipt_sent', b.id, format('Чек загружен по заявке %s (%s ₽). Проверьте поступление денег.', b.code, b.due_now));
  return _booking_public(b);
end $$;

-- Клиент сообщает, что отправил чек в WhatsApp
create or replace function mark_paid(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  perform _expire_holds();
  b := _client_booking(p);
  if b.status = 'awaiting_payment' then
    update bookings set status = 'pending_review', payment_status = 'claimed', hold_until = null, updated_at = now()
      where id = b.id returning * into b;
    perform _audit('client', b.id, 'client_reported_payment', '{"channel":"whatsapp"}');
    perform _notify('receipt_sent', b.id, format('Клиент сообщил об оплате по заявке %s (%s ₽), чек — в WhatsApp.', b.code, b.due_now));
  elsif b.status not in ('receipt_sent','pending_review','payment_verified','confirmed') then
    raise exception 'BAD_STATUS';
  end if;
  return _booking_public(b);
end $$;

create or replace function cancel_my_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  b := _client_booking(p);
  if b.status not in ('awaiting_payment') then raise exception 'BAD_STATUS'; end if;
  update bookings set status = 'cancelled', hold_until = null, updated_at = now() where id = b.id returning * into b;
  update booking_slots set active = false where booking_id = b.id;
  perform _audit('client', b.id, 'cancelled', '{}');
  perform _notify('cancelled', b.id, format('Клиент отменил заявку %s.', b.code));
  return _booking_public(b);
end $$;

-- =====================================================================
-- АДМИНИСТРАТОР
-- =====================================================================

create or replace function _admin(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare s admin_sessions; idle int := coalesce((_setting('admin_idle_minutes')#>>'{}')::int, 30);
begin
  select * into s from admin_sessions where token_hash = _sha(p->>'token');
  if not found or s.expires_at < now() or s.last_seen < now() - make_interval(mins => idle) then
    raise exception 'AUTH_REQUIRED';
  end if;
  update admin_sessions set last_seen = now() where token_hash = s.token_hash;
  return s.admin_id;
end $$;

create or replace function admin_login(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a admin_users; tok text; fails int;
begin
  select count(*) into fails from login_attempts where not ok and at > now() - interval '15 minutes';
  if fails >= 8 then return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS'); end if;
  select * into a from admin_users where username = coalesce(nullif(p->>'username',''), 'admin');
  if not found or a.password_hash <> extensions.crypt(coalesce(p->>'password',''), a.password_hash) then
    insert into login_attempts(ok) values (false);
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'error', 'BAD_PASSWORD');
  end if;
  insert into login_attempts(ok) values (true);
  delete from admin_sessions where expires_at < now() or last_seen < now() - interval '1 day';
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into admin_sessions(token_hash, admin_id, expires_at) values (_sha(tok), a.id, now() + interval '12 hours');
  perform _audit('admin', null, 'login', '{}');
  return jsonb_build_object('ok', true, 'token', tok, 'idle_minutes', coalesce((_setting('admin_idle_minutes')#>>'{}')::int, 30),
                            'must_change_password', a.password_changed_at is null);
end $$;

create or replace function admin_logout(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  delete from admin_sessions where token_hash = _sha(p->>'token');
  return '{"ok":true}';
end $$;

create or replace function admin_ping(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin perform _admin(p); return jsonb_build_object('ok', true, 'unseen', (select count(*) from notifications where not seen)); end $$;

create or replace function admin_change_password(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare aid uuid := _admin(p); a admin_users; np text := coalesce(p->>'new_password','');
begin
  select * into a from admin_users where id = aid;
  if a.password_hash <> extensions.crypt(coalesce(p->>'old_password',''), a.password_hash) then raise exception 'BAD_PASSWORD'; end if;
  if length(np) < 10 then raise exception 'PASSWORD_TOO_SHORT'; end if;
  update admin_users set password_hash = extensions.crypt(np, extensions.gen_salt('bf', 10)), password_changed_at = now() where id = aid;
  delete from admin_sessions where admin_id = aid and token_hash <> _sha(p->>'token');
  perform _audit('admin', null, 'password_changed', '{}');
  return '{"ok":true}';
end $$;

create or replace function _admin_booking_row(b bookings) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select to_jsonb(b) - 'access_token_hash' || jsonb_build_object('status_ru', _status_ru(b.status),
    'receipts', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'mime', r.mime, 'size', r.size_bytes, 'created_at', r.created_at) order by r.created_at), '[]'::jsonb) from receipts r where r.booking_id = b.id))
$$;

create or replace function admin_dashboard(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare today date; d0 timestamptz; d1 timestamptz;
begin
  perform _admin(p); perform _expire_holds();
  today := _local(now())::date;
  d0 := today::timestamp at time zone _tz(); d1 := (today + 1)::timestamp at time zone _tz();
  return jsonb_build_object(
    'server_now', now(),
    'today_count', (select count(*) from bookings where starts_at >= d0 and starts_at < d1 and status not in ('rejected','cancelled','expired')),
    'pending_review', (select count(*) from bookings where status in ('receipt_sent','pending_review','payment_verified')),
    'awaiting_payment', (select count(*) from bookings where status = 'awaiting_payment'),
    'paid_count', (select count(*) from bookings where payment_status in ('verified','onsite') and status not in ('rejected','cancelled')),
    'clients', (select count(*) from customers),
    'revenue_day', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite') and starts_at >= d0 and starts_at < d1),
    'revenue_week', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite') and starts_at >= d0 - interval '6 days' and starts_at < d1),
    'revenue_month', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite') and _local(starts_at)::date >= date_trunc('month', today)::date and starts_at < d1 + interval '40 days' and _local(starts_at)::date < (date_trunc('month', today) + interval '1 month')::date),
    'equipment_now', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'status', e.status,
        'busy', exists(select 1 from booking_slots s where s.active and s.period @> now() and (s.resource = e.id or s.resource = 'room'))) order by e.sort), '[]'::jsonb)
        from equipment e where e.is_active and e.kind not in ('tv')),
    'upcoming', (select coalesce(jsonb_agg(_admin_booking_row(b) order by b.starts_at), '[]'::jsonb) from
        (select * from bookings where ends_at > now() and status not in ('rejected','cancelled','expired') order by starts_at limit 12) b),
    'review_list', (select coalesce(jsonb_agg(_admin_booking_row(b) order by b.created_at), '[]'::jsonb) from
        (select * from bookings where status in ('awaiting_payment','receipt_sent','pending_review','payment_verified') order by created_at limit 30) b),
    'chart', (select jsonb_agg(jsonb_build_object('date', d::date,
        'revenue', (select coalesce(sum(total),0) from bookings where status='confirmed' and payment_status in ('verified','onsite') and _local(starts_at)::date = d::date),
        'count', (select count(*) from bookings where status not in ('rejected','cancelled','expired') and _local(starts_at)::date = d::date)) order by d)
        from generate_series(today - 13, today, interval '1 day') d),
    'unseen', (select count(*) from notifications where not seen)
  );
end $$;

create or replace function admin_list_bookings(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare df date := nullif(p->>'date_from','')::date; dt date := nullif(p->>'date_to','')::date; q text := nullif(btrim(p->>'q'),'');
begin
  perform _admin(p); perform _expire_holds();
  return (select coalesce(jsonb_agg(_admin_booking_row(b) order by b.starts_at desc), '[]'::jsonb) from (
    select * from bookings
    where (df is null or _local(starts_at)::date >= df) and (dt is null or _local(starts_at)::date <= dt)
      and (nullif(p->>'equipment_id','') is null or equipment_id = p->>'equipment_id')
      and (nullif(p->>'status','') is null or status = p->>'status')
      and (q is null or code ilike '%'||q||'%' or customer_name ilike '%'||q||'%' or phone like '%'||regexp_replace(q,'\D','','g')||'%')
    order by starts_at desc limit 400) b);
end $$;

create or replace function admin_get_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  perform _admin(p);
  select * into b from bookings where id = (p->>'id')::uuid;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  return _admin_booking_row(b) || jsonb_build_object('history',
    (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'actor', actor, 'action', action, 'details', details) order by at), '[]'::jsonb)
     from audit_log where booking_id = b.id));
end $$;

create or replace function admin_get_receipt(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare r receipts;
begin
  perform _admin(p);
  select * into r from receipts where id = (p->>'id')::uuid;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform _audit('admin', r.booking_id, 'receipt_viewed', '{}');
  return jsonb_build_object('mime', r.mime, 'data', r.data);
end $$;

create or replace function admin_booking_action(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings; act text := p->>'action'; note text := left(p->>'note', 500);
begin
  perform _admin(p); perform _expire_holds();
  select * into b from bookings where id = (p->>'id')::uuid for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if act = 'verify_payment' or act = 'mark_onsite' then
    if not coalesce((p->>'attest')::boolean, false) then raise exception 'ATTEST_REQUIRED'; end if;
    if b.status in ('rejected','cancelled','expired') then raise exception 'BAD_STATUS'; end if;
    update bookings set payment_status = case when act = 'mark_onsite' then 'onsite' else 'verified' end,
      status = case when status = 'confirmed' then 'confirmed' else 'payment_verified' end, hold_until = null, updated_at = now()
      where id = b.id returning * into b;
    perform _notify('payment_verified', b.id, format('Оплата по заявке %s отмечена как %s.', b.code, case when act='mark_onsite' then 'оплата на месте' else 'проверенная' end));
  elsif act = 'confirm' then
    if b.status in ('rejected','cancelled','expired') then raise exception 'BAD_STATUS'; end if;
    if b.payment_status not in ('verified','onsite') then
      if coalesce((p->>'attest')::boolean, false) then
        b.payment_status := case when p->>'payment' = 'onsite' then 'onsite' else 'verified' end;
      else
        raise exception 'PAYMENT_NOT_VERIFIED';
      end if;
    end if;
    update bookings set status = 'confirmed', payment_status = b.payment_status, hold_until = null, confirmed_at = now(), updated_at = now()
      where id = b.id returning * into b;
    update booking_slots set active = true where booking_id = b.id;
    perform _notify('confirmed', b.id, format('Бронирование %s подтверждено.', b.code));
  elsif act = 'reject' or act = 'cancel' then
    if b.status in ('rejected','cancelled') then raise exception 'BAD_STATUS'; end if;
    update bookings set status = case when act = 'reject' then 'rejected' else 'cancelled' end, hold_until = null, updated_at = now()
      where id = b.id returning * into b;
    update booking_slots set active = false where booking_id = b.id;
    perform _notify(case when act='reject' then 'rejected' else 'cancelled' end, b.id,
      format('Заявка %s %s.', b.code, case when act='reject' then 'отклонена' else 'отменена' end));
  elsif act = 'extend_hold' then
    if b.status <> 'awaiting_payment' then raise exception 'BAD_STATUS'; end if;
    update bookings set hold_until = greatest(hold_until, now()) + make_interval(mins => coalesce((p->>'minutes')::int, 30)), updated_at = now()
      where id = b.id returning * into b;
  elsif act = 'to_review' then
    if b.status not in ('awaiting_payment','receipt_sent') then raise exception 'BAD_STATUS'; end if;
    update bookings set status = 'pending_review', hold_until = null, updated_at = now() where id = b.id returning * into b;
  else
    raise exception 'BAD_ACTION';
  end if;
  perform _audit('admin', b.id, act, jsonb_build_object('note', note, 'status', b.status, 'payment_status', b.payment_status));
  return _admin_booking_row(b);
end $$;

-- Перенос / изменение брони
create or replace function admin_update_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings; e equipment; st timestamptz; pm int; bonus int; en timestamptz; q jsonb; old jsonb; recalc boolean := coalesce((p->>'recalc')::boolean, false);
begin
  perform _admin(p);
  select * into b from bookings where id = (p->>'id')::uuid for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  old := jsonb_build_object('starts_at', b.starts_at, 'ends_at', b.ends_at, 'equipment_id', b.equipment_id, 'total', b.total);
  select * into e from equipment where id = coalesce(nullif(p->>'equipment_id',''), b.equipment_id);
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  st := coalesce((p->>'starts_at')::timestamptz, b.starts_at);
  pm := coalesce((p->>'paid_minutes')::int, b.paid_minutes);
  bonus := coalesce((p->>'bonus_minutes')::int, b.bonus_minutes);
  perform _validate_slot(e, st, pm, true);
  en := st + make_interval(mins => pm + bonus);
  if recalc then
    q := _quote(e.id, st, pm, coalesce((p->>'people')::int, b.people), b.is_student);
    if coalesce((q->>'price_set')::boolean,false) then
      b.total := (q->>'total')::int; b.due_now := (q->>'due_now')::int; b.quote := q;
    end if;
  end if;
  if p ? 'total' and nullif(p->>'total','') is not null then b.total := (p->>'total')::int; end if;
  delete from booking_slots where booking_id = b.id;
  update bookings set equipment_id = e.id, equipment_name = e.name, starts_at = st, paid_minutes = pm, bonus_minutes = bonus, ends_at = en,
    people = coalesce((p->>'people')::int, people), customer_name = coalesce(nullif(btrim(p->>'customer_name'),''), customer_name),
    phone = coalesce(_norm_phone(p->>'phone'), phone), total = b.total, due_now = least(b.due_now, b.total), quote = b.quote,
    admin_note = coalesce(p->>'admin_note', admin_note), updated_at = now()
    where id = b.id returning * into b;
  if b.status in ('awaiting_payment','receipt_sent','pending_review','payment_verified','confirmed') then
    perform _occupy(b.id, null, b.equipment_id, b.starts_at, b.ends_at);
  end if;
  perform _audit('admin', b.id, 'updated', jsonb_build_object('before', old, 'after',
    jsonb_build_object('starts_at', b.starts_at, 'ends_at', b.ends_at, 'equipment_id', b.equipment_id, 'total', b.total)));
  if (old->>'starts_at')::timestamptz <> b.starts_at or (old->>'equipment_id') <> b.equipment_id then
    perform _notify('rescheduled', b.id, format('Заявка %s перенесена: %s, %s.', b.code, b.equipment_name, to_char(_local(b.starts_at), 'DD.MM HH24:MI')));
  end if;
  return _admin_booking_row(b);
end $$;

create or replace function admin_create_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare e equipment; st timestamptz := (p->>'starts_at')::timestamptz; pm int := (p->>'paid_minutes')::int;
  ppl int := coalesce((p->>'people')::int, 1); nm text := btrim(coalesce(p->>'name','')); ph text := _norm_phone(p->>'phone');
  q jsonb; b bookings; cd text; cid uuid; tot int; pay text := coalesce(nullif(p->>'payment_status',''), 'unpaid'); stt text;
begin
  perform _admin(p);
  select * into e from equipment where id = p->>'equipment_id';
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  if length(nm) < 1 then raise exception 'BAD_NAME'; end if;
  if ph is null then raise exception 'BAD_PHONE'; end if;
  if pay not in ('unpaid','verified','onsite') then raise exception 'BAD_INPUT'; end if;
  perform _validate_slot(e, st, pm, true);
  q := _quote(e.id, st, pm, ppl, false);
  tot := coalesce(nullif(p->>'total','')::int, (q->>'total')::int, 0);
  stt := case when pay in ('verified','onsite') or coalesce((p->>'confirm')::boolean, true) then 'confirmed' else 'pending_review' end;
  if stt = 'confirmed' and pay = 'unpaid' then pay := 'onsite'; end if;
  insert into customers(phone, name, bookings_count, last_booking_at) values (ph, nm, 1, now())
    on conflict (phone) do update set bookings_count = customers.bookings_count + 1, last_booking_at = now() returning id into cid;
  loop cd := 'CZ-' || _rand_code(6); exit when not exists (select 1 from bookings where code = cd); end loop;
  insert into bookings(code, access_token_hash, customer_id, customer_name, phone, equipment_id, equipment_name, starts_at, paid_minutes,
    bonus_minutes, ends_at, people, is_night, quote, total, due_now, status, payment_status, source, admin_note, confirmed_at)
  values (cd, _sha(encode(extensions.gen_random_bytes(24),'hex')), cid, nm, ph, e.id, e.name, st, pm, coalesce((q->>'bonus_minutes')::int,0),
    st + make_interval(mins => pm + coalesce((q->>'bonus_minutes')::int,0)), ppl, coalesce((q->>'is_night')::boolean,false), coalesce(q,'{}'),
    tot, tot, stt, pay, 'admin', p->>'admin_note', case when stt='confirmed' then now() end)
  returning * into b;
  perform _occupy(b.id, null, e.id, b.starts_at, b.ends_at);
  perform _audit('admin', b.id, 'created_manually', jsonb_build_object('total', tot, 'payment_status', pay));
  return _admin_booking_row(b);
end $$;

create or replace function admin_calendar(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare d date := (p->>'date')::date; f timestamptz; t timestamptz;
begin
  perform _admin(p); perform _expire_holds();
  f := d::timestamp at time zone _tz(); t := (d + coalesce((p->>'days')::int, 1))::timestamp at time zone _tz();
  return jsonb_build_object(
    'equipment', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'status', status) order by sort), '[]'::jsonb) from equipment where is_active and kind <> 'tv'),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'equipment_id', b.equipment_id, 'name', b.customer_name,
        'starts_at', b.starts_at, 'ends_at', b.ends_at, 'status', b.status, 'status_ru', _status_ru(b.status), 'total', b.total,
        'payment_status', b.payment_status, 'people', b.people, 'equipment_name', b.equipment_name)), '[]'::jsonb)
        from bookings b where b.status not in ('rejected','cancelled','expired') and tstzrange(b.starts_at, b.ends_at) && tstzrange(f, t)),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'equipment_id', k.equipment_id, 'starts_at', k.starts_at, 'ends_at', k.ends_at, 'reason', k.reason)), '[]'::jsonb)
        from blocks k where tstzrange(k.starts_at, k.ends_at) && tstzrange(f, t)));
end $$;

create or replace function admin_block_create(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare k blocks; st timestamptz := (p->>'starts_at')::timestamptz; en timestamptz := (p->>'ends_at')::timestamptz;
begin
  perform _admin(p);
  if st is null or en is null or en <= st then raise exception 'BAD_INPUT'; end if;
  if not exists (select 1 from equipment where id = p->>'equipment_id') then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  insert into blocks(equipment_id, starts_at, ends_at, reason) values (p->>'equipment_id', st, en, coalesce(p->>'reason','')) returning * into k;
  perform _occupy(null, k.id, k.equipment_id, st, en);
  perform _audit('admin', null, 'block_created', to_jsonb(k));
  return to_jsonb(k);
end $$;

create or replace function admin_block_delete(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  delete from blocks where id = (p->>'id')::uuid;
  perform _audit('admin', null, 'block_deleted', jsonb_build_object('id', p->>'id'));
  return '{"ok":true}';
end $$;

-- ---------- Оборудование ----------
create or replace function admin_equipment_list(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  return (select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object(
      'bookings_count', (select count(*) from bookings b where b.equipment_id = e.id and b.status not in ('rejected','cancelled','expired')),
      'future_count', (select count(*) from bookings b where b.equipment_id = e.id and b.ends_at > now() and b.status not in ('rejected','cancelled','expired'))
    ) order by e.sort, e.id), '[]'::jsonb) from equipment e);
end $$;

create or replace function admin_equipment_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare it jsonb := p->'item'; e equipment; nid text;
begin
  perform _admin(p);
  nid := lower(regexp_replace(coalesce(it->>'id',''), '[^a-zA-Z0-9_-]', '', 'g'));
  if nid = '' then nid := 'eq' || lower(_rand_code(5)); end if;
  if coalesce(btrim(it->>'name'),'') = '' then raise exception 'BAD_NAME'; end if;
  if coalesce((it->>'is_new')::boolean, false) and exists (select 1 from equipment where id = nid) then raise exception 'ID_EXISTS'; end if;
  if coalesce(it->>'kind','other') = 'room' and nid <> 'room' then raise exception 'BAD_INPUT'; end if;
  insert into equipment(id, name, kind, description, features, price_per_hour, max_players, bookable, is_active, status, status_note,
                        photo_url, map_x, map_y, map_rot, link_to, sort, map_scale, model, label, schedule)
  values (nid, btrim(it->>'name'), coalesce(it->>'kind','other'), coalesce(it->>'description',''),
          coalesce(array(select jsonb_array_elements_text(coalesce(it->'features','[]'))), '{}'),
          nullif(it->>'price_per_hour','')::int, nullif(it->>'max_players','')::int, coalesce((it->>'bookable')::boolean, true),
          coalesce((it->>'is_active')::boolean, true), coalesce(it->>'status','ok'), it->>'status_note', nullif(it->>'photo_url',''),
          coalesce(nullif(it->>'map_x','')::numeric, 500), coalesce(nullif(it->>'map_y','')::numeric, 350), coalesce(nullif(it->>'map_rot','')::numeric, 0),
          nullif(it->>'link_to',''), coalesce(nullif(it->>'sort','')::int, 100),
          least(2.5, greatest(0.4, coalesce(nullif(it->>'map_scale','')::numeric, 1))), nullif(it->>'model',''), nullif(btrim(it->>'label'),''),
          case when jsonb_typeof(it->'schedule') = 'object' then it->'schedule' else null end)
  on conflict (id) do update set name = excluded.name, kind = case when equipment.kind = 'room' then 'room' else excluded.kind end,
    description = excluded.description, features = excluded.features,
    price_per_hour = excluded.price_per_hour, max_players = excluded.max_players, bookable = excluded.bookable, is_active = excluded.is_active,
    status = excluded.status, status_note = excluded.status_note, photo_url = excluded.photo_url, map_x = excluded.map_x, map_y = excluded.map_y,
    map_rot = excluded.map_rot, link_to = excluded.link_to, sort = excluded.sort, map_scale = excluded.map_scale,
    model = excluded.model, label = excluded.label, schedule = excluded.schedule, updated_at = now()
  returning * into e;
  perform _audit('admin', null, 'equipment_saved', jsonb_build_object('id', e.id, 'price', e.price_per_hour, 'status', e.status));
  return to_jsonb(e);
end $$;

create or replace function admin_equipment_delete(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare eid text := p->>'id';
begin
  perform _admin(p);
  if eid = 'room' then raise exception 'CANNOT_DELETE_ROOM'; end if;
  if exists (select 1 from bookings where equipment_id = eid and ends_at > now() and status not in ('rejected','cancelled','expired')) then
    raise exception 'HAS_FUTURE_BOOKINGS';
  end if;
  if exists (select 1 from bookings where equipment_id = eid) then
    update equipment set is_active = false, bookable = false, updated_at = now() where id = eid;
    perform _audit('admin', null, 'equipment_hidden', jsonb_build_object('id', eid));
    return '{"ok":true,"hidden":true}';
  end if;
  delete from equipment where id = eid;
  perform _audit('admin', null, 'equipment_deleted', jsonb_build_object('id', eid));
  return '{"ok":true}';
end $$;

-- Быстрое отключение / включение
create or replace function admin_equipment_status(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare e equipment; st text := coalesce(p->>'status','ok');
begin
  perform _admin(p);
  if st not in ('ok','maintenance','disabled') then raise exception 'BAD_INPUT'; end if;
  update equipment set status = st, status_note = case when st = 'ok' then null else coalesce(nullif(p->>'note',''), status_note) end,
    is_active = case when st = 'ok' then true else is_active end, updated_at = now()
  where id = p->>'id' returning * into e;
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  perform _audit('admin', null, case when st = 'ok' then 'equipment_enabled' else 'equipment_disabled' end, jsonb_build_object('id', e.id, 'note', e.status_note));
  return to_jsonb(e);
end $$;

create or replace function admin_equipment_photo(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare eid text := p->>'id';
begin
  perform _admin(p);
  if nullif(p->>'data','') is null then
    delete from equipment_photos where equipment_id = eid;
    update equipment set has_photo = false where id = eid;
  else
    if p->>'mime' not in ('image/jpeg','image/png','image/webp') or length(p->>'data') > 4000000 then raise exception 'BAD_FILE'; end if;
    insert into equipment_photos(equipment_id, mime, data) values (eid, p->>'mime', p->>'data')
      on conflict (equipment_id) do update set mime = excluded.mime, data = excluded.data, updated_at = now();
    update equipment set has_photo = true where id = eid;
  end if;
  return '{"ok":true}';
end $$;

-- ---------- Настройки, тарифы, акции ----------
create or replace function admin_settings_get(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  return jsonb_build_object(
    'settings', (select jsonb_object_agg(key, case when key = 'telegram' then value - 'bot_token' || jsonb_build_object('has_token', coalesce(value->>'bot_token','') <> '') else value end) from settings),
    'tariffs', (select coalesce(jsonb_agg(to_jsonb(t) order by t.priority desc, t.created_at), '[]'::jsonb) from tariff_rules t),
    'promotions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.created_at), '[]'::jsonb) from promotions x));
end $$;

create or replace function admin_settings_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare k text := p->>'key'; v jsonb := p->'value';
begin
  perform _admin(p);
  if k not in ('timezone','hold_minutes','durations','custom_duration','booking_horizon_days','work_hours','room','student_discount_percent','night','payment','contacts','admin_idle_minutes','telegram') then
    raise exception 'BAD_KEY';
  end if;
  if k = 'telegram' and coalesce(v->>'bot_token','') = '' then
    v := v || jsonb_build_object('bot_token', coalesce((select value->>'bot_token' from settings where key='telegram'), ''));
  end if;
  if k = 'telegram' then v := v - 'has_token'; end if;
  insert into settings(key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
  perform _audit('admin', null, 'settings_saved', jsonb_build_object('key', k));
  return '{"ok":true}';
end $$;

create or replace function admin_tariff_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare it jsonb := p->'item'; r tariff_rules;
begin
  perform _admin(p);
  if nullif(it->>'id','') is null then
    insert into tariff_rules(name, kind, applies_to, days, dates, time_from, time_to, mode, value, priority, is_active)
    values (it->>'name', coalesce(it->>'kind','custom'), coalesce(it->>'applies_to','all'),
      nullif(array(select jsonb_array_elements_text(coalesce(it->'days','[]'))::int), '{}'),
      nullif(array(select jsonb_array_elements_text(coalesce(it->'dates','[]'))::date), '{}'),
      nullif(it->>'time_from','')::time, nullif(it->>'time_to','')::time, coalesce(it->>'mode','price'),
      (it->>'value')::numeric, coalesce(nullif(it->>'priority','')::int, 0), coalesce((it->>'is_active')::boolean, true))
    returning * into r;
  else
    update tariff_rules set name = it->>'name', kind = coalesce(it->>'kind','custom'), applies_to = coalesce(it->>'applies_to','all'),
      days = nullif(array(select jsonb_array_elements_text(coalesce(it->'days','[]'))::int), '{}'),
      dates = nullif(array(select jsonb_array_elements_text(coalesce(it->'dates','[]'))::date), '{}'),
      time_from = nullif(it->>'time_from','')::time, time_to = nullif(it->>'time_to','')::time, mode = coalesce(it->>'mode','price'),
      value = (it->>'value')::numeric, priority = coalesce(nullif(it->>'priority','')::int, 0), is_active = coalesce((it->>'is_active')::boolean, true)
    where id = (it->>'id')::uuid returning * into r;
  end if;
  perform _audit('admin', null, 'tariff_saved', to_jsonb(r));
  return to_jsonb(r);
end $$;

create or replace function admin_tariff_delete(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin perform _admin(p); delete from tariff_rules where id = (p->>'id')::uuid; return '{"ok":true}'; end $$;

create or replace function admin_promo_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare it jsonb := p->'item'; r promotions;
begin
  perform _admin(p);
  if coalesce(btrim(it->>'title'),'') = '' then raise exception 'BAD_NAME'; end if;
  if nullif(it->>'id','') is null then
    insert into promotions(title, description, type, config, is_active, starts_on, ends_on, sort)
    values (it->>'title', coalesce(it->>'description',''), coalesce(it->>'type','info'), coalesce(it->'config','{}'),
      coalesce((it->>'is_active')::boolean, true), nullif(it->>'starts_on','')::date, nullif(it->>'ends_on','')::date, coalesce(nullif(it->>'sort','')::int,100))
    returning * into r;
  else
    update promotions set title = it->>'title', description = coalesce(it->>'description',''), type = coalesce(it->>'type','info'),
      config = coalesce(it->'config','{}'), is_active = coalesce((it->>'is_active')::boolean, true),
      starts_on = nullif(it->>'starts_on','')::date, ends_on = nullif(it->>'ends_on','')::date, sort = coalesce(nullif(it->>'sort','')::int,100)
    where id = (it->>'id')::uuid returning * into r;
  end if;
  perform _audit('admin', null, 'promo_saved', jsonb_build_object('id', r.id, 'title', r.title, 'active', r.is_active));
  return to_jsonb(r);
end $$;

create or replace function admin_promo_delete(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin perform _admin(p); delete from promotions where id = (p->>'id')::uuid; return '{"ok":true}'; end $$;

create or replace function admin_notifications(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare res jsonb;
begin
  perform _admin(p);
  select coalesce(jsonb_agg(to_jsonb(n) order by n.at desc), '[]'::jsonb) into res from (select * from notifications order by at desc limit 100) n;
  if coalesce((p->>'mark_seen')::boolean, false) then update notifications set seen = true where not seen; end if;
  return res;
end $$;

create or replace function admin_audit(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc), '[]'::jsonb) from (select * from audit_log order by at desc limit 200) a);
end $$;

-- Резервная копия (без чеков и паролей)
create or replace function admin_export(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  perform _audit('admin', null, 'export', '{}');
  return jsonb_build_object('exported_at', now(),
    'equipment', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from equipment x),
    'bookings', (select coalesce(jsonb_agg(to_jsonb(x) - 'access_token_hash'), '[]') from bookings x),
    'customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from customers x),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from blocks x),
    'tariff_rules', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tariff_rules x),
    'promotions', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from promotions x),
    'settings', (select jsonb_object_agg(key, case when key='telegram' then value - 'bot_token' else value end) from settings),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select * from audit_log order by at desc limit 5000) x));
end $$;

-- =====================================================================
-- Права: внутренние функции недоступны снаружи, RPC — доступны
-- =====================================================================
do $$
declare f record;
  api text[] := array['get_public_data','get_equipment_photo','get_availability','get_occupancy','quote_booking','create_booking',
    'get_booking','upload_receipt','mark_paid','cancel_my_booking','admin_login','admin_logout','admin_ping','admin_change_password',
    'admin_dashboard','admin_list_bookings','admin_get_booking','admin_get_receipt','admin_booking_action','admin_update_booking',
    'admin_create_booking','admin_calendar','admin_block_create','admin_block_delete','admin_equipment_list','admin_equipment_save',
    'admin_equipment_delete','admin_equipment_photo','admin_equipment_status','admin_settings_get','admin_settings_save','admin_tariff_save','admin_tariff_delete',
    'admin_promo_save','admin_promo_delete','admin_notifications','admin_audit','admin_export'];
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname='anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    if f.proname = any(api) then
      if exists (select 1 from pg_roles where rolname='anon') then execute format('grant execute on function %s to anon', f.sig); end if;
      if exists (select 1 from pg_roles where rolname='authenticated') then execute format('grant execute on function %s to authenticated', f.sig); end if;
    end if;
  end loop;
end $$;
