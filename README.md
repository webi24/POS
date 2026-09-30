# Kenya POS

Offline-first point-of-sale web app for Kenyan shops: multi-business owner accounts, staff PIN logins, cash/M-Pesa sales, inventory with audit trail, eTIMS invoicing hooks, and IndexedDB persistence with Supabase cloud sync.

## Barcode scanning

Two scanning methods, both fully offline:

- **Hardware scanners (USB/Bluetooth, keyboard-emulation):** just scan on the Sell screen; no field to click first. A burst of fast keystrokes ending in Enter is recognized as a scan; human typing in the search box is ignored. Unrecognized codes offer a one-tap "add it to inventory?" flow with the code pre-filled.
- **Camera scanning:** "Scan with camera" on the Sell screen uses `html5-qrcode` (native `BarcodeDetector` API where available, bundled ZXing fallback otherwise). Modest resolution/framerate for low-end Android phones; camera is fully released on close.

Barcodes are an optional field on each product: set them on the Add/import items form (or let the not-found flow pre-fill them).

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
