-- =====================================================================
-- Pedido Direto — schema base (multi-loja)
-- Regras gerais:
--   * Dinheiro sempre em CENTAVOS (integer/bigint) — nunca float.
--   * Toda tabela tem store_id (isolamento entre lojas via RLS).
--   * Pedidos guardam "foto" do preço/nome no momento da compra.
-- =====================================================================

create type public.member_role    as enum ('owner','manager','staff');
create type public.store_status   as enum ('active','suspended');
create type public.order_mode     as enum ('delivery','pickup');
create type public.order_status   as enum (
  'awaiting_payment',  -- Pix/cartão online ainda não confirmado pelo gateway
  'pending',           -- Em análise (aguardando a loja aceitar)
  'preparing',         -- Em preparo
  'ready',             -- Pronto
  'out_for_delivery',  -- Em entrega
  'completed',         -- Finalizado
  'rejected',          -- Recusado pela loja
  'canceled'           -- Cancelado (pela loja ou expirado)
);
create type public.payment_method as enum ('pix','card_online','card_on_delivery','cash');
create type public.payment_status as enum ('not_applicable','pending','paid','failed','expired','refunded');
create type public.coupon_type    as enum ('percent','fixed','free_delivery');

-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text check (char_length(full_name) <= 120),
  created_at  timestamptz not null default now()
);

