# Identity Scrubber (Electron)

Desktop app that bootstraps a local AI engine (Ollama) on first launch.

## Flow

1. On launch, main process checks for Ollama at:
   - `~/Applications/Ollama.app`
   - `/Applications/Ollama.app`
   - `ollama` on `$PATH`
2. If missing, UI shows an **Install** button.
3. Clicking Install runs a **user-space install** (no `sudo`):
   - Download `Ollama.dmg` from `https://ollama.com/download/Ollama.dmg` via `electron.net`
   - `hdiutil attach` the DMG
   - `cp -R Ollama.app ~/Applications/Ollama.app`
   - `hdiutil detach`
   - `xattr -dr com.apple.quarantine` on the app
4. Start the `ollama serve` binary inside the bundle, then poll `http://127.0.0.1:11434/api/tags` until it responds.

No `curl | sh`, no Docker, no silent writes to `/Applications`.

## Layout

```
src/
  main/
    index.js     # BrowserWindow + IPC handlers
    ollama.js    # detect / download / install / start
  preload/
    index.js     # contextBridge API
  renderer/
    index.html
    renderer.js  # state machine UI
    styles.css
build/
  entitlements.mac.plist
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
npm run build
```

`electron-builder` is configured in `package.json` to produce a notarizable DMG.
Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars before
running `npm run build` if you want notarization.

## Renderer states

`idle` → `downloading` → `installing` → `starting` → `done`, with `error` as a
terminal state that shows a Retry button. The main process emits `ollama:progress`
events; the renderer maps them into the UI.

## Preload API

```ts
window.ollama.getStatus(): Promise<{ installed, running, location }>
window.ollama.install(): Promise<{ ok, location? , error? }>
window.ollama.start(): Promise<{ ok, alreadyRunning?, error? }>
window.ollama.onProgress(cb): () => void  // returns unsubscribe
```
