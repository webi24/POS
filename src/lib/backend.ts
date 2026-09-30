/**
 * Supabase backend wiring without extra dependencies.
 *
 * - Owner auth (email + password) uses Supabase's REST auth endpoints.
 * - The sync adapter attaches the owner's JWT so the Edge Function (and
 *   Postgres RLS beneath it) can scope every write to the right business.
 * - The M-Pesa proxy points at the deployed `mpesa` Edge Function.
 *
 * Env vars (see .env.example):
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 *   MPESA_PASSKEY          (Supabase edge function secret, never client-side)
 */

import type { SyncConflict } from './posStore'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''

export const backendEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

export const mpesaProxyUrl = backendEnabled
  ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/mpesa`
  : ''

// --- Minimal JWT session handling (no sdk dependency) ----------------------

type Session = {
  access_token: string
  refresh_token: string
  expires_at: number
}

const SESSION_KEY = 'pos-supabase-session'

export function getStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

async function refreshSession(session: Session): Promise<Session | null> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as Session
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    return data
  } catch {
    return null
  }
}

export async function getValidAccessToken(): Promise<string | null> {
  const session = getStoredSession()
  if (!session) return null
  if (session.expires_at - 30 > Math.floor(Date.now() / 1000)) {
    return session.access_token
  }
  const refreshed = await refreshSession(session)
  return refreshed?.access_token ?? null
}

export async function signInOwner(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ email, password }),
    })

    const data = await response.json()
    if (!response.ok) {
      return { ok: false, error: data.error_description ?? data.msg ?? 'Sign-in failed' }
    }

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
      }),
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' }
  }
}

export async function signUpOwner(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ email, password }),
    })

    const data = await response.json()
    if (!response.ok) {
      return { ok: false, error: data.msg ?? 'Sign-up failed' }
    }

    if (data.access_token) {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
        }),
      )
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' }
  }
}

export async function signOutOwner(): Promise<void> {
  const session = getStoredSession()
  clearStoredSession()
  if (!session) return
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    })
  } catch {
    // Local sign-out always succeeds; remote failure is non-fatal.
  }
}

// --- Owner's businesses (multi-business support) ---------------------------

export type MyBusiness = {
  id: string
  name: string
  type: string
  role: string
}

/**
 * Lists every business linked to the signed-in owner via owner_businesses.
 * RLS scopes the result server-side: an owner can only ever see their own
 * memberships, never a global list.
 */
export async function fetchMyBusinesses(): Promise<
  { businesses: MyBusiness[] } | { error: string }
> {
  if (!backendEnabled) return { error: 'Backend not configured' }
  const token = await getValidAccessToken()
  if (!token) return { error: 'Sign in first' }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/owner_businesses?select=business_id,role,businesses(id,name,type)`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
      },
    )
    if (!response.ok) return { error: `Server returned ${response.status}` }
    const rows = (await response.json()) as Array<{
      business_id: string
      role: string
      businesses: { id: string; name: string; type: string } | null
    }>
    const businesses: MyBusiness[] = []
    for (const row of rows) {
      if (row.businesses) {
        businesses.push({
          id: row.businesses.id,
          name: row.businesses.name,
          type: row.businesses.type,
          role: row.role,
        })
      }
    }
    return { businesses }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Network error' }
  }
}

// --- M-Pesa credential management (secrets never stored client-side) -------

export type MpesaStatusInfo = {
  configured: boolean   /** e.g. "••••abcd" (the server returns only a masked tail, never the value). */
  maskedSecret?: string
  shortCode?: string
}

/**
 * Submits Daraja credentials once over HTTPS. The browser forgets them
 * immediately: no state, no localStorage, no IndexedDB. The Edge Function
 * stores them server-side with the service role; clients can never read
 * them back (column-level revoke in the migration).
 */
export async function setupMpesaCredentials(
  businessId: string,
  credentials: { shortCode: string; consumerKey: string; consumerSecret: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!backendEnabled) return { ok: false, error: 'Backend not configured' }
  const token = await getValidAccessToken()
  if (!token) return { ok: false, error: 'Sign in as owner first' }

  try {
    const response = await fetch(`${mpesaProxyUrl}?action=set-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ businessId, ...credentials }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      return { ok: false, error: data.error ?? `Server returned ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' }
  }
}

/** Owner-facing status: configured flag + masked tail only. */
export async function getMpesaStatus(businessId: string): Promise<MpesaStatusInfo> {
  if (!backendEnabled) return { configured: false }
  const token = await getValidAccessToken()
  if (!token) return { configured: false }

  try {
    const response = await fetch(`${mpesaProxyUrl}?action=get-credentials&businessId=${encodeURIComponent(businessId)}`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    })
    if (!response.ok) return { configured: false }
    const data = (await response.json()) as MpesaStatusInfo
    return { configured: Boolean(data.configured), maskedSecret: data.maskedSecret, shortCode: data.shortCode }
  } catch {
    return { configured: false }
  }
}

