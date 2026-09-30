-- ============================================================================
-- Kenya POS, owner finance dashboard (expenses, capital, refunds)
-- All tables carry business_id and follow the same RLS isolation pattern:
-- the database refuses cross-business reads even if application code errs.
-- Ids are text because client-generated ids are prefixed strings.
-- ============================================================================

create table if not exists public.expenses (
  id text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  category text not null check (category in ('rent', 'wages', 'utilities', 'transport', 'restock', 'other')),
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.capital_injections (
  id text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  date date not null,
  created_at timestamptz not null default now()
);

create table if not exists public.refunds (
  id text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  sale_id uuid,
  product_id uuid,
  quantity numeric(12, 3) not null default 0,
  amount numeric(12, 2) not null check (amount > 0),
  reason text,
  created_at timestamptz not null default now()
);

-- Starting capital lives on the business row (single value, owner-editable).
alter table public.businesses add column if not exists starting_capital numeric(12, 2) not null default 0;

-- Refunded sales keep their ledger row; refunded_at marks them out of revenue.
alter table public.sales add column if not exists refunded_at timestamptz;

alter table public.expenses enable row level security;
alter table public.capital_injections enable row level security;
alter table public.refunds enable row level security;

drop policy if exists "own expenses" on public.expenses;
create policy "own expenses" on public.expenses
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own capital injections" on public.capital_injections;
create policy "own capital injections" on public.capital_injections
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

drop policy if exists "own refunds" on public.refunds;
create policy "own refunds" on public.refunds
  for all using (business_id = public.auth_business_id()) with check (business_id = public.auth_business_id());

create index if not exists expenses_business_idx on public.expenses (business_id, date);
create index if not exists capital_injections_business_idx on public.capital_injections (business_id);
create index if not exists refunds_business_idx on public.refunds (business_id, created_at desc);
