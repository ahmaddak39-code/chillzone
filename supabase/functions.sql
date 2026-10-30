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
    when 'awaiting_payment' then 'Ожидает отправки в WhatsApp'
    when 'receipt_sent' then 'Ожидает проверки оплаты'
    when 'pending_review' then 'Ожидает подтверждения'
    when 'payment_verified' then 'Оплата проверена'
    when 'confirmed' then 'Подтверждено'
    when 'rejected' then 'Отклонено'
    when 'cancelled' then 'Отменено'
    when 'expired' then 'Истекло время оплаты'
    else s end $$;


create or replace function _reserved(acc uuid) returns int
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select coalesce(sum(total), 0)::int from bookings
  where account_id = acc and payment_status = 'balance_pending' and status in ('awaiting_payment','pending_review','receipt_sent','payment_verified') $$;

create or replace function _client_id(n bigint) returns text language sql immutable as $$ select 'CZ-' || lpad(n::text, 6, '0') $$;

-- Краткая сводка заявки для уведомлений: имя, оборудование, дата, время, сумма, статус
create or replace function _bk_line(b bookings) returns text
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select format(E'№ %s\nКлиент: %s, +%s\nОборудование: %s%s\nДата: %s\nВремя: %s–%s\nСумма: %s ₽%s\nСтатус: %s',
    b.code, b.customer_name, b.phone, b.equipment_name,
    case when b.equipment_id = 'room' then format(' (%s чел.)', b.people) else '' end,
    to_char(_local(b.starts_at), 'DD.MM.YYYY'), to_char(_local(b.starts_at), 'HH24:MI'), to_char(_local(b.ends_at), 'HH24:MI'),
    b.total, case when b.due_now <> b.total then format(' (предоплата %s ₽)', b.due_now) else '' end,
    _status_ru(b.status)) $$;

-- Сумма возврата при отмене клиентом по правилам из настроек
create or replace function _refund_amount(b bookings) returns int
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare s jsonb := coalesce(_setting('balance'), '{}'); full_h numeric := coalesce((s->>'refund_full_hours')::numeric, 2); late int := coalesce((s->>'refund_late_percent')::int, 0); paid int;
begin
  select -coalesce(sum(amount),0) into paid from balance_ops where booking_id = b.id and kind = 'payment';
  if paid <= 0 then return 0; end if;
  if b.starts_at - now() >= make_interval(secs => full_h * 3600) then return paid; end if;
  return floor(paid * late / 100.0)::int;
end $$;

-- Возврат за бронь на баланс (один раз на бронь)
create or replace function _refund_booking(b bookings, amt int, why text, actor text) returns int
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  if b.account_id is null or amt <= 0 then return 0; end if;
  if exists (select 1 from balance_ops where booking_id = b.id and kind = 'refund') then return 0; end if;
  perform _balance_move(b.account_id, amt, 'refund', format('Возврат за бронь %s (%s)', b.code, why), actor, b.id, null);
  update bookings set refunded = amt where id = b.id;
  return amt;
end $$;



-- Уведомление: всегда в админ-панели; в Telegram — только если интеграция включена и pg_net подключён.
-- Отправка в WhatsApp через CallMeBot (бесплатный бот, сообщения приходят на номер владельца)
create or replace function _wa_send(msg text) returns text
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare w jsonb := _setting('whatsapp_bot');
begin
  if not coalesce((w->>'enabled')::boolean, false) or coalesce(w->>'apikey','') = '' or coalesce(w->>'phone','') = '' then return 'off'; end if;
  if to_regproc('net.http_get') is null then return 'wa_not_available'; end if;
  begin
    execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 10000)'
      using 'https://api.callmebot.com/whatsapp.php',
            jsonb_build_object('phone', '+' || regexp_replace(w->>'phone', '\D', '', 'g'), 'text', 'CHILL ZONE' || E'\n' || msg, 'apikey', w->>'apikey');
    return 'wa_queued';
  exception when others then return 'wa_error';
  end;
end $$;

create or replace function _notify(ev text, bid uuid, msg text) returns void
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare tg jsonb := _setting('telegram'); st text := 'in_app'; ws text;
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
  -- WhatsApp: только события от клиентов (свои действия админ и так видит)
  if ev in ('new_booking','new_room_booking','receipt_sent','pending_review','cancelled','topup_new','topup_receipt') then
    ws := _wa_send(msg);
    if ws <> 'off' then st := case when st = 'in_app' then ws else st || ',' || ws end; end if;
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

-- ---------- Ночной пакет (только вся комната) ----------
create or replace function _night_window(d date) returns tstzrange
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select tstzrange(st, case when en <= st then en + interval '1 day' else en end)
  from (select ((d + coalesce((_setting('night_package')->>'start'),'00:00')::time)::timestamp at time zone _tz()) as st,
               ((d + coalesce((_setting('night_package')->>'end'),'07:00')::time)::timestamp at time zone _tz()) as en) x $$;

create or replace function _night_quote(d date, ppl int) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare np jsonb := _setting('night_package'); w tstzrange; price int; mins int;
begin
  if not coalesce((np->>'enabled')::boolean, false) then raise exception 'NIGHT_DISABLED'; end if;
  w := _night_window(d); price := coalesce((np->>'price')::int, 5000);
  mins := (extract(epoch from upper(w) - lower(w)) / 60)::int;
  return jsonb_build_object('price_set', true, 'night_package', true, 'is_night', true, 'base_rate', price,
    'lines', jsonb_build_array(jsonb_build_object('label', format('Ночной пакет %s–%s', np->>'start', np->>'end'), 'rate', price, 'minutes', mins, 'fixed', true)),
    'base_sum', price, 'extra_people', 0, 'extra_person_price', 0, 'extra_sum', 0, 'discount_percent', 0, 'discount_label', null, 'discount_sum', 0,
    'bonus_minutes', 0, 'bonus_label', null, 'min_age', coalesce((np->>'min_age')::int, 18), 'people', ppl,
    'paid_minutes', mins, 'starts_at', lower(w), 'ends_at', upper(w), 'total', price, 'due_now', price);
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
    'payment', _setting('payment') - 'whatsapp', 'notify', _setting('notify'), 'refunded', b.refunded,
    'refund_preview', null::int, 'phone', b.phone,
    'can_cancel', b.status = 'awaiting_payment' or (b.payment_status = 'balance_pending' and b.status = 'pending_review'))
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
        'student_discount_percent', _setting('student_discount_percent'), 'night', _setting('night'), 'night_package', _setting('night_package'), 'bonus', _setting('bonus'),
        'payment', _setting('payment') - 'whatsapp', 'contacts', _setting('contacts'), 'notify', _setting('notify'),
        'balance', _setting('balance')),
    'features', jsonb_build_object('balance', coalesce((_setting('balance')->>'enabled')::boolean, false),
                                   'account_required', coalesce((_setting('balance')->>'require_account')::boolean, false)),
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
  if coalesce((p->>'night_package')::boolean, false) then
    if p->>'equipment_id' <> 'room' then raise exception 'NIGHT_ROOM_ONLY'; end if;
    return _night_quote((p->>'date')::date, coalesce((p->>'people')::int, 1));
  end if;
  return _quote(p->>'equipment_id', (p->>'starts_at')::timestamptz, (p->>'paid_minutes')::int,
                coalesce((p->>'people')::int, 1), coalesce((p->>'is_student')::boolean, false));
