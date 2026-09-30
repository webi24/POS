import { describe, expect, it } from 'vitest'
import {
  detectScanFromKeystrokes,
  findProductByBarcode,
  isScannerLikeInput,
  type ScannerKeystroke,
} from './barcode'
import type { Product } from './posStore'

function makeProduct(overrides: Partial<Product>): Product {
  return {
    id: 'prod-1',
    businessId: 'biz-1',
    name: 'Test Item',
    category: 'General',
    price: 100,
    costPrice: 70,
    stockQuantity: 10,
    unitOfMeasure: 'piece',
    lowStockAlert: 5,
    ...overrides,
  } as Product
}

/** Simulates scanner timing: fast, metronome-steady keystrokes. */
function scannerBurst(chars: string, startMs = 0, intervalMs = 20): ScannerKeystroke[] {
  return chars.split('').map((char, index) => ({
    key: char,
    at: startMs + index * intervalMs,
  }))
}

/** Simulates a human typing the same characters: slower, uneven. */
function humanBurst(chars: string, startMs = 0): ScannerKeystroke[] {
  return chars.split('').map((char, index) => ({
    key: char,
    at: startMs + index * 180 + (index % 3) * 90,
  }))
}

describe('findProductByBarcode', () => {
  const products = [
    makeProduct({ id: 'a', name: 'Cooking Oil', barcode: '6001234500017' }),
    makeProduct({ id: 'b', name: 'Soap', barcode: ' 0012345678905 ' }),
    makeProduct({ id: 'c', name: 'Loose Maize' }),
  ]

  it('finds a product by exact barcode', () => {
    expect(findProductByBarcode(products, '6001234500017')?.id).toBe('a')
  })

  it('is case-insensitive for alphanumeric codes', () => {
    const withLetters = [...products, makeProduct({ id: 'd', barcode: 'ABC123XYZ9' })]
    expect(findProductByBarcode(withLetters, 'abc123xyz9')?.id).toBe('d')
  })

  it('trims whitespace on both stored and scanned values', () => {
    expect(findProductByBarcode(products, '0012345678905')?.id).toBe('b')
  })

  it('returns null for empty input and unknown codes', () => {
    expect(findProductByBarcode(products, '')).toBeNull()
    expect(findProductByBarcode(products, '   ')).toBeNull()
    expect(findProductByBarcode(products, '9999999999999')).toBeNull()
  })

  it('returns null when the product has no barcode', () => {
    expect(findProductByBarcode([products[2]], '12345')).toBeNull()
  })
})

describe('isScannerLikeInput', () => {
  it('accepts fast steady bursts', () => {
    expect(isScannerLikeInput(scannerBurst('6001234500017'))).toBe(true)
  })

  it('rejects human-speed typing', () => {
    expect(isScannerLikeInput(humanBurst('6001234500017'))).toBe(false)
  })

  it('rejects a fast burst containing one human-sized pause', () => {
    const events = scannerBurst('60012345001')
    events[5].at += 500
    expect(isScannerLikeInput(events)).toBe(false)
  })

  it('rejects single-keystroke and empty input', () => {
    expect(isScannerLikeInput([])).toBe(false)
    expect(isScannerLikeInput([{ key: '6', at: 0 }])).toBe(false)
  })
})

describe('detectScanFromKeystrokes', () => {
  it('returns the barcode for a scan ending in Enter', () => {
    const events = [...scannerBurst('6001234500017'), { key: 'Enter', at: 260 }]
    expect(detectScanFromKeystrokes(events)).toBe('6001234500017')
  })

  it('returns null while the burst is still in progress (no Enter yet)', () => {
    expect(detectScanFromKeystrokes(scannerBurst('6001234500017'))).toBeNull()
  })

  it('returns null for human typing even when it ends in Enter', () => {
    const events = [...humanBurst('hello'), { key: 'Enter', at: 1200 }]
    expect(detectScanFromKeystrokes(events)).toBeNull()
  })

  it('returns null when non-single-character keys are in the burst', () => {
    const events: ScannerKeystroke[] = [
      { key: '6', at: 0 },
      { key: 'Shift', at: 20 },
      { key: '0', at: 40 },
      { key: 'Enter', at: 60 },
    ]
    expect(detectScanFromKeystrokes(events)).toBeNull()
  })

  it('returns null for a lone Enter', () => {
    expect(detectScanFromKeystrokes([{ key: 'Enter', at: 0 }])).toBeNull()
  })
})
