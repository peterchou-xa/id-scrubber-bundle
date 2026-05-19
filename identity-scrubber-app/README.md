# Identity Scrubber (Electron)

Desktop app that detects and redacts PII in PDFs using a local OCR + NER pipeline. The Python scrubber (PyInstaller bundle) is shipped as an `extraResource`; the GLiNER PII model is downloaded on first launch.

## Flow

1. On launch, the renderer asks `gliner:status` whether the GLiNER ONNX model is already cached in `app.getPath('userData')/gliner/`.
2. If not, the UI shows a **Download model** action. The main process streams the model files from Hugging Face (`nvidia/gliner-pii`), emitting `gliner:progress` events.
3. Once the model is present, the user picks a PDF via `dialog:openPdf`. The main process spawns the bundled scrubber binary (`resources/scrubber/identity-scrubber`) in serve mode.
4. `scrubber:detect` runs OCR + GLiNER and streams per-page events back to the renderer. `scrubber:scrub` applies redactions to the selected matches and writes the redacted PDF.

## Layout

```
src/
  main/
    index.ts            # BrowserWindow + IPC handlers
    scrubber.ts         # spawns/manages the Python serve process
    gliner.ts           # model download + status
    identifiersStore.ts # persisted user-supplied identifiers
    billing.ts          # license + page-quota accounting
    deviceId.ts
    metrics.ts
  preload/
    index.ts            # contextBridge APIs (gliner, scrubber, dialogApi, identifiers, billing)
  renderer/
    src/
      App.tsx
      MainScreen.tsx
      useGlinerSetup.ts
      ...
build/
  entitlements.mac.plist
resources/
  scrubber/             # PyInstaller output (gitignored, ~375 MB)
```

## Develop

```bash
cd identity-scrubber-app
npm install
npm run build:scrubber   # bundles ../identity-scrubber via PyInstaller
npm run dev
```

### Scrubber binary

The PyInstaller-built Python binary is not checked in (it's ~375 MB). It lives at
`resources/scrubber/identity-scrubber` and is gitignored. Rebuild it with:

```bash
npm run build:scrubber
```

This invokes `pyinstaller identity-scrubber.spec` in the sibling `../identity-scrubber`
venv and copies the output into `resources/scrubber/`. The `.spec` file is committed
so the build is reproducible.

## Build (signed DMG)

```bash
npm run build:mac
```

`electron-builder` is configured in `package.json` to produce a notarizable universal
DMG (arm64 + x64). Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
env vars before running if you want notarization.

## Preload APIs

Exposed on `window` via `contextBridge`:

```ts
window.gliner.getStatus(): Promise<{ cached, dir, repo }>
window.gliner.download(): Promise<{ ok, dir } | { ok: false, error }>
window.gliner.onProgress(cb): () => void

window.scrubber.detect(pdfPath, customPii?): Promise<ScrubberCmdResult>
window.scrubber.scrub(selected, color?, byType?): Promise<ScrubberCmdResult>
window.scrubber.onEvent(cb): () => void
window.scrubber.onLog(cb): () => void

window.dialogApi.openPdf(): Promise<{ path, name } | null>
window.dialogApi.openPath(filePath): Promise<{ ok, error? }>

window.identifiers.load() / save(values)
window.billing.consume(pages) / balance() / startCheckout(tier) / redeemLicenseKey(key)
```