end $$;

create or replace function create_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare e equipment; st timestamptz := (p->>'starts_at')::timestamptz; pm int := (p->>'paid_minutes')::int;
  ppl int := coalesce((p->>'people')::int, 1); stud boolean := coalesce((p->>'is_student')::boolean, false);
  nm text := btrim(coalesce(p->>'name','')); ph text := _norm_phone(p->>'phone'); q jsonb; b bookings;
  tok text := encode(extensions.gen_random_bytes(24), 'hex'); cd text; cid uuid; hold int := coalesce((_setting('hold_minutes')#>>'{}')::int, 15);
  room jsonb := _setting('room'); pay_bal boolean := coalesce(p->>'pay_method','transfer') = 'balance'; acc client_accounts; has_acc boolean := false;
  npk boolean := coalesce((p->>'night_package')::boolean, false); horizon int := coalesce((_setting('booking_horizon_days')#>>'{}')::int, 30);
begin
  perform _expire_holds();
  -- клиент вошёл в аккаунт: бронь привязывается к нему; при оплате с баланса имя и телефон берутся из аккаунта
  if nullif(p->>'ctoken','') is not null then acc := _client(p); has_acc := true; nm := acc.name; ph := acc.phone;
  elsif pay_bal then raise exception 'CLIENT_AUTH_REQUIRED';
  elsif coalesce((_setting('balance')->>'require_account')::boolean, false) then raise exception 'ACCOUNT_REQUIRED';   -- бронь только через личный кабинет
  end if;
  if pay_bal and acc.frozen then raise exception 'ACCOUNT_FROZEN'; end if;
  select * into e from equipment where id = p->>'equipment_id';
  if not found then raise exception 'EQUIPMENT_NOT_FOUND'; end if;
  if length(nm) < 2 or length(nm) > 60 then raise exception 'BAD_NAME'; end if;
  if ph is null then raise exception 'BAD_PHONE'; end if;
  if e.kind = 'room' then
    if ppl < 1 or ppl > coalesce((room->>'max_people')::int, 20) then raise exception 'BAD_PEOPLE'; end if;
  elsif e.max_players is not null and (ppl < 1 or ppl > e.max_players) then ppl := least(greatest(ppl,1), e.max_players);
  end if;
  if npk then
    -- ночной пакет: только вся комната, фиксированное время и цена, строго 18+
    if e.kind <> 'room' then raise exception 'NIGHT_ROOM_ONLY'; end if;
    if not e.bookable or not e.is_active or e.status <> 'ok' then raise exception 'EQUIPMENT_UNAVAILABLE'; end if;
    q := _night_quote((p->>'date')::date, ppl);
    st := (q->>'starts_at')::timestamptz; pm := (q->>'paid_minutes')::int;
    if st < now() - interval '5 minutes' then raise exception 'TIME_IN_PAST'; end if;
    if st > now() + make_interval(days => horizon) then raise exception 'TOO_FAR'; end if;
    if not coalesce((p->>'age_confirmed')::boolean, false) then raise exception 'AGE_REQUIRED'; end if;
  else
    perform _validate_slot(e, st, pm, false);
    q := _quote(e.id, st, pm, ppl, stud);
  end if;
  if not coalesce((q->>'price_set')::boolean, false) then raise exception 'PRICE_NOT_SET'; end if;
  if (q->>'is_night')::boolean and not coalesce((p->>'age_confirmed')::boolean, false) then raise exception 'AGE_REQUIRED'; end if;
  -- доступно = баланс минус суммы заявок с оплатой с баланса, ещё не подтверждённых админом
  if pay_bal and acc.balance - _reserved(acc.id) < (q->>'total')::int then raise exception 'INSUFFICIENT_FUNDS'; end if;
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
                       payment_status, hold_until, source, comment, account_id, confirmed_at)
  values (cd, _sha(tok), cid, nm, ph, e.id, e.name, st, pm, (q->>'bonus_minutes')::int, (q->>'ends_at')::timestamptz,
          ppl, stud, (q->>'is_night')::boolean, q, (q->>'total')::int,
          case when pay_bal then (q->>'total')::int else (q->>'due_now')::int end,
          'awaiting_payment',                                   -- никогда не подтверждается автоматически
          case when pay_bal then 'balance_pending' else 'unpaid' end,
          now() + make_interval(mins => hold), 'site', left(p->>'comment', 300),
          case when has_acc then acc.id end, null)
  returning * into b;
  perform _occupy(b.id, null, e.id, b.starts_at, b.ends_at);
  perform _audit('client', b.id, 'created', jsonb_build_object('total', b.total, 'pay_method', case when pay_bal then 'balance' else 'transfer' end));
  perform _notify(case when b.equipment_id = 'room' then 'new_room_booking' else 'new_booking' end, b.id,
    case when b.equipment_id = 'room' then E'🌐 Новая заявка на аренду ВСЕЙ КОМНАТЫ
' else E'🆕 Новая заявка на бронирование
' end || _bk_line(b) || case when pay_bal then format(E'\n💳 Оплата с личного баланса: %s ₽ спишутся только после вашего подтверждения', b.total) else E'\n💸 Оплата переводом' end);
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
  if exists (select 1 from receipts where file_hash = encode(extensions.digest(decode(d, 'base64'), 'sha256'), 'hex'))
     or exists (select 1 from topup_receipts where file_hash = encode(extensions.digest(decode(d, 'base64'), 'sha256'), 'hex')) then raise exception 'RECEIPT_USED'; end if;
  insert into receipts(booking_id, mime, data, size_bytes, file_hash) values (b.id, m, d, (length(d) * 3 / 4), encode(extensions.digest(decode(d, 'base64'), 'sha256'), 'hex'));
  update bookings set status = 'receipt_sent', payment_status = 'claimed', hold_until = null, updated_at = now()
    where id = b.id returning * into b;
  perform _audit('client', b.id, 'receipt_uploaded', '{}');
  perform _notify('receipt_sent', b.id, E'📎 Клиент загрузил чек об оплате — заявка ожидает проверки\n' || _bk_line(b) || E'\nПроверьте поступление денег в банке.');
  return _booking_public(b);
end $$;

-- Клиент сообщает, что отправил чек в WhatsApp
create or replace function mark_paid(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  perform _expire_holds();
  b := _client_booking(p);
  if b.status = 'awaiting_payment' and b.payment_status = 'balance_pending' then
    update bookings set status = 'pending_review', hold_until = null, updated_at = now() where id = b.id returning * into b;
    perform _audit('client', b.id, 'client_sent_whatsapp', '{"channel":"whatsapp","pay":"balance"}');
    perform _notify('pending_review', b.id, E'📨 Клиент сообщил, что отправил заявку в WhatsApp (оплата с баланса) — ожидает подтверждения\n' || _bk_line(b));
  elsif b.status = 'awaiting_payment' then
    update bookings set status = 'receipt_sent', payment_status = 'claimed', hold_until = null, updated_at = now()
      where id = b.id returning * into b;
    perform _audit('client', b.id, 'client_reported_payment', '{"channel":"whatsapp"}');
    perform _notify('pending_review', b.id, E'💳 Клиент сообщил, что оплатил и отправил заявку/чек в WhatsApp — ожидает проверки оплаты\n' || _bk_line(b) || E'\nПроверьте поступление денег в банке.');
  elsif b.status not in ('receipt_sent','pending_review','payment_verified','confirmed') then
    raise exception 'BAD_STATUS';
  end if;
  return _booking_public(b);
end $$;

create or replace function _cancel_by_client(b bookings) returns bookings
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare r int := 0;
begin
  select * into b from bookings where id = b.id for update;   -- блокировка: повторная отмена не пройдёт
  if b.status = 'awaiting_payment' or (b.payment_status = 'balance_pending' and b.status = 'pending_review') then null;
  -- подтверждённую бронь клиент отменить не может (без возврата) — только администратор
  else raise exception 'BAD_STATUS'; end if;
  update bookings set status = 'cancelled', hold_until = null, updated_at = now() where id = b.id returning * into b;
  update booking_slots set active = false where booking_id = b.id;
  if r > 0 then perform _refund_booking(b, r, 'отмена клиентом', 'client'); select * into b from bookings where id = b.id; end if;
  perform _audit('client', b.id, 'cancelled', jsonb_build_object('refund', r));
  perform _notify('cancelled', b.id, E'❌ Клиент отменил бронирование\n' || _bk_line(b) || case when b.payment_status = 'balance' then format(E'\nВозврат на баланс: %s ₽', r) else '' end);
  return b;
end $$;

create or replace function cancel_my_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare b bookings;
begin
  b := _client_booking(p);
  b := _cancel_by_client(b);
  return _booking_public(b);
end $$;

create or replace function client_cancel_booking(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; b bookings;
begin
  a := _client(p);
  select * into b from bookings where code = upper(p->>'code') and account_id = a.id;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  b := _cancel_by_client(b);
  select * into a from client_accounts where id = a.id;
  return _client_public(a);
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
  perform set_config('cz.admin_id', s.admin_id::text, true);
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
    'client_id', (select _client_id(a.client_no) from client_accounts a where a.id = b.account_id),
    'account_balance', (select a.balance from client_accounts a where a.id = b.account_id),
    'account_available', (select a.balance - _reserved(a.id) from client_accounts a where a.id = b.account_id),
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
    'paid_count', (select count(*) from bookings where payment_status in ('verified','onsite','balance') and status not in ('rejected','cancelled')),
    'clients', (select count(*) from customers),
    'revenue_day', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite','balance') and starts_at >= d0 and starts_at < d1),
    'revenue_week', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite','balance') and starts_at >= d0 - interval '6 days' and starts_at < d1),
    'revenue_month', (select coalesce(sum(total),0) from bookings where status = 'confirmed' and payment_status in ('verified','onsite','balance') and _local(starts_at)::date >= date_trunc('month', today)::date and starts_at < d1 + interval '40 days' and _local(starts_at)::date < (date_trunc('month', today) + interval '1 month')::date),
    'equipment_now', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'status', e.status,
        'busy', exists(select 1 from booking_slots s where s.active and s.period @> now() and (s.resource = e.id or s.resource = 'room'))) order by e.sort), '[]'::jsonb)
        from equipment e where e.is_active and e.kind not in ('tv')),
    'upcoming', (select coalesce(jsonb_agg(_admin_booking_row(b) order by b.starts_at), '[]'::jsonb) from
        (select * from bookings where ends_at > now() and status not in ('rejected','cancelled','expired') order by starts_at limit 12) b),
    'review_list', (select coalesce(jsonb_agg(_admin_booking_row(b) order by b.created_at), '[]'::jsonb) from
        (select * from bookings where status in ('awaiting_payment','receipt_sent','pending_review','payment_verified') order by created_at limit 30) b),
    'chart', (select jsonb_agg(jsonb_build_object('date', d::date,
        'revenue', (select coalesce(sum(total),0) from bookings where status='confirmed' and payment_status in ('verified','onsite','balance') and _local(starts_at)::date = d::date),
        'count', (select count(*) from bookings where status not in ('rejected','cancelled','expired') and _local(starts_at)::date = d::date)) order by d)
        from generate_series(today - 13, today, interval '1 day') d),
    'unseen', (select count(*) from notifications where not seen),
    'topups_pending', (select count(*) from topups where status = 'receipt_sent')
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
      and (jsonb_typeof(p->'statuses') is distinct from 'array' or status in (select jsonb_array_elements_text(p->'statuses')))
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
    perform _notify('payment_verified', b.id, case when act='mark_onsite' then E'🏪 Оплата на месте отмечена — бронь ожидает подтверждения
' else E'💳 Оплата проверена — бронь ожидает подтверждения
' end || _bk_line(b));
  elsif act = 'confirm' then
    if b.status in ('rejected','cancelled','expired','confirmed') then raise exception 'BAD_STATUS'; end if;
    if b.payment_status = 'balance_pending' then
      if b.account_id is null then raise exception 'ACCOUNT_NOT_FOUND'; end if;
      perform set_config('cz.op_method', 'balance', true);
      -- атомарно: блокировка счёта, проверка остатка, одна запись на бронь (уникальный индекс)
      perform _balance_move(b.account_id, -b.total, 'payment',
        format('Оплата брони %s: %s, %s', b.code, b.equipment_name, to_char(_local(b.starts_at), 'DD.MM HH24:MI')), 'admin', b.id, null);
      b.payment_status := 'balance';
    elsif b.payment_status not in ('verified','onsite') then
      if coalesce((p->>'attest')::boolean, false) then
        b.payment_status := case when p->>'payment' = 'onsite' then 'onsite' else 'verified' end;
      else
        raise exception 'PAYMENT_NOT_VERIFIED';
      end if;
    end if;
    update bookings set status = 'confirmed', payment_status = b.payment_status, hold_until = null, confirmed_at = now(), updated_at = now()
      where id = b.id returning * into b;
    begin
      update booking_slots set active = true where booking_id = b.id;
    exception when exclusion_violation then raise exception 'SLOT_TAKEN';
    end;
    perform _notify('confirmed', b.id, E'✅ Бронь подтверждена\n' || _bk_line(b));
  elsif act = 'reject' or act = 'cancel' then
    if b.status in ('rejected','cancelled') then raise exception 'BAD_STATUS'; end if;
    update bookings set status = case when act = 'reject' then 'rejected' else 'cancelled' end, hold_until = null, updated_at = now()
      where id = b.id returning * into b;
    update booking_slots set active = false where booking_id = b.id;
    if b.payment_status = 'balance' then
      perform _refund_booking(b, (select -coalesce(sum(amount),0) from balance_ops where booking_id = b.id and kind = 'payment')::int,
        case when act='reject' then 'отклонено администратором' else 'отменено администратором' end, 'admin');
      select * into b from bookings where id = b.id;
    end if;
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
    'settings', (select jsonb_object_agg(key, case when key = 'telegram' then value - 'bot_token' || jsonb_build_object('has_token', coalesce(value->>'bot_token','') <> '')
                                                   when key = 'whatsapp_bot' then value - 'apikey' || jsonb_build_object('has_key', coalesce(value->>'apikey','') <> '') else value end) from settings),
    'tariffs', (select coalesce(jsonb_agg(to_jsonb(t) order by t.priority desc, t.created_at), '[]'::jsonb) from tariff_rules t),
    'promotions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.created_at), '[]'::jsonb) from promotions x));
end $$;

create or replace function admin_settings_save(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare k text := p->>'key'; v jsonb := p->'value';
begin
  perform _admin(p);
  if k not in ('timezone','hold_minutes','durations','custom_duration','booking_horizon_days','work_hours','room','student_discount_percent','night','payment','contacts','admin_idle_minutes','telegram','notify','balance','whatsapp_bot','night_package','bonus') then
    raise exception 'BAD_KEY';
  end if;
  if k = 'telegram' and coalesce(v->>'bot_token','') = '' then
    v := v || jsonb_build_object('bot_token', coalesce((select value->>'bot_token' from settings where key='telegram'), ''));
  end if;
  if k = 'telegram' then v := v - 'has_token'; end if;
  if k = 'bonus' then v := _bonus_validate(v); end if;
  if k = 'night_package' then
    if (v->>'start') !~ '^\d{2}:\d{2}$' or (v->>'end') !~ '^\d{2}:\d{2}$' or (v->>'start') = (v->>'end') then raise exception 'BAD_INPUT'; end if;
    if coalesce((v->>'price')::numeric, -1) < 0 or (v->>'price')::numeric > 1000000 then raise exception 'BAD_INPUT'; end if;
    v := jsonb_build_object('enabled', coalesce((v->>'enabled')::boolean, false), 'start', v->>'start', 'end', v->>'end',
                            'price', round((v->>'price')::numeric)::int, 'min_age', greatest(coalesce((v->>'min_age')::int, 18), 0));
  end if;
  if k = 'whatsapp_bot' then
    if coalesce(v->>'apikey','') = '' then v := v || jsonb_build_object('apikey', coalesce((select value->>'apikey' from settings where key='whatsapp_bot'), '')); end if;
    v := v - 'has_key';
  end if;
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
    'settings', (select jsonb_object_agg(key, case when key='telegram' then value - 'bot_token' when key='whatsapp_bot' then value - 'apikey' else value end) from settings),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select * from audit_log order by at desc limit 5000) x));
end $$;


-- =====================================================================
-- ЛИЧНЫЙ БАЛАНС: внутренние функции
-- =====================================================================
create or replace function _client(p jsonb) returns client_accounts
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare s client_sessions; a client_accounts;
begin
  select * into s from client_sessions where token_hash = _sha(p->>'ctoken');
  if not found or s.expires_at < now() then raise exception 'CLIENT_AUTH_REQUIRED'; end if;
  update client_sessions set last_seen = now(), expires_at = greatest(expires_at, now() + interval '30 days') where token_hash = s.token_hash;
  select * into a from client_accounts where id = s.account_id;
  return a;
end $$;

-- Движение денег: единственное место, где меняется баланс. Блокирует строку счёта (FOR UPDATE).
create or replace function _balance_move(acc uuid, amt int, k text, descr text, actor text, bid uuid default null, tid uuid default null) returns int
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; nb int;
begin
  select * into a from client_accounts where id = acc for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if a.frozen and k in ('payment') then raise exception 'ACCOUNT_FROZEN'; end if;
  nb := a.balance + amt;
  if nb < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
  begin
    insert into balance_ops(account_id, kind, amount, balance_after, booking_id, topup_id, description, actor, method, comment, admin_id)
    values (acc, k, amt, nb, bid, tid, descr, actor, nullif(current_setting('cz.op_method', true), ''), nullif(current_setting('cz.op_comment', true), ''),
            case when actor = 'admin' then nullif(current_setting('cz.admin_id', true), '')::uuid end);
    perform set_config('cz.op_method', '', true); perform set_config('cz.op_comment', '', true);
  exception when unique_violation then
    raise exception 'ALREADY_PROCESSED';
  end;
  update client_accounts set balance = nb where id = acc;
  return nb;
end $$;

create or replace function _client_public(a client_accounts) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('name', a.name, 'phone', a.phone, 'balance', a.balance, 'frozen', a.frozen, 'frozen_reason', a.frozen_reason,
    'client_id', _client_id(a.client_no), 'reserved', _reserved(a.id), 'available', a.balance - _reserved(a.id),
    'ops', (select coalesce(jsonb_agg(jsonb_build_object('at', o.created_at, 'kind', o.kind, 'amount', o.amount, 'balance_after', o.balance_after, 'description', o.description, 'method', o.method,
              'booking_code', (select code from bookings where id = o.booking_id)) order by o.id desc), '[]'::jsonb)
            from (select * from balance_ops where account_id = a.id order by id desc limit 200) o),
    'topups', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'amount', t.amount, 'status', t.status, 'created_at', t.created_at, 'admin_note', t.admin_note, 'method', t.method, 'created_by', t.created_by,
              'bonus_percent', t.bonus_percent, 'bonus_amount', t.bonus_amount,
              'has_receipt', exists(select 1 from topup_receipts r where r.topup_id = t.id)) order by t.created_at desc), '[]'::jsonb)
            from (select * from topups where account_id = a.id order by created_at desc limit 50) t),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'equipment_name', b.equipment_name, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
              'total', b.total, 'status', b.status, 'status_ru', _status_ru(b.status), 'payment_status', b.payment_status, 'refunded', b.refunded,
              'can_cancel', b.status = 'awaiting_payment' or (b.payment_status = 'balance_pending' and b.status = 'pending_review'),
              'refund_preview', null::int) order by b.starts_at desc), '[]'::jsonb)
            from (select * from bookings where account_id = a.id order by starts_at desc limit 50) b),
    'payment', _setting('payment') - 'whatsapp', 'notify', _setting('notify'), 'balance_settings', _setting('balance'), 'bonus_settings', _setting('bonus'))
