-- ============================================================================
-- Kenya POS, Sections 2/3/4/5
--   Section 2: one owner, many businesses (owner_businesses membership)
--   Section 3: phone-ready owner fields (phone_number), full name
--   Section 4: eTIMS columns on sales + server-only KRA cmcKey secret
--   Section 5: audit_trail table with RLS
-- ============================================================================

-- --- Section 3: owner profile fields (phone-ready, additive) ----------------

alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists phone_number text;

-- --- Section 2: one owner, many businesses ---------------------------------

create table if not exists public.owner_businesses (
  owner_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'attendant')),
  created_at timestamptz not null default now(),
  primary key (owner_id, business_id)
);

alter table public.owner_businesses enable row level security;

drop policy if exists "own memberships" on public.owner_businesses;
create policy "own memberships" on public.owner_businesses
  for select using (owner_id = auth.uid());

drop policy if exists "self manage memberships" on public.owner_businesses;
create policy "self manage memberships" on public.owner_businesses
  for insert with check (owner_id = auth.uid());

-- Backfill: every existing profile becomes a membership row so nothing breaks.
insert into public.owner_businesses (owner_id, business_id, role)
  select id, business_id, role from public.profiles
  on conflict do nothing;

-- Businesses are now visible through membership, not the single-business
-- profiles link. profiles.business_id remains as a UI "last selected" hint.
drop policy if exists "own business" on public.businesses;
create policy "member businesses" on public.businesses
  for all using (
    exists (
      select 1 from public.owner_businesses ob
      where ob.owner_id = auth.uid() and ob.business_id = id
    )
  )
  with check (
    exists (
      select 1 from public.owner_businesses ob
      where ob.owner_id = auth.uid() and ob.business_id = id
    )
  );

-- --- Section 5: audit trail -------------------------------------------------

create table if not exists public.audit_trail (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  at timestamptz not null default now(),
  actor_id text,
  actor_name text not null,
  actor_role text not null default 'unknown' check (actor_role in ('staff', 'owner', 'unknown')),
  action text not null check (action in ('stock-adjusted', 'price-changed')),
  product_id text,
  product_name text,
  before_value numeric(12, 3),
  after_value numeric(12, 3),
  detail text
);

alter table public.audit_trail enable row level security;

drop policy if exists "own audit trail" on public.audit_trail;
create policy "own audit trail" on public.audit_trail
  for all using (business_id = public.auth_business_id())
  with check (business_id = public.auth_business_id());

create index if not exists audit_trail_business_idx on public.audit_trail (business_id, at desc);

-- --- Section 4: eTIMS -------------------------------------------------------

-- Fiscalisation result stored against the sale.
alter table public.sales add column if not exists etims jsonb;

-- Non-secret eTIMS identifiers are safe to mirror on-device; the cmcKey
-- communication key is a tenant secret readable only by the service role.
alter table public.businesses add column if not exists kra_pin text;
alter table public.businesses add column if not exists etims_bhf_id text;
alter table public.businesses add column if not exists etims_device_serial text;
alter table public.businesses add column if not exists etims_cmc_key text;
alter table public.businesses add column if not exists vat_rate numeric(5, 2) default 16;

-- Clients may SET eTIMS identifiers but never read the cmcKey back.
revoke select (etims_cmc_key) on public.businesses from anon, authenticated;
