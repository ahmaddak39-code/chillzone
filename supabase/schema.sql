-- =====================================================================
-- CHILL ZONE — база данных (Supabase / PostgreSQL)
-- Таблицы закрыты для прямого доступа (RLS без политик + revoke).
-- Вся работа идёт через функции public.* (RPC), которые проверяют права.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
-- pg_net: исходящие HTTP-запросы для уведомлений (WhatsApp/Telegram). Если недоступно — уведомления остаются в админ-панели.
do $$ begin create extension if not exists pg_net; exception when others then raise notice 'pg_net недоступен'; end $$;

-- ---------- Настройки ----------
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- Оборудование ----------
create table if not exists equipment (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('pc','ps','wheel','vr','tennis','airhockey','foosball','tv','room','other')),
  description text not null default '',
  features text[] not null default '{}',
  price_per_hour int check (price_per_hour is null or price_per_hour >= 0),
  max_players int,
  bookable boolean not null default true,
  is_active boolean not null default true,
  status text not null default 'ok' check (status in ('ok','maintenance','disabled')),
  status_note text,
  photo_url text,
  has_photo boolean not null default false,
  map_x numeric not null default 500,
  map_y numeric not null default 350,
  map_rot numeric not null default 0,
  link_to text,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Доп. поля оборудования (размер и вид на 3D-схеме, подпись, своё расписание)
alter table equipment add column if not exists map_scale numeric not null default 1;
alter table equipment add column if not exists model text;
alter table equipment add column if not exists label text;
alter table equipment add column if not exists schedule jsonb;

create table if not exists equipment_photos (
  equipment_id text primary key references equipment(id) on delete cascade,
  mime text not null,
  data text not null,
  updated_at timestamptz not null default now()
);

-- ---------- Тарифы ----------
create table if not exists tariff_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'custom' check (kind in ('night','morning','day','weekend','holiday','custom')),
  applies_to text not null default 'all',         -- all | kind:pc | id:pc01
  days int[],                                      -- 1=пн ... 7=вс, null = все дни
  dates date[],                                    -- конкретные даты (праздники), null = любые
  time_from time,
  time_to time,
  mode text not null default 'price' check (mode in ('price','percent')),
  value numeric not null,
  priority int not null default 0,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Акции ----------
create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  type text not null check (type in ('bonus_time','discount','giveaway','student','group','info')),
  config jsonb not null default '{}',
  is_active boolean not null default false,
  starts_on date,
  ends_on date,
  sort int not null default 100,
  created_at timestamptz not null default now()
);

-- ---------- Клиенты ----------
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text not null,
  bookings_count int not null default 0,
  created_at timestamptz not null default now(),
  last_booking_at timestamptz
);

-- ---------- Бронирования ----------
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  access_token_hash text not null,
  customer_id uuid references customers(id),
  customer_name text not null,
  phone text not null,
  equipment_id text not null references equipment(id),
  equipment_name text not null,
  starts_at timestamptz not null,
  paid_minutes int not null,
  bonus_minutes int not null default 0,
  ends_at timestamptz not null,
  people int not null default 1,
  is_student boolean not null default false,
  is_night boolean not null default false,
  quote jsonb not null default '{}',
  total int not null,
  due_now int not null,
  status text not null check (status in ('awaiting_payment','receipt_sent','pending_review','payment_verified','confirmed','rejected','cancelled','expired')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','claimed','verified','onsite','balance')),
  hold_until timestamptz,
  source text not null default 'site' check (source in ('site','admin')),
  comment text,
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists bookings_starts_idx on bookings(starts_at);
create index if not exists bookings_status_idx on bookings(status);

-- ---------- Блокировки (обслуживание, частные мероприятия) ----------
create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  equipment_id text not null references equipment(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- Занятость (защита от двойного бронирования) ----------
-- Каждая бронь/блокировка занимает «ресурсы» на период.
-- Ограничение EXCLUDE на уровне базы не даёт двум активным записям
-- пересечься на одном ресурсе — даже при одновременных запросах.
create table if not exists booking_slots (
  id bigserial primary key,
  booking_id uuid references bookings(id) on delete cascade,
  block_id uuid references blocks(id) on delete cascade,
  resource text not null,
  period tstzrange not null,
  active boolean not null default true,
  constraint booking_slots_no_overlap exclude using gist (resource with =, period with &&) where (active)
);
create index if not exists booking_slots_booking_idx on booking_slots(booking_id);

-- ---------- Чеки ----------
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  mime text not null,
  data text not null,
  size_bytes int not null,
  created_at timestamptz not null default now()
);

-- ---------- Администраторы ----------
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  password_changed_at timestamptz
);