/**
 * Local-only helper for masked UI hints without a backend.
 * Never receives the secret itself; pass the tail you want shown.
 */
export function maskMpesaSecret(secretTail: string): string {
  return `••••${secretTail.slice(-4)}`
}

// --- Owner-scoped business creation (server-authoritative) -----------------

export type CreateBusinessResult =
  | { ok: true; businessId: string }
  | { ok: false; error: string }

/**
 * Creates a business row on the server and links it to the authenticated
 * owner via the profiles table. The client mirror is created separately so
 * offline mode still works; the server row is the source of truth.
 */
export async function createBusinessOnServer(
  name: string,
  type: string,
  shortCode?: string,
): Promise<CreateBusinessResult> {
  if (!backendEnabled) return { ok: false, error: 'Backend not configured' }
  const token = await getValidAccessToken()
  if (!token) return { ok: false, error: 'Sign in as owner first' }

  try {
    const response = await fetch(`${mpesaProxyUrl}?action=create-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ name, type, shortCode }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      return { ok: false, error: data.error ?? `Server returned ${response.status}` }
    }
    return { ok: true, businessId: data.businessId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' }
  }
}

// --- eTIMS (Section 4): signing is server-side only ------------------------

export type EtimsSignResult =
  | { ok: true; etims: { status: string; invcNo?: number; controlNumber?: string; rcptSign?: string; signedAt?: string } }
  | { ok: false; error: string }

/**
 * Asks the Edge Function to fiscalise one sale. The browser never sees the
 * eTIMS cmcKey (same rule as the Daraja consumer secret).
 */
export async function signSaleWithEtims(
  businessId: string,
  saleId: string,
): Promise<EtimsSignResult> {
  if (!backendEnabled) return { ok: false, error: 'Backend not configured' }
  const token = await getValidAccessToken()
  if (!token) return { ok: false, error: 'Sign in as owner first' }

  try {
    const response = await fetch(`${mpesaProxyUrl}?action=etims-sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ businessId, saleId }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      return { ok: false, error: data.error ?? `Server returned ${response.status}` }
    }
    return { ok: true, etims: data.etims }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Network error' }
  }
}

// --- Backup / restore (Section 7) ------------------------------------------

export type RestorePayload = {
  business: {
    id: string
    name: string
    type: string
    mpesaShortCode?: string
    kraPin?: string
    etimsBhfId?: string
    etimsDeviceSerial?: string
    vatRate?: number
    startingCapital?: number
  }
  products: unknown[]
  customers: unknown[]
  staff: unknown[]
  sales: unknown[]
  stockAdjustments: unknown[]
  auditTrail: unknown[]
  expenses?: unknown[]
  capitalInjections?: unknown[]
  refunds?: unknown[]
}

/**
 * Pulls the full dataset for one owned business from the backend.
 * Used when an owner logs in on a new/lost device: local storage is empty,
 * so the backend is authoritative for that first load.
 */
export async function restoreBusinessData(businessId: string): Promise<RestorePayload | { error: string }> {
  if (!backendEnabled) return { error: 'Backend not configured' }
  const token = await getValidAccessToken()
  if (!token) return { error: 'Sign in as owner first' }

  try {
    const response = await fetch(`${mpesaProxyUrl}?action=restore&businessId=${encodeURIComponent(businessId)}`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      return { error: data.error ?? `Server returned ${response.status}` }
    }
    return data as RestorePayload
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Network error' }
  }
}

// --- Authenticated sync adapter --------------------------------------------

export type SyncPushReport = {
  syncedIds: string[]
  failedIds: string[]
  conflicts: Array<{ id: string; conflicts: SyncConflict[] }>
  error?: string
}

/**
 * Pushes a batch of queue items to the sync Edge Function with the owner's
 * JWT attached. Session-expired counts as "not yet" (items stay pending and
 * retry later) rather than a hard failure, so nothing is ever dropped.
 */
export async function authenticatedPush(items: unknown[]): Promise<SyncPushReport> {
  if (!backendEnabled) {
    return { syncedIds: [], failedIds: [], conflicts: [], error: 'Backend not configured' }
  }

  const token = await getValidAccessToken()
  if (!token) {
    return { syncedIds: [], failedIds: [], conflicts: [], error: 'Waiting for owner sign-in' }
  }

  try {
    const endpoint = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/mpesa?action=sync`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ items }),
    })

    if (!response.ok) {
      return {
        syncedIds: [],
        failedIds: items.map((item) => (item as { id: string }).id),
        conflicts: [],
        error: `Sync endpoint returned ${response.status}`,
      }
    }

    return (await response.json()) as SyncPushReport
  } catch (error) {
    return {
      syncedIds: [],
      failedIds: [],
      conflicts: [],
      error: error instanceof Error ? error.message : 'Network error during sync',
    }
  }
}
