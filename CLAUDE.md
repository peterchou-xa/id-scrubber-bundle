# Identity Scrubber Bundle

## Architecture
Monorepo with two main components:

- **`identity-scrubber/`** — Python backend that OCRs PDF pages and uses GLiNER (nvidia/gliner-pii via ONNX) to detect and redact PII. Entry point: `main.py`. Packaged via PyInstaller.
- **`identity-scrubber-app/`** — Electron + React + TypeScript desktop app (electron-vite, Tailwind v4, React 18). Wraps the Python scrubber as a bundled resource.

## Key Files

### Python backend (`identity-scrubber/`)
- `main.py` — CLI entry point, PII detection pipeline
- `paddleocr_scrub.py` — OCR-based scrubbing logic

### Electron app (`identity-scrubber-app/`)
- `src/main/index.ts` — Electron main process
- `src/main/scrubber.ts` — scrubber child process management
- `src/main/gliner.ts` — GLiNER model download/setup
- `src/main/identifiersStore.ts` — identifier storage
- `src/preload/index.ts` — preload bridge (IPC API)
- `src/renderer/src/MainScreen.tsx` — main UI with PII preview/highlighting
- `src/renderer/src/App.tsx` — app root
- `src/renderer/src/useGlinerSetup.ts` — model setup hook

## Build Commands
```bash
# Dev mode
cd identity-scrubber-app && npm run dev

# Build Python scrubber (PyInstaller)
cd identity-scrubber-app && npm run build:scrubber

# Build Electron app for macOS
cd identity-scrubber-app && npm run build:mac
```

## PII Categories
name, date_of_birth, email, phone_number, address, passport_number, national_id, credit_card, bank_account, ip_address, other
