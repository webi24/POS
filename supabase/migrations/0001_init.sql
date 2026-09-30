-- ============================================================================
-- Kenya POS, multi-tenant schema with Row Level Security (V1)
-- Every table carries business_id. RLS makes cross-business reads impossible
-- even if application code has a bug: the database itself refuses the query.
-- ============================================================================

create extension if not exists "pgcrypto";

-- --- Identity --------------------------------------------------------------

-- One profile per auth user. Links a Supabase Auth user to their business.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  business_id uuid not null,
  role text not null default 'owner' check (role in ('owner', 'attendant')),
  created_at timestamptz not null default now()
);

-- Helper used by every policy: which business does the caller belong to?
create or replace function public.auth_business_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.business_id from public.profiles p where p.id = auth.uid()
$$;

-- --- Core tables -----------------------------------------------------------

create table if not exists public.businesses (
  id uuid primary key,
  name text not null,
  type text not null,
  -- Daraja credentials are tenant secrets: readable only via the service role
  -- (Edge Functions). Clients can set them at signup but never read them back.
  mpesa_short_code text,
  mpesa_consumer_key text,
  mpesa_consumer_secret text,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  category text not null default 'General',
  price numeric(12, 2) not null default 0,
  cost_price numeric(12, 2) not null default 0,
  stock_quantity numeric(12, 3) not null default 0,
  unit_of_measure text not null default 'piece',
  expiry_date date,
  batch_number text,
  restricted_item boolean not null default false,
  low_stock_alert numeric(12, 3) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  phone text,
  balance numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.staff (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  pin text not null,
  shift text not null default 'Morning',
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  payments jsonb not null default '{"cash":0,"mpesa":0,"credit":0}'::jsonb,
  customer_id uuid references public.customers (id),
  total numeric(12, 2) not null default 0,
  attendant_id uuid,
  mpesa_status text check (mpesa_status in ('pending', 'confirmed', 'manual', 'failed')),
  mpesa_receipt text,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_adjustments (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  reason text not null check (reason in ('damage', 'theft', 'expired', 'delivery', 'count-correction')),
  quantity_delta numeric(12, 3) not null,
  created_at timestamptz not null default now()
);

-- --- Idempotent sync -------------------------------------------------------

-- The sync queue's item ids land here. The unique primary key makes replays
-- harmless: ON CONFLICT DO NOTHING means a retried push never duplicates.
create table if not exists public.sync_log (
  id text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  action text not null,
  received_at timestamptz not null default now()
);

-- --- M-Pesa STK state (Edge Function managed) ------------------------------

create table if not exists public.mpesa_requests (
  checkout_request_id text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  sale_id uuid,
  phone text not null,
  amount numeric(12, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  mpesa_receipt text,
  result_code text,
  result_desc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.staff enable row level security;
alter table public.sales enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.sync_log enable row level security;
alter table public.mpesa_requests enable row level security;

-- Profiles: users see only their own row (needed to resolve business_id).
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for select using (id = auth.uid());
drop policy if exists "self signup profile" on public.profiles;
create policy "self signup profile" on public.profiles
  for insert with check (id = auth.uid());

-- Businesses: a user sees and maintains only their own business. The Daraja
-- secret columns are protected with column-level grants below.
drop policy if exists "own business" on public.businesses;
create policy "own business" on public.businesses
  for all using (id = public.auth_business_id()) with check (id = public.auth_business_id());

-- Data tables: full CRUD scoped to the caller's business.
drop policy if exists "own products" on public.products;
create policy "own products" on public.products
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own customers" on public.customers;
create policy "own customers" on public.customers
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own staff" on public.staff;
create policy "own staff" on public.staff
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own sales" on public.sales;
create policy "own sales" on public.sales
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own adjustments" on public.stock_adjustments;
create policy "own adjustments" on public.stock_adjustments
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own sync log" on public.sync_log;
create policy "own sync log" on public.sync_log
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

-- M-Pesa requests: clients may read their own push status; writes happen only
-- through the Edge Function (service role bypasses RLS).
drop policy if exists "own mpesa reads" on public.mpesa_requests;
create policy "own mpesa reads" on public.mpesa_requests
  for select using (business_id = public.auth_business_id());

-- Column-level protection: the anon/authenticated roles can never SELECT the
-- Daraja secret columns. Only the service role (Edge Functions) can.
revoke select (mpesa_consumer_key, mpesa_consumer_secret) on public.businesses from anon, authenticated;

-- Helpful indexes
create index if not exists products_business_idx on public.products (business_id);
create index if not exists sales_business_idx on public.sales (business_id, created_at desc);
create index if not exists customers_business_idx on public.customers (business_id);
create index if not exists stock_adjustments_business_idx on public.stock_adjustments (business_id);