create table if not exists admin_sessions (
  token_hash text primary key,
  admin_id uuid not null references admin_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists login_attempts (
  id bigserial primary key,
  ok boolean not null,
  at timestamptz not null default now()
);

-- ---------- Журнал и уведомления ----------
create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  booking_id uuid,
  action text not null,
  details jsonb not null default '{}'
);
create index if not exists audit_booking_idx on audit_log(booking_id);

create table if not exists notifications (
  id bigserial primary key,
  at timestamptz not null default now(),
  event text not null,
  booking_id uuid,
  message text not null,
  channel_status text not null default 'in_app',
  seen boolean not null default false
);

-- ---------- Закрываем прямой доступ ----------
do $$
declare t text;
begin
  foreach t in array array['settings','equipment','equipment_photos','tariff_rules','promotions','customers','bookings','blocks','booking_slots','receipts','admin_users','admin_sessions','login_attempts','audit_log','notifications'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;


-- =====================================================================
-- ЛИЧНЫЙ БАЛАНС КЛИЕНТА
-- =====================================================================
create table if not exists client_accounts (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text not null,
  password_hash text not null,
  balance int not null default 0 check (balance >= 0),          -- нельзя уйти в минус
  frozen boolean not null default false,                          -- блокировка операций
  frozen_reason text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create table if not exists client_sessions (
  token_hash text primary key,
  account_id uuid not null references client_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists client_login_attempts (
  id bigserial primary key,
  phone text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists client_login_attempts_idx on client_login_attempts(phone, at);

create table if not exists topups (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  account_id uuid not null references client_accounts(id),
  amount int not null check (amount > 0),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment','receipt_sent','approved','rejected','cancelled')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists topups_account_idx on topups(account_id, created_at);

-- Чеки пополнений. Хеш файла уникален среди всех чеков — один и тот же чек нельзя засчитать дважды.
create table if not exists topup_receipts (
  id uuid primary key default gen_random_uuid(),
  topup_id uuid not null references topups(id) on delete cascade,
  mime text not null,
  data text not null,
  size_bytes int not null,
  file_hash text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists topup_receipts_hash_uq on topup_receipts(file_hash);
alter table receipts add column if not exists file_hash text;

-- Журнал всех движений денег. Уникальные индексы не дают дважды зачислить пополнение,
-- дважды списать за одну бронь или дважды вернуть деньги за одну бронь.
create table if not exists balance_ops (
  id bigserial primary key,
  account_id uuid not null references client_accounts(id),
  kind text not null check (kind in ('topup','payment','refund','adjust')),
  amount int not null check (amount <> 0),
  balance_after int not null check (balance_after >= 0),
  booking_id uuid references bookings(id),
  topup_id uuid references topups(id),
  description text not null,
  actor text not null,
  created_at timestamptz not null default now()
);
create index if not exists balance_ops_account_idx on balance_ops(account_id, created_at);
create unique index if not exists balance_ops_topup_uq on balance_ops(topup_id) where kind = 'topup';
create unique index if not exists balance_ops_payment_uq on balance_ops(booking_id) where kind = 'payment';
create unique index if not exists balance_ops_refund_uq on balance_ops(booking_id) where kind = 'refund';

alter table bookings add column if not exists account_id uuid references client_accounts(id);
alter table bookings add column if not exists refunded int not null default 0;
do $$ begin
  alter table bookings drop constraint if exists bookings_payment_status_check;
  alter table bookings add constraint bookings_payment_status_check check (payment_status in ('unpaid','claimed','verified','onsite','balance','balance_pending'));
end $$;

-- ID клиента (CZ-000123), способ оплаты и администратор в истории операций, ручные пополнения
alter table client_accounts add column if not exists client_no bigserial;
create unique index if not exists client_accounts_no_uq on client_accounts(client_no);
alter table balance_ops add column if not exists method text;
alter table balance_ops add column if not exists comment text;
alter table balance_ops add column if not exists admin_id uuid references admin_users(id) on delete set null;
alter table topups add column if not exists method text;
alter table topups add column if not exists created_by text not null default 'client';
alter table topups add column if not exists request_id text;
alter table topups add column if not exists client_sent_at timestamptz;
create unique index if not exists topups_request_uq on topups(request_id) where request_id is not null;

-- Бонусная программа: процент и сумма бонуса фиксируются в заявке в момент создания
alter table topups add column if not exists bonus_percent numeric not null default 0;
alter table topups add column if not exists bonus_amount int not null default 0;
alter table topups add column if not exists bonus_off_reason text;
do $$ begin
  alter table balance_ops drop constraint if exists balance_ops_kind_check;
  alter table balance_ops add constraint balance_ops_kind_check check (kind in ('topup','bonus','payment','refund','adjust'));
end $$;
create unique index if not exists balance_ops_bonus_uq on balance_ops(topup_id) where kind = 'bonus';

do $$
declare t text;
begin
  foreach t in array array['client_accounts','client_sessions','client_login_attempts','topups','topup_receipts','balance_ops'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    if exists (select 1 from pg_roles where rolname='anon') then execute format('revoke all on table %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on table %I from authenticated', t); end if;
  end loop;
end $$;

insert into settings(key, value) values
 ('balance', '{"enabled": true, "require_account": true, "presets": [500, 1000, 2000, 3000], "min_topup": 100, "max_topup": 50000, "refund_full_hours": 2, "refund_late_percent": 0}')
on conflict (key) do nothing;

-- =====================================================================
-- Начальные данные
-- =====================================================================
insert into settings(key, value) values
 ('timezone', '"Europe/Moscow"'),
 ('hold_minutes', '15'),
 ('durations', '[60,120,180,240]'),
 ('custom_duration', '{"enabled": false, "min": 30, "max": 720}'),
 ('booking_horizon_days', '30'),
 ('work_hours', '{"always_open": true, "days": {"1":{"open":"10:00","close":"02:00","closed":false},"2":{"open":"10:00","close":"02:00","closed":false},"3":{"open":"10:00","close":"02:00","closed":false},"4":{"open":"10:00","close":"02:00","closed":false},"5":{"open":"10:00","close":"02:00","closed":false},"6":{"open":"10:00","close":"02:00","closed":false},"7":{"open":"10:00","close":"02:00","closed":false}}}'),
 ('room', '{"base_people": 5, "extra_person_price": 400, "max_people": 5}'),
 ('student_discount_percent', '0'),
 ('night', '{"enabled": false, "start": "22:00", "end": "12:00", "prepay": 0, "min_age": 18, "rules": ""}'),
 ('payment', '{"bank": "Т-Банк (бывший Тинькофф)", "phone": "8 928 060-55-50", "whatsapp": "79280605550"}'),
 ('contacts', '{"address": "г. Хасавюрт, ул. Тотурбиева, 137", "phone": "+7 928 553-52-52", "instagram": "chill.zone.game"}'),
 ('admin_idle_minutes', '30'),
 ('telegram', '{"enabled": false, "bot_token": "", "chat_id": ""}'),
 ('notify', '{"whatsapp": "79285535252", "label": "+7 928 553-52-52"}'),
 ('whatsapp_bot', '{"enabled": false, "phone": "79285535252", "apikey": ""}'),
 ('night_package', '{"enabled": true, "start": "00:00", "end": "07:00", "price": 5000, "min_age": 18}'),
 ('bonus', '{"enabled": true, "max_percent": 20, "tiers": [
    {"min": 500, "max": 999, "percent": 0, "enabled": true},
    {"min": 1000, "max": 2999, "percent": 5, "enabled": true},
    {"min": 3000, "max": 4999, "percent": 10, "enabled": true},
    {"min": 5000, "max": 9999, "percent": 15, "enabled": true},
    {"min": 10000, "max": 19999, "percent": 18, "enabled": true},
    {"min": 20000, "max": null, "percent": 20, "enabled": true}]}')
on conflict (key) do nothing;
-- старые «ночные правила» для отдельного оборудования (предоплата 500 ₽, документы) отключены: ночь — только пакет для всей комнаты
update settings set value = value || '{"enabled": false, "prepay": 0, "rules": ""}'::jsonb where key = 'night' and coalesce((value->>'enabled')::boolean, false);

insert into equipment(id,name,kind,description,features,price_per_hour,max_players,bookable,photo_url,map_x,map_y,map_rot,sort,link_to) values
 ('pc01','PC 01','pc','Игровой компьютер с видеокартой RTX, геймерское кресло и RGB-подсветка.','{"Видеокарта RTX","Игровое кресло","RGB-подсветка"}',150,1,true,'/img/pcs.webp',560,95,0,1,null),
 ('pc02','PC 02','pc','Игровой компьютер с видеокартой RTX, геймерское кресло и RGB-подсветка.','{"Видеокарта RTX","Игровое кресло","RGB-подсветка"}',150,1,true,'/img/pcs.webp',650,95,0,2,null),
 ('pc03','PC 03','pc','Игровой компьютер с видеокартой RTX, геймерское кресло и RGB-подсветка.','{"Видеокарта RTX","Игровое кресло","RGB-подсветка"}',150,1,true,'/img/pcs.webp',740,95,0,3,null),
 ('pc04','PC 04','pc','Игровой компьютер с видеокартой RTX, геймерское кресло и RGB-подсветка.','{"Видеокарта RTX","Игровое кресло","RGB-подсветка"}',150,1,true,'/img/pcs.webp',830,95,0,4,null),
 ('pc05','PC 05','pc','Игровой компьютер с видеокартой RTX, геймерское кресло и RGB-подсветка.','{"Видеокарта RTX","Игровое кресло","RGB-подсветка"}',150,1,true,'/img/pcs.webp',920,95,0,5,null),
 ('ps','PlayStation','ps','Отдельная PlayStation-зона с большим телевизором 75 дюймов и диваном для компании.','{"Телевизор 75 дюймов","Отдельная зона","Диван"}',300,null,true,'/img/ps.webp',150,170,0,6,null),
 ('tv','Телевизор 75″','tv','Большой телевизор 75 дюймов в PlayStation-зоне. Бронируется вместе с PlayStation.','{"75 дюймов"}',null,null,false,'/img/ps.webp',150,22,0,7,'ps'),
 ('wheel','Игровой руль','wheel','Гоночный симулятор: руль, педали, гоночное кресло и изогнутый монитор. Forza Horizon.','{"Руль и педали","Гоночное кресло","Forza Horizon"}',null,1,true,'/img/wheel.webp',890,560,0,8,null),
 ('vr','VR','vr','Виртуальная реальность: шлем VR и свободная зона для игры.','{"Шлем VR","Отдельная зона"}',null,1,true,null,120,560,0,9,null),
 ('tennis','Настольный теннис','tennis','Полноразмерный стол для настольного тенниса.','{"Ракетки и мячи"}',null,4,true,'/img/tennis.webp',430,520,0,10,null),
 ('airhockey','Аэрохоккей','airhockey','Большой аэрохоккей с неоновой подсветкой и электронным табло.','{"Неоновая подсветка","Электронное табло"}',null,2,true,'/img/airhockey.webp',360,270,0,11,null),
 ('foosball','Настольный футбол','foosball','Классический настольный футбол для компании.','{"До 4 игроков"}',null,4,true,null,560,300,0,12,null),
 ('room','Вся игровая комната','room','Вся игровая комната целиком: компьютеры, PlayStation, руль, VR и настольные игры — только для вашей компании.','{"До 5 человек в базовой цене","Всё оборудование"}',2000,null,true,'/img/room.webp',500,350,0,0,null)
on conflict (id) do nothing;

insert into promotions(title, description, type, config, is_active, sort)
select 'Бонусное время', 'Бронируешь 1 час — получаешь 30 минут бесплатно. Бронируешь 2 часа — получаешь 1 час бесплатно.', 'bonus_time',
       '{"applies_to":"all","tiers":[{"min_minutes":60,"bonus_minutes":30},{"min_minutes":120,"bonus_minutes":60}]}', false, 1
where not exists (select 1 from promotions where type='bonus_time');
