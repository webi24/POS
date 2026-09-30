// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: M-Pesa Daraja proxy + sync ingest.
// Deploy: supabase functions deploy mpesa --no-verify-jwt=false
//
// Daraja credentials are read server-side from the businesses table using the
// service role; they never reach the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MPESA_BASE_URL = 'https://api.safaricom.co.ke' // production
// const MPESA_BASE_URL = 'https://sandbox.safaricom.co.ke' // sandbox

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function serverClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // bypasses RLS (server-side only)
  )
}

function userClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get('Authorization') ?? ''
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
}

async function getBusinessCredentials(businessId: string) {
  const supabase = serverClient()
  const { data, error } = await supabase
    .from('businesses')
    .select('mpesa_short_code, mpesa_consumer_key, mpesa_consumer_secret')
    .eq('id', businessId)
    .single()

  if (error || !data) return null
  return data
}

async function getDarajaToken(creds: { consumer_key: string; consumer_secret: string }): Promise<string> {
  const auth = btoa(`${creds.consumer_key}:${creds.consumer_secret}`)
  const response = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  })
  if (!response.ok) throw new Error(`Daraja auth failed (${response.status})`)
  const data = await response.json()
  return data.access_token
}

// ---------------------------------------------------------------------------
// POST /stkpush  { businessId, phone, amount, reference, description? }
// ---------------------------------------------------------------------------