$$;

-- =====================================================================
-- ЛИЧНЫЙ БАЛАНС: функции клиента
-- =====================================================================
create or replace function client_register(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare ph text := _norm_phone(p->>'phone'); nm text := btrim(coalesce(p->>'name','')); pw text := coalesce(p->>'password',''); a client_accounts; tok text;
begin
  if ph is null then raise exception 'BAD_PHONE'; end if;
  if length(nm) < 2 or length(nm) > 60 then raise exception 'BAD_NAME'; end if;
  if length(pw) < 6 or length(pw) > 72 then raise exception 'PASSWORD_TOO_SHORT_CLIENT'; end if;
  if (select count(*) from client_accounts where created_at > now() - interval '10 minutes') >= 30 then raise exception 'RATE_LIMIT'; end if;
  if exists (select 1 from client_accounts where phone = ph) then raise exception 'PHONE_TAKEN'; end if;
  insert into client_accounts(phone, name, password_hash, last_login_at) values (ph, nm, extensions.crypt(pw, extensions.gen_salt('bf', 10)), now()) returning * into a;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into client_sessions(token_hash, account_id, expires_at) values (_sha(tok), a.id, now() + interval '30 days');
  perform _audit('client', null, 'account_created', jsonb_build_object('phone', ph));
  return _client_public(a) || jsonb_build_object('ctoken', tok);
end $$;

create or replace function client_login(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare ph text := _norm_phone(p->>'phone'); a client_accounts; tok text;
begin
  if ph is null then raise exception 'BAD_PHONE'; end if;
  if (select count(*) from client_login_attempts where phone = ph and not ok and at > now() - interval '15 minutes') >= 6 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  select * into a from client_accounts where phone = ph;
  if not found or a.password_hash <> extensions.crypt(coalesce(p->>'password',''), a.password_hash) then
    insert into client_login_attempts(phone, ok) values (ph, false); perform pg_sleep(0.3);
    raise exception 'BAD_LOGIN';
  end if;
  insert into client_login_attempts(phone, ok) values (ph, true);
  delete from client_sessions where account_id = a.id and expires_at < now();
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into client_sessions(token_hash, account_id, expires_at) values (_sha(tok), a.id, now() + interval '30 days');
  update client_accounts set last_login_at = now() where id = a.id;
  return _client_public(a) || jsonb_build_object('ctoken', tok);
end $$;

create or replace function client_logout(p jsonb) returns jsonb
language sql volatile security definer set search_path = public, extensions, pg_temp as
$$ delete from client_sessions where token_hash = _sha(p->>'ctoken'); select '{"ok":true}'::jsonb $$;

create or replace function client_me(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts;
begin a := _client(p); return _client_public(a); end $$;


-- ---------- Бонусная программа ----------
create or replace function _bonus_validate(v jsonb) returns jsonb
language plpgsql immutable as $$
declare t jsonb; out_t jsonb := '[]'::jsonb; mn numeric; mx numeric; pc numeric; maxp numeric := coalesce((v->>'max_percent')::numeric, 100);
begin
  if jsonb_typeof(v->'tiers') <> 'array' or jsonb_array_length(v->'tiers') > 30 then raise exception 'BAD_INPUT'; end if;
  if maxp < 0 or maxp > 100 then raise exception 'BAD_INPUT'; end if;
  for t in select * from jsonb_array_elements(v->'tiers') loop
    mn := (t->>'min')::numeric; mx := nullif(t->>'max','')::numeric; pc := (t->>'percent')::numeric;
    if mn is null or mn < 0 or pc is null or pc < 0 or pc > 100 or (mx is not null and mx < mn) then raise exception 'BAD_INPUT'; end if;
    out_t := out_t || jsonb_build_array(jsonb_build_object('min', round(mn)::int, 'max', case when mx is null then null else round(mx)::int end,
                                                           'percent', pc, 'enabled', coalesce((t->>'enabled')::boolean, true)));
  end loop;
  return jsonb_build_object('enabled', coalesce((v->>'enabled')::boolean, false), 'max_percent', maxp, 'tiers', out_t);
end $$;

-- процент и сумма бонуса для суммы пополнения по действующей шкале (подходящий включённый уровень с наибольшим процентом, но не выше максимума)
create or replace function _bonus_for(amt int) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare b jsonb := _setting('bonus'); t jsonb; pc numeric := 0;
begin
  if b is null or not coalesce((b->>'enabled')::boolean, false) or amt is null then return jsonb_build_object('percent', 0, 'amount', 0); end if;
  for t in select * from jsonb_array_elements(coalesce(b->'tiers','[]'::jsonb)) loop
    if coalesce((t->>'enabled')::boolean, true) and amt >= (t->>'min')::numeric
       and (nullif(t->>'max','') is null or amt <= (t->>'max')::numeric) and (t->>'percent')::numeric > pc then
      pc := (t->>'percent')::numeric;
    end if;
  end loop;
  pc := least(pc, coalesce((b->>'max_percent')::numeric, 100));
  return jsonb_build_object('percent', pc, 'amount', floor(amt * pc / 100)::int);
end $$;

-- зачисление подтверждённого пополнения: основная сумма + бонус (две записи в истории, одна транзакция)
create or replace function _credit_topup(t topups, how text) returns int
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare nb int; m text := current_setting('cz.op_method', true); c text := current_setting('cz.op_comment', true);
begin
  nb := _balance_move(t.account_id, t.amount, 'topup', format('Пополнение %s (%s)', t.code, how), 'admin', null, t.id);
  if coalesce(t.bonus_amount, 0) > 0 then
    perform set_config('cz.op_method', coalesce(m, ''), true); perform set_config('cz.op_comment', coalesce(c, ''), true);
    nb := _balance_move(t.account_id, t.bonus_amount, 'bonus', format('Бонус %s%% к пополнению %s', rtrim(to_char(t.bonus_percent, 'FM990.##'), '.'), t.code), 'admin', null, t.id);
  end if;
  return nb;
end $$;

create or replace function client_topup_create(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; amt int := (p->>'amount')::int; s jsonb := coalesce(_setting('balance'), '{}'); t topups; cd text; bn jsonb;
begin
  a := _client(p);
  if not coalesce((s->>'enabled')::boolean, true) then raise exception 'BALANCE_DISABLED'; end if;
  if a.frozen then raise exception 'ACCOUNT_FROZEN'; end if;
  if amt is null or amt < coalesce((s->>'min_topup')::int, 100) or amt > coalesce((s->>'max_topup')::int, 50000) then raise exception 'BAD_AMOUNT'; end if;
  if (select count(*) from topups where account_id = a.id and status in ('awaiting_payment','receipt_sent')) >= 3 then raise exception 'TOO_MANY_PENDING'; end if;
  loop cd := 'TP-' || _rand_code(6); exit when not exists (select 1 from topups where code = cd); end loop;
  bn := _bonus_for(amt);   -- бонус фиксируется в заявке по шкале на момент создания
  insert into topups(code, account_id, amount, bonus_percent, bonus_amount) values (cd, a.id, amt, (bn->>'percent')::numeric, (bn->>'amount')::int) returning * into t;
  perform _audit('client', null, 'topup_created', jsonb_build_object('code', cd, 'amount', amt, 'phone', a.phone, 'bonus_percent', bn->'percent', 'bonus', bn->'amount'));
  perform _notify('topup_new', null, format(E'💰 Заявка на пополнение баланса %s\nКлиент: %s, +%s (ID %s)\nСумма: %s ₽%s\nСтатус: ожидает подтверждения', cd, a.name, a.phone, _client_id(a.client_no), amt,
    case when t.bonus_amount > 0 then format(E'\nБонус %s%%: +%s ₽ · итого %s ₽', rtrim(to_char(t.bonus_percent,'FM990.##'), '.'), t.bonus_amount, amt + t.bonus_amount) else '' end));
  return jsonb_build_object('topup', to_jsonb(t), 'client_id', _client_id(a.client_no), 'payment', _setting('payment') - 'whatsapp', 'notify', _setting('notify'));
end $$;

create or replace function client_topup_receipt(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; t topups; m text := p->>'mime'; d text := p->>'data'; h text;
begin
  a := _client(p);
  select * into t from topups where id = (p->>'topup_id')::uuid and account_id = a.id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if t.status not in ('awaiting_payment','receipt_sent') then raise exception 'BAD_STATUS'; end if;
  if m not in ('image/jpeg','image/png','image/webp','application/pdf') then raise exception 'BAD_FILE'; end if;
  if d is null or length(d) < 100 or length(d) > 7000000 then raise exception 'BAD_FILE'; end if;
  if (select count(*) from topup_receipts where topup_id = t.id) >= 3 then raise exception 'TOO_MANY_FILES'; end if;
  h := encode(extensions.digest(decode(d, 'base64'), 'sha256'), 'hex');
  if exists (select 1 from topup_receipts where file_hash = h) or exists (select 1 from receipts where file_hash = h) then raise exception 'RECEIPT_USED'; end if;
  insert into topup_receipts(topup_id, mime, data, size_bytes, file_hash) values (t.id, m, d, length(d) * 3 / 4, h);
  update topups set status = 'receipt_sent', updated_at = now() where id = t.id returning * into t;
  perform _notify('topup_receipt', null, format(E'📎 Чек по пополнению баланса %s — ожидает проверки\nКлиент: %s, +%s\nСумма: %s ₽\nПроверьте поступление денег в банке.', t.code, a.name, a.phone, t.amount));
  return to_jsonb(t);
end $$;

create or replace function client_topup_cancel(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; t topups;
begin
  a := _client(p);
  update topups set status = 'cancelled', updated_at = now() where id = (p->>'topup_id')::uuid and account_id = a.id and status = 'awaiting_payment' returning * into t;
  if not found then raise exception 'BAD_STATUS'; end if;
  return to_jsonb(t);
end $$;

-- =====================================================================
-- ЛИЧНЫЙ БАЛАНС: функции администратора
-- =====================================================================
create or replace function admin_topups(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
begin
  perform _admin(p);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'amount', t.amount, 'status', t.status, 'created_at', t.created_at, 'decided_at', t.decided_at,
      'admin_note', t.admin_note, 'account_id', a.id, 'name', a.name, 'phone', a.phone, 'balance', a.balance, 'frozen', a.frozen,
      'client_id', _client_id(a.client_no), 'method', t.method, 'created_by', t.created_by,
      'bonus_percent', t.bonus_percent, 'bonus_amount', t.bonus_amount, 'bonus_off_reason', t.bonus_off_reason,
      'receipts', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'mime', r.mime) order by r.created_at), '[]'::jsonb) from topup_receipts r where r.topup_id = t.id))
    order by (t.status in ('receipt_sent','awaiting_payment')) desc, t.created_at desc), '[]'::jsonb)
    from (select * from topups where (nullif(p->>'status','') is null or status = p->>'status') order by created_at desc limit 300) t join client_accounts a on a.id = t.account_id);
