/**
 * M-Pesa Daraja client (browser side).
 *
 * Daraja credentials are tenant secrets and must never live in the browser.
 * Every call here goes through a server-side proxy (Supabase Edge Function in
 * production) which looks up the business's own credentials server-side.
 *
 * Expected proxy contract:
 *   POST {proxyUrl}/stkpush   { businessId, phone, amount, reference, description }
 *                             -> { checkoutRequestId, merchantRequestId, responseCode }
 *   GET  {proxyUrl}/stkstatus?checkoutRequestId=...
 *                             -> { status: 'pending'|'confirmed'|'failed', receipt? }
 *
 * Offline fallback: when the device has no connection, STK Push cannot work
 * (it needs Safaricom's servers). The attendant records the M-Pesa
 * confirmation code manually instead. The sale is still saved offline.
 */

export type StkPushRequest = {
  businessId: string
  phone: string
  amount: number
  reference: string
  description?: string
}

export type StkPushResult =
  | { ok: true; checkoutRequestId: string; merchantRequestId?: string }
  | { ok: false; error: string }

export type StkStatus = {
  status: 'pending' | 'confirmed' | 'failed'
  receipt?: string
  error?: string
}

/**
 * Normalises Kenyan phone numbers to the 2547XXXXXXXX / 2541XXXXXXXX format
 * Daraja expects. Accepts 07.., 01.., +254.., 254.. with optional spaces.
 */
export function normalizeKenyanPhone(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+/, '')

  if (/^0(7|1)\d{8}$/.test(digits)) {
    return `254${digits.slice(1)}`
  }
  if (/^254(7|1)\d{8}$/.test(digits)) {
    return digits
  }
  return null
}

/**
 * Pretty-prints a normalized 2547XXXXXXXX number as 07XX XXX XXX for display.
 * Falls back to the raw input when it cannot be parsed.
 */
export function formatKenyanPhone(raw: string): string {
  const normalized = normalizeKenyanPhone(raw)
  if (!normalized) return raw
  const local = `0${normalized.slice(3)}`
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
}

/** Safaricom confirmation codes are 10 alphanumeric characters (e.g. QGH7XYZ12K). */
export function isValidMpesaReceipt(code: string): boolean {
  return /^[A-Z0-9]{10}$/.test(code.trim().toUpperCase())
}

/** STK Push amounts must be whole shillings. */
export function isValidMpesaAmount(amount: number): boolean {
  return Number.isFinite(amount) && Number.isInteger(amount) && amount > 0
}

export function createMpesaClient(
  proxyUrl: string,
  fetchImpl: typeof fetch = fetch,
): {
  stkPush: (request: StkPushRequest) => Promise<StkPushResult>
  stkStatus: (checkoutRequestId: string) => Promise<StkStatus>
} {
  return {
    async stkPush(request) {
      const phone = normalizeKenyanPhone(request.phone)
      if (!phone) {
        return { ok: false, error: 'Enter a valid Safaricom number, e.g. 0712 345 678' }
      }
      if (!isValidMpesaAmount(request.amount)) {
        return { ok: false, error: 'M-Pesa amount must be a whole number above zero' }
      }

      try {
        const response = await fetchImpl(`${proxyUrl.replace(/\/$/, '')}/stkpush`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessId: request.businessId,
            phone,
            amount: request.amount,
            reference: request.reference,
            description: request.description ?? 'POS sale',
          }),
        })

        if (!response.ok) {
          return { ok: false, error: `M-Pesa request failed (${response.status})` }
        }

        const data = (await response.json()) as {
          checkoutRequestId?: string
          merchantRequestId?: string
          responseCode?: string
          responseDescription?: string
        }

        // Daraja returns "0" on success and non-zero (e.g. "1") on rejection.
        if (!data.checkoutRequestId || (data.responseCode && data.responseCode !== '0')) {
          return { ok: false, error: data.responseDescription ?? 'M-Pesa rejected the request' }
        }

        return {
          ok: true,
          checkoutRequestId: data.checkoutRequestId,
          merchantRequestId: data.merchantRequestId,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const isNetworkError = error instanceof TypeError || /fetch|network/i.test(message)
        return {
          ok: false,
          error: isNetworkError
            ? 'Could not reach M-Pesa. Check your connection, or use code entry instead'
            : message,
        }
      }
    },

    async stkStatus(checkoutRequestId) {
      try {
        const response = await fetchImpl(
          `${proxyUrl.replace(/\/$/, '')}/stkstatus?checkoutRequestId=${encodeURIComponent(checkoutRequestId)}`,
        )
        if (!response.ok) {
          return { status: 'pending', error: `Status check failed (${response.status})` }
        }
        const data = (await response.json()) as StkStatus
        return {
          status: data.status ?? 'pending',
          receipt: data.receipt,
          error: data.error,
        }
      } catch (error) {
        return {
          status: 'pending',
          error: error instanceof Error ? error.message : 'Status check unreachable',
        }
      }
    },
  }
}