async function handleStkPush(req: Request): Promise<Response> {
  const supabase = userClient(req)
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return json({ error: 'Not signed in' }, 401)

  const body = await req.json()
  const { businessId, phone, amount, reference, description } = body

  // The caller must belong to the business they are pushing for (RLS would
  // also block this read, but we fail with a clear error).
  const creds = await getBusinessCredentials(businessId)
  if (!creds) return json({ error: 'Unknown business or missing M-Pesa setup' }, 404)

  const callbackUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/mpesa/callback`
  const timestamp = formatDarajaTimestamp(new Date())
  const password = btoa(`${creds.mpesa_short_code}:${Deno.env.get('MPESA_PASSKEY')}:${timestamp}`)

  const token = await getDarajaToken({
    consumer_key: creds.mpesa_consumer_key,
    consumer_secret: creds.mpesa_consumer_secret,
  })

  const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: creds.mpesa_short_code,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: creds.mpesa_short_code,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: String(reference).slice(0, 12),
      TransactionDesc: String(description ?? 'POS sale').slice(0, 20),
    }),
  })

  const data = await response.json()
  if (!response.ok || data.responseCode !== '0') {
    return json({ responseCode: '1', responseDescription: data.errorMessage ?? 'Daraja rejected the push' }, 200)
  }

  // Record the push so the callback and status polling can find it.
  const server = serverClient()
  await server.from('mpesa_requests').upsert({
    checkout_request_id: data.CheckoutRequestID,
    business_id: businessId,
    phone,
    amount,
    status: 'pending',
  })

  return json({
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    responseCode: data.responseCode,
  })
}

// ---------------------------------------------------------------------------// POST /callback  (Daraja posts the payment result here)
// ---------------------------------------------------------------------------

async function handleCallback(req: Request): Promise<Response> {
  const body = await req.json()
  const stk = body?.Body?.stkCallback
  if (!stk) return json({ ResultCode: 0, ResultDesc: 'ignored' })

  const receipt = stk.CallbackMetadata?.Item?.find(
    (entry: any) => entry.Name === 'MpesaReceiptNumber',
  )?.Value

  const server = serverClient()
  await server
    .from('mpesa_requests')
    .update({
      status: stk.ResultCode === 0 ? 'confirmed' : 'failed',
      mpesa_receipt: receipt ?? null,
      result_code: String(stk.ResultCode),
      result_desc: stk.ResultDesc,
      updated_at: new Date().toISOString(),
    })
    .eq('checkout_request_id', stk.CheckoutRequestID)

  // Daraja expects a 200 acknowledgement.
  return json({ ResultCode: 0, ResultDesc: 'Accepted' })
}

// ---------------------------------------------------------------------------
// POST /set-credentials  { businessId, shortCode, consumerKey, consumerSecret }
// Owner-only. Stores Daraja secrets server-side; never returns them.
// ---------------------------------------------------------------------------

async function requireOwnerBusiness(req: Request, businessId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = userClient(req)
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return { ok: false, error: 'Not signed in' }
  // owner_businesses links each auth user to every business they own; the
  // server, not the UI, decides who owns what (multi-business, Section 2).
  const server = serverClient()
  const { data: membership, error } = await server
    .from('owner_businesses')
    .select('role')
    .eq('owner_id', auth.user.id)
    .eq('business_id', businessId)
    .maybeSingle()

  if (error || !membership) return { ok: false, error: 'You do not own this business' }
  if (membership.role !== 'owner') return { ok: false, error: 'Owner role required' }

  return { ok: true }
}

async function handleSetCredentials(req: Request): Promise<Response> {
  const body = await req.json()
  const { businessId, shortCode, consumerKey, consumerSecret } = body

  const ownerCheck = await requireOwnerBusiness(req, businessId)
 
  if (!ownerCheck.ok) return json({ error: ownerCheck.error }, 403)
  if (!shortCode || !consumerKey || !consumerSecret) {
    return json({ error: 'shortCode, consumerKey and consumerSecret are required' }, 400)
  }

  const server = serverClient()
  const { error } = await server
    .from('businesses')
    .update({
      mpesa_short_code: shortCode,
      mpesa_consumer_key: consumerKey,
      mpesa_consumer_secret: consumerSecret,
    })
    .eq('id', businessId)

  if (error) return json({ error: error.message }, 500)

  // Response carries no secret material.
  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// GET /get-credentials?businessId=...
// Owner-only. Returns configured flag + masked tail only (never the secret).
// ---------------------------------------------------------------------------

async function handleGetCredentials(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('businessId')
  if (!businessId) return json({ error: 'Missing businessId' }, 400)

  const ownerCheck = await requireOwnerBusiness(req, businessId)
  if (!ownerCheck.ok) return json({ error: ownerCheck.error }, 403)

  const { data } = await serverClient()
    .from('businesses')
    .select('mpesa_consumer_secret, mpesa_short_code')
    .eq('id', businessId)
    .single()

  if (!data) return json({ error: 'Business not found' }, 404)

  const secret = data.mpesa_consumer_secret as string | null
  return json({
    configured: Boolean(secret && secret.length > 0),
    maskedSecret: secret ? `••••${secret.slice(-4)}` : undefined,
    shortCode: data.mpesa_short_code ?? undefined,
  })
}

// ---------------------------------------------------------------------------
// POST /create-business  { name, type, shortCode? }
// Auth-only (any signed-in user). Creates the row + owner profile in one go.
// ---------------------------------------------------------------------------

async function handleCreateBusiness(req: Request): Promise<Response> {
  const supabase = userClient(req)
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return json({ error: 'Sign in first' }, 401)

  const body = await req.json()
  const { name, type, shortCode } = body
  if (!name || !type) return json({ error: 'name and type are required' }, 400)

  const server = serverClient()
  const businessId = crypto.randomUUID()

  const { error: bizError } = await server.from('businesses').upsert({
    id: businessId,
    name,
    type,
    mpesa_short_code: shortCode ?? null,
  })
  if (bizError) return json({ error: bizError.message }, 500)

  // Keep profiles as the last-selected hint; membership is authoritative.
  await server.from('profiles').upsert({
    id: auth.user.id,
    business_id: businessId,
    role: 'owner',
    full_name: body.fullName ?? null,
    phone_number: body.phoneNumber ?? null,
  })

  // Section 2: every owned business gets a membership row.
  const { error: memberError } = await server.from('owner_businesses').upsert({
    owner_id: auth.user.id,
    business_id: businessId,
    role: 'owner',
  })
  if (memberError) return json({ error: memberError.message }, 500)

  return json({ businessId })
}

// ---------------------------------------------------------------------------
// GET /restore?businessId=...
// Owner-only. Full dataset pull for a new/lost device (Section 7).
// ---------------------------------------------------------------------------

async function handleRestore(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('businessId')
  if (!businessId) return json({ error: 'Missing businessId' }, 400)

  const ownerCheck = await requireOwnerBusiness(req, businessId)
  if (!ownerCheck.ok) return json({ error: ownerCheck.error }, 403)

  const server = serverClient()
  const [businesses, products, customers, staff, sales, stockAdjustments, auditTrail, expenses, capitalInjections, refunds] =
    await Promise.all([
      server.from('businesses').select('*').eq('id', businessId).single(),
      server.from('products').select('*').eq('business_id', businessId),
      server.from('customers').select('*').eq('business_id', businessId),
      server.from('staff').select('*').eq('business_id', businessId),
      server.from('sales').select('*').eq('business_id', businessId).order('created_at', { ascending: false }).limit(5000),
      server.from('stock_adjustments').select('*').eq('business_id', businessId).limit(5000),
      server.from('audit_trail').select('*').eq('business_id', businessId).order('at', { ascending: false }).limit(5000),
      server.from('expenses').select('*').eq('business_id', businessId).limit(5000),
      server.from('capital_injections').select('*').eq('business_id', businessId).limit(5000),
      server.from('refunds').select('*').eq('business_id', businessId).limit(5000),
    ])

  if (businesses.error || !businesses.data) {
    return json({ error: 'Business not found' }, 404)
  }

  const biz = businesses.data
  // Secrets (Daraja, eTIMS cmcKey) never leave the server.
  return json({
    business: {
      id: biz.id,
      name: biz.name,
      type: biz.type,
      mpesaShortCode: biz.mpesa_short_code ?? undefined,
      kraPin: biz.kra_pin ?? undefined,
      etimsBhfId: biz.etims_bhf_id ?? undefined,
      etimsDeviceSerial: biz.etims_device_serial ?? undefined,
      vatRate: biz.vat_rate ?? undefined,
      startingCapital: biz.starting_capital != null ? Number(biz.starting_capital) : undefined,
    },
    products: (products.data ?? []).map((row: any) => ({
      id: row.id, businessId, name: row.name, category: row.category,
      price: Number(row.price), costPrice: Number(row.cost_price),
      stockQuantity: Number(row.stock_quantity), unitOfMeasure: row.unit_of_measure,
      expiryDate: row.expiry_date ?? undefined, batchNumber: row.batch_number ?? undefined,
      restrictedItem: row.restricted_item, lowStockAlert: Number(row.low_stock_alert),
    })),
    customers: (customers.data ?? []).map((row: any) => ({
      id: row.id, businessId, name: row.name, phone: row.phone ?? undefined,
      balance: Number(row.balance),
    })),
    staff: (staff.data ?? []).map((row: any) => ({
      id: row.id, businessId, name: row.name, pin: row.pin, shift: row.shift,
    })),
    sales: (sales.data ?? []).map((row: any) => ({
      id: row.id, businessId, items: row.items, payments: row.payments,
      customerId: row.customer_id ?? undefined, total: Number(row.total),
      createdAt: row.created_at, attendantId: row.attendant_id ?? undefined,
      mpesaStatus: row.mpesa_status ?? undefined, mpesaReceipt: row.mpesa_receipt ?? undefined,
      etims: row.etims ?? undefined,
    })),
    stockAdjustments: (stockAdjustments.data ?? []).map((row: any) => ({
      id: row.id, businessId, productId: row.product_id, reason: row.reason,
      quantityDelta: Number(row.quantity_delta), createdAt: row.created_at,
    })),
    auditTrail: (auditTrail.data ?? []).map((row: any) => ({
      id: row.id, businessId, at: row.at, actorId: row.actor_id ?? undefined,
      actorName: row.actor_name, actorRole: row.actor_role, action: row.action,
      productId: row.product_id ?? undefined, productName: row.product_name ?? undefined,
      before: row.before_value != null ? Number(row.before_value) : undefined,
      after: row.after_value != null ? Number(row.after_value) : undefined,
      detail: row.detail ?? undefined,
    })),
    expenses: (expenses.data ?? []).map((row: any) => ({
      id: row.id, businessId, category: row.category, amount: Number(row.amount),
      note: row.note ?? undefined, date: row.date, createdAt: row.created_at,
    })),
    capitalInjections: (capitalInjections.data ?? []).map((row: any) => ({
      id: row.id, businessId, amount: Number(row.amount),
      note: row.note ?? undefined, date: row.date, createdAt: row.created_at,
    })),
    refunds: (refunds.data ?? []).map((row: any) => ({
      id: row.id, businessId, saleId: row.sale_id ?? undefined,
      productId: row.product_id ?? undefined, quantity: Number(row.quantity),
      amount: Number(row.amount), reason: row.reason ?? undefined, createdAt: row.created_at,
    })),
  })
}

// ---------------------------------------------------------------------------
// POST /etims-sign  { businessId, saleId }
// Owner/staff-verified. Signs one sale with KRA eTIMS (OSCU channel):
//   1. device init -> cmcKey (cached server-side, never sent to the client)
//   2. POST /saveTrnsSalesOsdc with the invoice payload
//   3. store invcNo, control number + receipt signature against the sale
// ---------------------------------------------------------------------------

const ETIMS_BASE_URL = Deno.env.get('ETIMS_BASE_URL') ?? 'https://etims-api-sbx.kra.go.ke'

async function getEtimsCmcKey(creds: {
  kraPin: string
  deviceSerial: string
  cmcKey?: string | null
}): Promise<string> {
  // The API returns a fresh cmcKey on login; always refresh as it rotates.
  const response = await fetch(`${ETIMS_BASE_URL}/etims/api/v1/deviceInfo/selectInitInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tin: creds.kraPin,
      bhfId: '00',
      idVoucNum: '0',
      serialNum: creds.deviceSerial,
    }),
  })
  if (!response.ok) throw new Error(`eTIMS device init failed (${response.status})`)
  const data = await response.json()
  const cmcKey = data?.data?.cmcKey
  if (!cmcKey) throw new Error('eTIMS device init returned no cmcKey')
  return cmcKey
}