end $$;

create or replace function admin_topup_receipt(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare r topup_receipts;
begin
  perform _admin(p);
  select * into r from topup_receipts where id = (p->>'id')::uuid;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('mime', r.mime, 'data', r.data);
end $$;

create or replace function admin_topup_action(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare t topups; a client_accounts; act text := p->>'action'; nb int;
begin
  perform _admin(p);
  select * into t from topups where id = (p->>'id')::uuid for update;   -- блокировка: два нажатия не пройдут одновременно
  if not found then raise exception 'NOT_FOUND'; end if;
  if t.status not in ('awaiting_payment','receipt_sent') then raise exception 'ALREADY_PROCESSED'; end if;
  select * into a from client_accounts where id = t.account_id;
  if act = 'approve' then
    if not coalesce((p->>'attest')::boolean, false) then raise exception 'ATTEST_REQUIRED'; end if;
    perform set_config('cz.op_method', coalesce(nullif(p->>'method',''), 'transfer'), true);
    perform set_config('cz.op_comment', coalesce(left(p->>'note', 300), ''), true);
    nb := _credit_topup(t, 'заявка с сайта');
    update topups set status = 'approved', decided_at = now(), updated_at = now(), admin_note = left(p->>'note', 300), method = coalesce(nullif(p->>'method',''), 'transfer') where id = t.id returning * into t;
    perform _audit('admin', null, 'topup_approved', jsonb_build_object('code', t.code, 'amount', t.amount, 'bonus', t.bonus_amount, 'bonus_percent', t.bonus_percent, 'phone', a.phone, 'balance_after', nb));
    insert into notifications(event, message, seen) values ('topup_approved', format(E'✅ Пополнение %s подтверждено: +%s ₽%s\nКлиент: %s, +%s\nБаланс: %s ₽', t.code, t.amount,
      case when t.bonus_amount > 0 then format(' + бонус %s ₽', t.bonus_amount) else '' end, a.name, a.phone, nb), true);
  elsif act = 'reject' then
    update topups set status = 'rejected', decided_at = now(), updated_at = now(), admin_note = left(p->>'note', 300) where id = t.id returning * into t;
    perform _audit('admin', null, 'topup_rejected', jsonb_build_object('code', t.code, 'amount', t.amount, 'phone', a.phone, 'note', p->>'note'));
  else raise exception 'BAD_ACTION'; end if;
  return to_jsonb(t);
end $$;

create or replace function admin_accounts(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare q text := nullif(btrim(p->>'q'),'');
begin
  perform _admin(p);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'phone', a.phone, 'balance', a.balance, 'frozen', a.frozen, 'created_at', a.created_at,
      'last_login_at', a.last_login_at, 'client_id', _client_id(a.client_no), 'reserved', _reserved(a.id)) order by a.created_at desc), '[]'::jsonb)
    from (select * from client_accounts where q is null or name ilike '%'||q||'%'
            or (regexp_replace(q,'\D','','g') <> '' and phone like '%'||regexp_replace(q,'\D','','g')||'%')
            or (q ~* '^\s*(cz-?)?0*\d+\s*$' and client_no = regexp_replace(q,'\D','','g')::bigint)
          order by created_at desc limit 300) a);
