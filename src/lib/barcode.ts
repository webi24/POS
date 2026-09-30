/**
 * Barcode scanning helpers (pure logic, no DOM).
 *
 * Hardware scanners (USB/Bluetooth) are keyboard emulators: a scan arrives as
 * fast keystrokes ending in Enter. The classifier below separates that
 * signature from a human typing in the search box. Camera scanning uses
 * html5-qrcode, which prefers the native BarcodeDetector API and falls back
 * to a bundled ZXing decoder. Everything runs locally, fully offline.
 */

import type { Product } from './posStore'

/**
 * Finds a product by barcode. Exact, case-insensitive; leading zeros are
 * significant and preserved (UPC-A is 12 digits, several with leading zeros).
 */
export function findProductByBarcode(
  products: Product[],
  barcode: string,
): Product | null {
  const needle = barcode.trim()
  if (!needle) return null
  const lower = needle.toLowerCase()
  return products.find((product) => product.barcode?.trim().toLowerCase() === lower) ?? null
}

/**
 * True when the input looks like a scanner, not a person. Scanners "type"
 * faster than humans (typically >15 chars/sec, sustained over the whole
 * burst) and finish with Enter. Human typing rarely sustains that speed.
 */
export function isScannerLikeInput(events: ScannerKeystroke[]): boolean {
  if (events.length < 2) return false
  const first = events[0]
  const last = events[events.length - 1]
  const spanMs = last.at - first.at
  if (spanMs < 0) return false

  // ~8.3 chars/sec = 100 ms per char; humans rarely sustain that.
  const minCharsPerSecond = 8.3
  const avgInterval = spanMs / (events.length - 1)
  if (avgInterval > 1000 / minCharsPerSecond) return false

  // One long pause reveals a human (thinking between keys), not a scanner.
  const maxIntervalMs = 300
  return events
    .slice(1)
    .every((event, index) => event.at - events[index].at <= maxIntervalMs)
}

export type ScannerKeystroke = {
  key: string
  at: number
}

/**
 * Feeds keystrokes through the scanner classifier and returns the complete
 * barcode the moment a scan ends with Enter. Returns null while the burst is
 * still in progress (or once discarded as human typing; the buffer resets).
 */
export function detectScanFromKeystrokes(
  events: ScannerKeystroke[],
): string | null {
  if (events.length < 2 || events[events.length - 1].key !== 'Enter') {
    return null
  }
  const body = events.slice(0, -1)
  if (body.length === 0 || !body.every((event) => event.key.length === 1)) {
    return null
  }
  if (!isScannerLikeInput(events.slice(0, -1))) {
    return null
  }
  return body.map((event) => event.key).join('')
}

/**
 * Camera support: BarcodeDetector availability is what actually matters;
 * html5-qrcode's ZXing fallback covers the rest, so this is informational.
 */
export function cameraScanSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  )
}
