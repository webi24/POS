-- ============================================================================
-- Isolation verification, Kenya POS multi-tenant RLS
-- Run as Business B's owner (authenticated JWT) after creating two businesses.
-- Every query MUST return zero rows or an error. Any row returned is a FAIL.
-- ============================================================================

-- Setup used below: Business A (owner_a@test.co.ke) and Business B
-- (owner_b@test.co.ke), each with their own products/sales/customers/staff.

-- 1. Products -----------------------------------------------------------------
select * from public.products where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows (B cannot see A's products, or any foreign product)

-- 2. Sales --------------------------------------------------------------------
select * from public.sales where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows

-- 3. Customers ----------------------------------------------------------------
select * from public.customers where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows

-- 4. Staff --------------------------------------------------------------------
select * from public.staff where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows

-- 5. Stock adjustments ----------------------------------------------------------
select * from public.stock_adjustments where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows

-- 6. Cross-tenant write must be REJECTED (run as B; A's id hardcoded) ----------
insert into public.products (id, business_id, name, price, cost_price, stock_quantity, unit_of_measure, low_stock_alert)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'Injected', 1, 1, 1, 'piece', 0);
-- expect: error 42501 "new row violates row-level security policy"

-- 7. Daraja secrets must be unreadable by clients ------------------------------
select mpesa_consumer_key, mpesa_consumer_secret from public.businesses;
-- expect: error 42501 "permission denied" (column-level revoke), never a value

-- 8. M-Pesa request records scoped --------------------------------------------
select * from public.mpesa_requests where business_id <> (
  select business_id from public.profiles where id = auth.uid()
);
-- expect: 0 rows

-- 9. Owner-only Edge Function: caller without owner profile must fail ----------
-- (curl with B's JWT against another business's credentials endpoint)
-- curl -X POST "$SUPABASE_URL/functions/v1/mpesa?action=set-credentials" \
--   -H "Authorization: Bearer $B_JWT" -H "apikey: $ANON_KEY" \
--   -d '{"businessId":"<A_BUSINESS_ID>","shortCode":"1","consumerKey":"k","consumerSecret":"s"}'
-- expect: {"error":"You do not own this business"} with HTTP 403