end $$;

create or replace function admin_account_get(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts;
begin
  perform _admin(p);
  select * into a from client_accounts where id = (p->>'id')::uuid;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  return _client_public(a) || jsonb_build_object('id', a.id, 'created_at', a.created_at, 'last_login_at', a.last_login_at,
    'ops_full', (select coalesce(jsonb_agg(jsonb_build_object('at', o.created_at, 'kind', o.kind, 'amount', o.amount, 'balance_after', o.balance_after,
                   'balance_before', o.balance_after - o.amount, 'description', o.description, 'actor', o.actor, 'method', o.method, 'comment', o.comment,
                   'admin', (select username from admin_users u where u.id = o.admin_id)) order by o.id desc), '[]'::jsonb)
                 from balance_ops o where o.account_id = a.id));
end $$;

create or replace function admin_account_adjust(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare amt int := (p->>'amount')::int; why text := btrim(coalesce(p->>'reason','')); nb int; a client_accounts;
begin
  perform _admin(p);
  if amt is null or amt = 0 or abs(amt) > 100000 then raise exception 'BAD_AMOUNT'; end if;
  if length(why) < 3 then raise exception 'REASON_REQUIRED'; end if;
  select * into a from client_accounts where id = (p->>'id')::uuid;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  perform set_config('cz.op_comment', why, true);
  nb := _balance_move(a.id, amt, 'adjust', 'Корректировка администратора: ' || why, 'admin');
  perform _audit('admin', null, 'balance_adjusted', jsonb_build_object('phone', a.phone, 'amount', amt, 'reason', why, 'balance_after', nb));
  return jsonb_build_object('ok', true, 'balance', nb);
end $$;

create or replace function admin_account_freeze(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; fz boolean := coalesce((p->>'frozen')::boolean, true);
begin
  perform _admin(p);
  update client_accounts set frozen = fz, frozen_reason = case when fz then left(coalesce(p->>'reason',''), 300) end where id = (p->>'id')::uuid returning * into a;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if fz then delete from client_sessions where account_id = a.id; end if;
  perform _audit('admin', null, case when fz then 'account_frozen' else 'account_unfrozen' end, jsonb_build_object('phone', a.phone, 'reason', p->>'reason'));
  return jsonb_build_object('ok', true, 'frozen', a.frozen);
end $$;

create or replace function admin_account_password(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; pw text := coalesce(p->>'password','');
begin
  perform _admin(p);
  if length(pw) < 6 then raise exception 'PASSWORD_TOO_SHORT_CLIENT'; end if;
  update client_accounts set password_hash = extensions.crypt(pw, extensions.gen_salt('bf', 10)) where id = (p->>'id')::uuid returning * into a;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  delete from client_sessions where account_id = a.id;
  perform _audit('admin', null, 'client_password_reset', jsonb_build_object('phone', a.phone));
  return '{"ok":true}';
end $$;


-- Ручное пополнение администратором (клиент передал деньги в клубе) — зачисляется сразу, с записью в истории
create or replace function admin_account_topup(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare a client_accounts; amt int := (p->>'amount')::int; m text := coalesce(nullif(p->>'method',''), 'cash');
  cmt text := left(btrim(coalesce(p->>'comment','')), 300); rid text := nullif(btrim(coalesce(p->>'request_id','')), ''); t topups; cd text; nb int; before int;
  nob boolean := coalesce((p->>'no_bonus')::boolean, false); why text := left(btrim(coalesce(p->>'bonus_off_reason','')), 300); bn jsonb;
begin
  perform _admin(p);
  if amt is null or amt <= 0 or amt > 100000 then raise exception 'BAD_AMOUNT'; end if;
  if m not in ('cash','transfer','other') then raise exception 'BAD_INPUT'; end if;
  if rid is not null and exists (select 1 from topups where request_id = rid) then raise exception 'ALREADY_PROCESSED'; end if;
  select * into a from client_accounts where id = (p->>'id')::uuid for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  before := a.balance;
  if nob and length(why) < 3 then raise exception 'REASON_REQUIRED'; end if;
  bn := case when nob then '{"percent":0,"amount":0}'::jsonb else _bonus_for(amt) end;
  loop cd := 'TP-' || _rand_code(6); exit when not exists (select 1 from topups where code = cd); end loop;
  begin
    insert into topups(code, account_id, amount, status, admin_note, decided_at, method, created_by, request_id, bonus_percent, bonus_amount, bonus_off_reason)
    values (cd, a.id, amt, 'approved', nullif(cmt,''), now(), m, 'admin', rid, (bn->>'percent')::numeric, (bn->>'amount')::int, case when nob then why end) returning * into t;
  exception when unique_violation then raise exception 'ALREADY_PROCESSED';
  end;
  perform set_config('cz.op_method', m, true); perform set_config('cz.op_comment', cmt, true);
  nb := _credit_topup(t, 'в клубе, ' || case m when 'cash' then 'наличные' when 'transfer' then 'банковский перевод' else 'другой способ' end);
  perform _audit('admin', null, 'manual_topup', jsonb_build_object('code', cd, 'phone', a.phone, 'amount', amt, 'bonus', t.bonus_amount, 'bonus_percent', t.bonus_percent,
    'bonus_off_reason', t.bonus_off_reason, 'method', m, 'comment', cmt, 'balance_before', before, 'balance_after', nb));
  insert into notifications(event, message, seen) values ('topup_manual',
    format(E'💵 Ручное пополнение %s: +%s ₽ (%s)\nКлиент: %s, +%s (ID %s)\nБаланс: %s → %s ₽', cd, amt,
      case m when 'cash' then 'наличные' when 'transfer' then 'перевод' else 'другое' end, a.name, a.phone, _client_id(a.client_no), before, nb), true);
  return jsonb_build_object('ok', true, 'code', cd, 'balance_before', before, 'balance', nb, 'bonus', t.bonus_amount, 'bonus_percent', t.bonus_percent);
end $$;

-- Общая история операций с балансом (все клиенты)
create or replace function admin_balance_ops(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare q text := nullif(btrim(p->>'q'),''); k text := nullif(p->>'kind','');
begin
  perform _admin(p);
  return (select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object('id', o.id, 'at', o.created_at, 'kind', o.kind, 'amount', o.amount, 'balance_before', o.balance_after - o.amount,
      'balance_after', o.balance_after, 'method', o.method, 'comment', o.comment, 'description', o.description, 'actor', o.actor,
      'admin', u.username, 'account_id', a.id, 'name', a.name, 'phone', a.phone, 'client_id', _client_id(a.client_no),
      'booking_code', b.code, 'topup_code', t.code, 'bonus_percent', t.bonus_percent) x
    from balance_ops o join client_accounts a on a.id = o.account_id
      left join admin_users u on u.id = o.admin_id left join bookings b on b.id = o.booking_id left join topups t on t.id = o.topup_id
    where (k is null or o.kind = k)
      and (q is null or a.name ilike '%'||q||'%' or b.code ilike '%'||q||'%' or t.code ilike '%'||q||'%'
           or (regexp_replace(q,'\D','','g') <> '' and a.phone like '%'||regexp_replace(q,'\D','','g')||'%')
           or (q ~* '^\s*(cz-?)?0*\d+\s*$' and a.client_no = regexp_replace(q,'\D','','g')::bigint))
    order by o.id desc limit 500) z);
end $$;

create or replace function admin_whatsapp_test(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare st text;
begin
  perform _admin(p);
  st := _wa_send(E'✅ Проверка уведомлений: WhatsApp подключён. Сюда будут приходить новые брони, чеки, пополнения баланса и отмены.');
  insert into notifications(event, message, channel_status, seen) values ('wa_test', 'Проверка WhatsApp', st, true);
  return jsonb_build_object('status', st);
end $$;

-- =====================================================================
-- Права: внутренние функции недоступны снаружи, RPC — доступны
-- =====================================================================
do $$
declare f record;
  api text[] := array['get_public_data','get_equipment_photo','get_availability','get_occupancy','quote_booking','create_booking',
    'get_booking','upload_receipt','mark_paid','cancel_my_booking','admin_login','admin_logout','admin_ping','admin_change_password',
    'admin_dashboard','admin_list_bookings','admin_get_booking','admin_get_receipt','admin_booking_action','admin_update_booking',
    'admin_create_booking','admin_whatsapp_test','admin_account_topup','admin_balance_ops','admin_calendar','admin_block_create','admin_block_delete','admin_equipment_list','admin_equipment_save',
    'admin_equipment_delete','admin_equipment_photo','admin_equipment_status','admin_settings_get','admin_settings_save','admin_tariff_save','admin_tariff_delete',
    'admin_promo_save','admin_promo_delete','admin_notifications','admin_audit','admin_export',
    'client_register','client_login','client_logout','client_me','client_topup_create','client_topup_receipt','client_topup_cancel','client_cancel_booking',
    'admin_topups','admin_topup_receipt','admin_topup_action','admin_accounts','admin_account_get','admin_account_adjust','admin_account_freeze','admin_account_password'];
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
