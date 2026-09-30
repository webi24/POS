import { describe, expect, it, vi } from 'vitest'
import {
  createMpesaClient,
  formatKenyanPhone,
  isValidMpesaAmount,
  isValidMpesaReceipt,
  normalizeKenyanPhone,
} from './mpesa'

describe('normalizeKenyanPhone', () => {
  it('accepts local and international formats', () => {
    expect(normalizeKenyanPhone('0712345678')).toBe('254712345678')
    expect(normalizeKenyanPhone('0119 876 543')).toBe('254119876543')
    expect(normalizeKenyanPhone('+254723456789')).toBe('254723456789')
    expect(normalizeKenyanPhone('254733333333')).toBe('254733333333')
  })

  it('rejects invalid numbers', () => {
    expect(normalizeKenyanPhone('0712')).toBeNull()
    expect(normalizeKenyanPhone('12345')).toBeNull()
    expect(normalizeKenyanPhone('0299999999')).toBeNull()
    expect(normalizeKenyanPhone('')).toBeNull()
  })
})

describe('formatKenyanPhone', () => {
  it('pretty-prints normalized numbers for display', () => {
    expect(formatKenyanPhone('254712345678')).toBe('0712 345 678')
    expect(formatKenyanPhone('0712345678')).toBe('0712 345 678')
    expect(formatKenyanPhone('+254119876543')).toBe('0119 876 543')
  })

  it('falls back to the raw input for unparseable numbers', () => {
    expect(formatKenyanPhone('not-a-number')).toBe('not-a-number')
  })
})

describe('receipt and amount validation', () => {
  it('accepts 10-char alphanumeric codes case-insensitively', () => {
    expect(isValidMpesaReceipt('qgh7xyz12k')).toBe(true)
    expect(isValidMpesaReceipt('QGH7XYZ12K')).toBe(true)
    expect(isValidMpesaReceipt('SHORT12')).toBe(false)
    expect(isValidMpesaReceipt('WAYTOOLONGCODE1')).toBe(false)
    expect(isValidMpesaReceipt('')).toBe(false)
  })

  it('requires whole positive shillings for STK push', () => {
    expect(isValidMpesaAmount(100)).toBe(true)
    expect(isValidMpesaAmount(0)).toBe(false)
    expect(isValidMpesaAmount(-5)).toBe(false)
    expect(isValidMpesaAmount(10.5)).toBe(false)
    expect(isValidMpesaAmount(Number.NaN)).toBe(false)
  })
})

describe('createMpesaClient', () => {
  it('validates phone and amount before hitting the proxy', async () => {
    const fetchMock = vi.fn()
    const client = createMpesaClient('https://proxy.test', fetchMock as unknown as typeof fetch)

    const badPhone = await client.stkPush({
      businessId: 'b1',
      phone: '123',
      amount: 50,
      reference: 'POS',
    })
    expect(badPhone.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    const badAmount = await client.stkPush({
      businessId: 'b1',
      phone: '0712345678',
      amount: 10.5,
      reference: 'POS',
    })
    expect(badAmount.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the checkout request id on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ checkoutRequestId: 'ws_CO_123', responseCode: '0' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const client = createMpesaClient('https://proxy.test', fetchMock as unknown as typeof fetch)

    const result = await client.stkPush({
      businessId: 'b1',
      phone: '0712345678',
      amount: 100,
      reference: 'SHOP',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.checkoutRequestId).toBe('ws_CO_123')
    }
  })

  it('surfaces Daraja rejection reasons', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ responseCode: '1', responseDescription: 'The initiator information is invalid' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const client = createMpesaClient('https://proxy.test', fetchMock as unknown as typeof fetch)

    const result = await client.stkPush({
      businessId: 'b1',
      phone: '0712345678',
      amount: 100,
      reference: 'SHOP',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('initiator')
    }
  })

  it('treats network failures as a friendly offline error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const client = createMpesaClient('https://proxy.test', fetchMock as unknown as typeof fetch)

    const result = await client.stkPush({
      businessId: 'b1',
      phone: '0712345678',
      amount: 100,
      reference: 'SHOP',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('M-Pesa')
    }
  })

  it('polls status and forwards confirmed receipts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'confirmed', receipt: 'QGH7XYZ12K' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const client = createMpesaClient('https://proxy.test', fetchMock as unknown as typeof fetch)

    const status = await client.stkStatus('ws_CO_123')

    expect(status.status).toBe('confirmed')
    expect(status.receipt).toBe('QGH7XYZ12K')
  })
})
