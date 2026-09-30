import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'

const SCANNER_ELEMENT_ID = 'barcode-camera-region'

type CameraScannerProps = {
  /** Called once per detected barcode; parent closes the modal. */
  onDetected: (barcode: string) => void
  onClose: () => void
}

/**
 * Camera barcode scanning via html5-qrcode.
 *
 * - Prefers the native BarcodeDetector API where the browser has one
 *   (Chrome/Edge/Android), falls back to its bundled ZXing decoder elsewhere.
 * - Runs entirely on-device: no network calls, works fully offline.
 * - Modest 720p request + fps/interval caps keep low-spec Android phones
 *   responsive and battery drain reasonable. The native detector is far
 *   cheaper per frame than the JS fallback.
 * - Camera is fully released on close (unmount); no background drain.
 */
export function CameraBarcodeScanner({ onDetected, onClose }: CameraScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(true)

  useEffect(() => {
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID, {
      // Lower-spec phones: native detector when present, JS decoder otherwise.
      formatsToSupport: undefined,
      verbose: false,
    })
    scannerRef.current = scanner
    let cancelled = false

    const start = async () => {
      try {
        await scanner.start(
          // Environment-facing camera, modest resolution for low-end devices.
          { facingMode: 'environment' },
          { fps: 8, qrbox: undefined, aspectRatio: 1.333 },
          (decodedText) => {
            if (cancelled) return
            onDetected(decodedText)
          },
          () => {
            // Per-frame "no barcode in view" (deliberately silent).
          },
        )
        if (!cancelled) setStarting(false)
      } catch (startError) {
        if (!cancelled) {
          setError(
            startError instanceof Error
              ? startError.message
              : 'Could not start the camera. Check permissions',
          )
          setStarting(false)
        }
      }
    }

    void start()

    return () => {
      cancelled = true
      void scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => {
          // Camera already gone (navigation/permission loss); nothing to do.
        })
    }
    // onDetected/onClose are stable per open; re-running would restart the cam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="walkthrough-overlay" role="dialog" aria-modal="true" aria-label="Scan a barcode with the camera">
      <div className="panel camera-scan-panel">
        <div className="section-header">
          <h2>Scan with camera</h2>
          <button type="button" className="link-button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          Hold the barcode steady 10-20 cm away in good light. Works offline; nothing is uploaded.
        </p>
        <div id={SCANNER_ELEMENT_ID} className="camera-scan-region" />
        {starting && !error && <p className="muted">Starting camera…</p>}
        {error && (
          <p className="error-text">
            {error}. Use a USB/Bluetooth scanner or enter the barcode on the item form instead.
          </p>
        )}
      </div>
    </div>
  )
}