async function handleEtimsSign(req: Request): Promise<Response> {
  const body = await req.json()
  const { businessId, saleId } = body
  if (!businessId || !saleId) return json({ error: 'businessId and saleId are required' }, 400)

  const ownerCheck = await requireOwnerBusiness(req, businessId)
  if (!ownerCheck.ok) return json({ error: ownerCheck.error }, 403)

  const server = serverClient()
  const { data: business } = await server
    .from('businesses')
    .select('kra_pin, etims_bhf_id, etims_device_serial, etims_cmc_key, vat_rate')
    .eq('id', businessId)
    .single()
  if (!business?.kra_pin || !business?.etims_device_serial) {
    return json({ error: 'eTIMS is not set up for this business' }, 400)
  }

  const { data: sale } = await server
    .from('sales')
    .select('id, items, payments, total, created_at, etims')
    .eq('id', saleId)
    .eq('business_id', businessId)
    .single()
  if (!sale) return json({ error: 'Sale not found' }, 404)
  if (sale.etims?.status === 'signed') return json({ ok: true, alreadySigned: true, etims: sale.etims })

  // Monotonic invoice number: highest signed + 1, no gaps.
  const { data: lastSigned } = await server
    .from('sales')
    .select('etims')
    .eq('business_id', businessId)
    .not('etims->invcNo', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50)
  const invcNo =
    (lastSigned ?? []).reduce(
      (max: number, row: any) => Math.max(max, Number(row.etims?.invcNo ?? 0)),
      0,
    ) + 1

  const cmcKey = await getEtimsCmcKey({
    kraPin: business.kra_pin,
    deviceSerial: business.etims_device_serial,
    cmcKey: business.etims_cmc_key,
  })

  const timestamp = String(sale.created_at).replace(/\D/g, '').slice(0, 14)
  const vatRate = Number(business.vat_rate ?? 16)
  const items = (sale.items ?? []) as Array<{ productId: string; quantity: number; unitPrice: number }>
  const total = Number(sale.total)
  const taxable = Math.round((total / (1 + vatRate / 100)) * 100) / 100
  const taxAmount = Math.round((total - taxable) * 100) / 100

  const payload = {
    tin: business.kra_pin,
    bhfId: business.etims_bhf_id ?? '00',
    invcNo,
    orgInvcNo: 0,
    trdInvcNo: saleId,
    salesTyCd: 'N',
    rcptTyCd: 'S',
    pmtTyCd: Number((sale.payments as any)?.cash ?? 0) > 0 ? '01' : '02',
    salesSttsCd: '02',
    cfmDt: timestamp,
    salesDt: timestamp.slice(0, 8),
    totItemCnt: items.length,
    taxRtB: vatRate,
    taxblAmtB: taxable,
    taxAmtB: taxAmount,
    totTaxblAmt: taxable,
    totTaxAmt: taxAmount,
    totAmt: total,
    itemList: items.map((item, index) => {
      const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100
      const lineTaxable = Math.round((lineTotal / (1 + vatRate / 100)) * 100) / 100
      return {
        itemSeq: index + 1,
        itemCd: item.productId,
        itemNm: 'Item',
        qty: item.quantity,
        prc: item.unitPrice,
        splyAmt: lineTaxable,
        taxTyCd: 'B',
        taxblAmt: lineTaxable,
        taxAmt: Math.round((lineTotal - lineTaxable) * 100) / 100,
        totAmt: lineTotal,
      }
    }),
  }

  const response = await fetch(`${ETIMS_BASE_URL}/etims/api/v1/sales/saveTrnsSalesOsdc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cmcKey,
    },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok || data?.resultCd?.toString() !== '000') {
    const error = data?.resultMsg ?? `eTIMS rejected the invoice (${response.status})`
    await server.from('sales').update({ etims: { status: 'failed', error } }).eq('id', saleId)
    return json({ ok: false, error }, 200)
  }

  const etimsRecord = {
    status: 'signed',
    invcNo,
    controlNumber: data?.ctrlNo ?? undefined,
    rcptSign: data?.rcptSign ?? undefined,
    signedAt: new Date().toISOString(),
  }
  await server.from('sales').update({ etims: etimsRecord }).eq('id', saleId)
  return json({ ok: true, etims: etimsRecord })
}

async function handleStkStatus(req: Request): Promise<Response> {
  const supabase = userClient(req)
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return json({ status: 'failed', error: 'Not signed in' }, 401)

  const checkoutRequestId = new URL(req.url).searchParams.get('checkoutRequestId')
  if (!checkoutRequestId) return json({ status: 'failed', error: 'Missing id' }, 400)

  const { data } = await serverClient()
    .from('mpesa_requests')
    .select('status, mpesa_receipt')
    .eq('checkout_request_id', checkoutRequestId)
    .single()

  if (!data) return json({ status: 'pending', error: 'Unknown checkout request' })
  return json({ status: data.status, receipt: data.mpesa_receipt ?? undefined })
}

// ---------------------------------------------------------------------------// POST /sync  (batched, idempotent queue ingest)
// ---------------------------------------------------------------------------

async function handleSync(req: Request): Promise<Response> {
  const supabase = userClient(req)
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return json({ error: 'Not signed in' }, 401)

  const { items } = (await req.json()) as {
    items: Array<{ id: string; businessId: string; action: string; payload: unknown }>
  }

  const server = serverClient()
  const syncedIds: string[] = []
  const failedIds: string[] = []
  const conflicts: Array<{ id: string; conflicts: unknown[] }> = []

  for (const item of items ?? []) {
    try {
      // Idempotency: replays are absorbed by the sync_log primary key.
      const { error } = await server.from('sync_log').upsert(
        { id: item.id, business_id: item.businessId, action: item.action },
        { onConflict: 'id', ignoreDuplicates: true },
      )

      // ignoreDuplicates still succeeds silently; detect a true replay via select.
      if (error) throw error

      const { data: existing } = await server
        .from('sync_log')
        .select('id')
        .eq('id', item.id)
        .maybeSingle()

      const isReplay = Boolean(existing)

      if (!isReplay) {
        await applyItem(server, item)
      }
      syncedIds.push(item.id)
    } catch (error) {
      if (String(error?.message).includes('row-level security')) {
        conflicts.push({
          id: item.id,
          conflicts: [{ field: 'businessId', localValue: item.businessId, remoteValue: 'forbidden' }],
        })
      } else {
        failedIds.push(item.id)
      }
    }
  }

  return json({ syncedIds, failedIds, conflicts })
}

async function applyItem(server: any, item: { businessId: string; action: string; payload: any }): Promise<void> {
  const p = item.payload ?? {}
  switch (item.action) {
    case 'business-created':
      await server.from('businesses').upsert({
        id: p.businessId,
        name: p.name,
        type: p.type,
        mpesa_short_code: p.mpesaShortCode ?? null,
      })
      break
    case 'product-added':
    case 'product-bulk-added':
      if (p.productId) {
        await server.from('products').upsert({
          id: p.productId,
          business_id: item.businessId,
          name: p.name,
          category: p.category,
          price: p.price,
          cost_price: p.costPrice,
          stock_quantity: p.stockQuantity,
          unit_of_measure: p.unitOfMeasure,
          expiry_date: p.expiryDate ?? null,
          batch_number: p.batchNumber ?? null,
          restricted_item: p.restrictedItem ?? false,
          low_stock_alert: p.lowStockAlert ?? 0,
        })
      }
      break
    case 'product-updated':
      if (p.productId) {
        const { data: current } = await server
          .from('products')
          .select('price')
          .eq('id', p.productId)
          .eq('business_id', item.businessId)
          .single()
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
        if (p.price != null) update.price = p.price
        if (p.stockQuantity != null) update.stock_quantity = p.stockQuantity
        await server.from('products').update(update).eq('id', p.productId).eq('business_id', item.businessId)
        // Conflict visibility: if the server price moved since we last pushed,
        // record it in audit trail so the owner can trace the change.
        if (current && p.price != null && Number(current.price) !== p.price) {
          await server.from('audit_trail').insert({
            business_id: item.businessId,
            actor_name: 'sync',
            actor_role: 'unknown',
            action: 'price-changed',
            product_id: p.productId,
            before_value: Number(current.price),
            after_value: p.price,
            detail: 'server price differed at sync time',
          })
        }
      }
      break
    case 'customer-added':
      if (p.customerId) {
        await server.from('customers').upsert({ id: p.customerId, business_id: item.businessId, name: p.name })
      }
      break
    case 'staff-added':
      if (p.staffId) {
        await server.from('staff').upsert({ id: p.staffId, business_id: item.businessId, name: p.name })
      }
      break
    case 'staff-removed':
      if (p.staffId) {
        await server.from('staff').delete().eq('id', p.staffId).eq('business_id', item.businessId)
      }
      break
    case 'sale-created':
      await server.from('sales').upsert({
        id: p.id,
        business_id: item.businessId,
        items: p.items,
        payments: p.payments,
        total: p.total,
        customer_id: p.customerId ?? null,
        attendant_id: p.attendantId ?? null,
        mpesa_status: p.mpesaStatus ?? null,
        mpesa_receipt: p.mpesaReceipt ?? null,
        created_at: p.createdAt,
      })
      break
    case 'stock-adjusted':
      await server.from('stock_adjustments').upsert({
        id: p.id,
        business_id: item.businessId,
        product_id: p.productId,
        reason: p.reason,
        quantity_delta: p.quantityDelta,
        created_at: p.createdAt,
      })
      // Keep the server stock level in step with offline adjustments.
      if (p.productId && p.quantityDelta) {
        const { data: product } = await server
          .from('products')
          .select('stock_quantity')
          .eq('id', p.productId)
          .eq('business_id', item.businessId)
          .single()
        if (product) {
          await server
            .from('products')
            .update({ stock_quantity: Number(product.stock_quantity) + Number(p.quantityDelta) })
            .eq('id', p.productId)
            .eq('business_id', item.businessId)
        }
      }
      break
    case 'audit-appended':
      await server.from('audit_trail').upsert({
        id: p.id,
        business_id: item.businessId,
        at: p.at,
        actor_id: p.actorId ?? null,
        actor_name: p.actorName,
        actor_role: p.actorRole ?? 'unknown',
        action: p.action,
        product_id: p.productId ?? null,
        product_name: p.productName ?? null,
        before_value: p.before ?? null,
        after_value: p.after ?? null,
        detail: p.detail ?? null,
      })
      break
    case 'etims-invoice':
      // Fiscalisation happens server-side only (cmcKey never leaves the box).
      // The push marks the sale as queued; the client triggers /etims-sign.
      if (p.saleId) {
        await server.from('sales').update({ etims: { status: 'queued' } }).eq('id', p.saleId)
      }
      break
    case 'expense-added':
      await server.from('expenses').upsert({
        id: p.id,
        business_id: item.businessId,
        category: p.category,
        amount: p.amount,
        note: p.note ?? null,
        date: p.date,
        created_at: p.createdAt,
      })
      break
    case 'capital-injection-added':
      await server.from('capital_injections').upsert({
        id: p.id,
        business_id: item.businessId,
        amount: p.amount,
        note: p.note ?? null,
        date: p.date,
        created_at: p.createdAt,
      })
      break
    case 'capital-set':
      await server
        .from('businesses')
        .update({ starting_capital: p.startingCapital ?? 0 })
        .eq('id', item.businessId)
      break
    case 'refund-added':
      await server.from('refunds').upsert({
        id: p.id,
        business_id: item.businessId,
        sale_id: p.saleId ?? null,
        product_id: p.productId ?? null,
        quantity: p.quantity ?? 0,
        amount: p.amount,
        reason: p.reason ?? null,
        created_at: p.createdAt,
      })
      // Mark the sale refunded so server-side revenue reporting agrees with
      // the device that processed the refund.
      if (p.saleId) {
        await server.from('sales').update({ refunded_at: new Date().toISOString() }).eq('id', p.saleId)
      }
      break
    case 'credit-repayment':
      // Balance reconciliation happens on next full pull; the log keeps order.
      break
    default:
      break // unknown actions are logged, never dropped
  }
}

// ---------------------------------------------------------------------------

function formatDarajaTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = new URL(req.url)
  const action = url.searchParams.get('action') ?? url.pathname.split('/').pop()

  try {
    if (req.method === 'POST' && action === 'stkpush') return await handleStkPush(req)
    if (req.method === 'POST' && action === 'callback') return await handleCallback(req)
    if (req.method === 'GET' && action === 'stkstatus') return await handleStkStatus(req)
    if (req.method === 'POST' && action === 'sync') return await handleSync(req)
    if (req.method === 'POST' && action === 'etims-sign') return await handleEtimsSign(req)
    if (req.method === 'GET' && action === 'restore') return await handleRestore(req)
    if (req.method === 'POST' && action === 'set-credentials') return await handleSetCredentials(req)
    if (req.method === 'GET' && action === 'get-credentials') return await handleGetCredentials(req)
    if (req.method === 'POST' && action === 'create-business') return await handleCreateBusiness(req)
    return json({ error: 'Unknown route' }, 404)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Function error' }, 500)
  }
})