create table public.stores (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name                text not null check (char_length(name) between 2 and 80),
  logo_url            text check (char_length(logo_url) <= 500),
  address             text check (char_length(address) <= 300),
  whatsapp            text check (whatsapp ~ '^[0-9]{10,13}$'),
  status              public.store_status not null default 'active',
  is_open             boolean not null default false,
  high_demand         boolean not null default false,
  delivery_fee_cents  integer not null default 0 check (delivery_fee_cents between 0 and 100000),
  min_order_cents     integer not null default 0 check (min_order_cents between 0 and 1000000),
  prep_minutes        integer not null default 30 check (prep_minutes between 5 and 240),
  order_seq           integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.store_members (
  store_id    uuid not null references public.stores(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.member_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index on public.store_members (user_id);

-- ---------------------------------------------------------------------
-- Cardápio
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  position    integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on public.categories (store_id);

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  category_id   uuid references public.categories(id) on delete set null,
  name          text not null check (char_length(name) between 1 and 80),
  description   text check (char_length(description) <= 500),
  price_cents   integer not null check (price_cents between 1 and 10000000),
  image_url     text check (char_length(image_url) <= 500),
  is_available  boolean not null default true,
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.products (store_id);
create index on public.products (category_id);

-- Custo fica em tabela separada: NUNCA é exposto no cardápio público.
create table public.product_costs (
  product_id  uuid primary key references public.products(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  cost_cents  integer not null default 0 check (cost_cents between 0 and 10000000),
  updated_at  timestamptz not null default now()
);
create index on public.product_costs (store_id);

create table public.product_addons (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  product_id    uuid not null references public.products(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  price_cents   integer not null default 0 check (price_cents between 0 and 1000000),
  is_available  boolean not null default true,
  position      integer not null default 0
);
create index on public.product_addons (product_id);
create index on public.product_addons (store_id);

-- ---------------------------------------------------------------------
-- Cupons
create table public.coupons (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores(id) on delete cascade,
  code             text not null check (code ~ '^[A-Z0-9]{3,20}$'),
  type             public.coupon_type not null,
  value            integer not null default 0 check (value >= 0),
  min_order_cents  integer not null default 0 check (min_order_cents >= 0),
  max_uses         integer check (max_uses is null or max_uses > 0),
  uses_count       integer not null default 0 check (uses_count >= 0),
  starts_at        timestamptz,
  ends_at          timestamptz,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (store_id, code),
  check (type <> 'percent' or value between 1 and 100),
  check (type <> 'fixed'   or value > 0)
);

-- ---------------------------------------------------------------------
-- Clientes (por loja — a base é do restaurante)
create table public.customers (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 80),
  phone              text not null check (phone ~ '^[0-9]{10,13}$' or phone like 'anon-%'),
  marketing_opt_in   boolean not null default false,
  orders_count       integer not null default 0,
  total_spent_cents  bigint  not null default 0,
  last_order_at      timestamptz,
  anonymized_at      timestamptz,
  created_at         timestamptz not null default now(),
  unique (store_id, phone)
);

-- ---------------------------------------------------------------------
-- Pedidos
create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores(id) on delete restrict,
  number              integer not null,
  public_token        uuid not null unique default gen_random_uuid(), -- link de acompanhamento do cliente
  customer_id         uuid references public.customers(id) on delete set null,
  customer_name       text not null,
  customer_phone      text not null,
  delivery_address    text check (char_length(delivery_address) <= 300),
  mode                public.order_mode not null,
  status              public.order_status not null,
  payment_method      public.payment_method not null,
  payment_status      public.payment_status not null,
  coupon_id           uuid references public.coupons(id) on delete set null,
  coupon_code         text,
  subtotal_cents      integer not null check (subtotal_cents >= 0),
  discount_cents      integer not null default 0 check (discount_cents >= 0),
  delivery_fee_cents  integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents         integer not null check (total_cents >= 0),
  change_for_cents    integer check (change_for_cents is null or change_for_cents >= 0),
  notes               text check (char_length(notes) <= 300),
  refund_required     boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (store_id, number),
  check (total_cents = subtotal_cents - discount_cents + delivery_fee_cents),
  check (mode = 'pickup' or delivery_address is not null)
);
create index on public.orders (store_id, created_at desc);
create index on public.orders (store_id, status);
create index on public.orders (customer_id);
create index on public.orders (coupon_id);

create table public.order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id) on delete cascade,
  store_id          uuid not null references public.stores(id) on delete restrict,
  product_id        uuid references public.products(id) on delete set null,
  product_name      text not null,
  unit_price_cents  integer not null check (unit_price_cents >= 0), -- preço + adicionais
  unit_cost_cents   integer not null default 0,                     -- custo na data (relatório de lucro)
  quantity          integer not null check (quantity between 1 and 50),
  addons            jsonb not null default '[]'::jsonb,
  notes             text check (char_length(notes) <= 200),
  line_total_cents  integer not null check (line_total_cents = unit_price_cents * quantity)
);
create index on public.order_items (order_id);
create index on public.order_items (store_id);
create index on public.order_items (product_id);

create table public.order_status_history (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  from_status  public.order_status,
  to_status    public.order_status not null,
  changed_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index on public.order_status_history (order_id);
create index on public.order_status_history (store_id);
create index on public.order_status_history (changed_by);

-- ---------------------------------------------------------------------
-- Pagamentos (escritos SOMENTE pelo backend / webhook do gateway)
create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete restrict,
  store_id             uuid not null references public.stores(id) on delete restrict,
  provider             text not null,             -- 'asaas', 'mercadopago', 'mock'...
  provider_payment_id  text not null,
  method               public.payment_method not null,
  amount_cents         integer not null check (amount_cents > 0),
  status               public.payment_status not null default 'pending',
  pix_copy_paste       text,
  expires_at           timestamptz,
  paid_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create index on public.payments (order_id);
create index on public.payments (store_id);

-- Idempotência de webhooks: o mesmo evento nunca é processado duas vezes
create table public.payment_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  event_id      text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);

-- ---------------------------------------------------------------------
-- Auditoria (quem mudou o quê e quando)
create table public.audit_log (
  id          bigint generated always as identity primary key,
  store_id    uuid,
  actor_id    uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index on public.audit_log (store_id, created_at desc);

-- Limite de requisições (anti-spam de pedidos)
create table public.rate_limits (
  key           text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (key, window_start)
);
