#!/usr/bin/env bash
# Regenerate build/ACKNOWLEDGEMENTS.txt from the current node_modules and Python venv.
# Run from identity-scrubber-app/ (or anywhere — paths are resolved relative to this script).
#
# Usage:
#   ./scripts/generate-acknowledgements.sh
#
# Prerequisites:
#   - npm install        (in identity-scrubber-app/)
#   - ../identity-scrubber/bin/pip-licenses installed in the Python venv
#     (./bin/pip install pip-licenses)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PY_DIR="$(cd "$APP_DIR/../identity-scrubber" && pwd)"
BUILD_DIR="$APP_DIR/build"
TMP_JSON="$(mktemp -t lc-electron-XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT

mkdir -p "$BUILD_DIR"

echo "==> Electron / npm deps"
cd "$APP_DIR"
npx --yes license-checker \
  --production \
  --excludePackages "identity-scrubber-app@0.1.0" \
  --json > "$TMP_JSON"

python3 - "$TMP_JSON" "$BUILD_DIR/THIRD_PARTY_LICENSES_ELECTRON.txt" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
out = [
    "=" * 78,
    "Identity Scrubber — Third-Party Licenses (Electron / Node.js dependencies)",
    "=" * 78,
    "",
    "This product includes software developed by third parties, listed below.",
    "Each component is distributed under the terms of its respective license.",
    "",
]
for name in sorted(d.keys()):
    info = d[name]
    out += ["", "-" * 78, name, f"  License: {info.get('licenses','(unknown)')}"]
    if info.get('repository'):
        out.append(f"  Repository: {info['repository']}")
    if info.get('publisher'):
        out.append(f"  Publisher: {info['publisher']}")
    out.append("-" * 78)
    lf = info.get('licenseFile')
    if lf and os.path.exists(lf):
        try:
            out.append(open(lf, encoding='utf-8', errors='replace').read().rstrip())
        except Exception as e:
            out.append(f"(unable to read license file: {e})")
    else:
        out.append("(no license file shipped with package)")
    out.append("")
open(dst, 'w').write('\n'.join(out))
print(f"  wrote {len(d)} packages to {dst}")
PY

echo "==> Python deps (via $PY_DIR/bin/pip-licenses)"
if [[ ! -x "$PY_DIR/bin/pip-licenses" ]]; then
  echo "ERROR: $PY_DIR/bin/pip-licenses not found." >&2
  echo "  Run: cd $PY_DIR && ./bin/pip install pip-licenses" >&2
  exit 1
fi
"$PY_DIR/bin/pip-licenses" \
  --format=plain-vertical \
  --with-license-file \
  --no-license-path \
  --with-urls \
  > "$BUILD_DIR/THIRD_PARTY_LICENSES_PYTHON.txt"
echo "  wrote $BUILD_DIR/THIRD_PARTY_LICENSES_PYTHON.txt"

echo "==> Combining into ACKNOWLEDGEMENTS.txt"
# Model weights (NVIDIA gliner-pii, PaddleOCR, etc.) aren't pip packages,
# so they're maintained by hand in scripts/BUNDLED_MODELS.txt.
cat \
  "$BUILD_DIR/THIRD_PARTY_LICENSES_ELECTRON.txt" \
  "$BUILD_DIR/THIRD_PARTY_LICENSES_PYTHON.txt" \
  "$SCRIPT_DIR/BUNDLED_MODELS.txt" \
  > "$BUILD_DIR/ACKNOWLEDGEMENTS.txt"

echo "Done. $(wc -l < "$BUILD_DIR/ACKNOWLEDGEMENTS.txt") lines, $(du -h "$BUILD_DIR/ACKNOWLEDGEMENTS.txt" | cut -f1)"
