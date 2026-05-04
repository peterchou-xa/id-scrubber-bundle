"""Upload the fp16 ONNX export of nvidia/gliner-pii to a Hugging Face repo.

Reads HF_TOKEN from the environment. Skips the 1.7GB fp32 graph by default
(it's regenerable from export_gliner_onnx.py and we don't ship it to clients).

Usage:
    export HF_TOKEN=hf_xxx
    python upload_to_hf.py [--repo peterchou26/gliner-pii-onnx]
                          [--src resources/models/gliner-pii-onnx]
                          [--include-fp32]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

DEFAULT_REPO = "peterchou26/gliner-pii-onnx"
DEFAULT_SRC = "resources/models/gliner-pii-onnx"

# Files that always go up — the runtime needs all of these together.
REQUIRED = [
    "model_fp16.onnx",
    "model_fp16.onnx_data",
    "gliner_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
]

README = """\
# gliner-pii-onnx

ONNX (fp16) re-export of [nvidia/gliner-pii](https://huggingface.co/nvidia/gliner-pii)
for use with `onnxruntime` instead of PyTorch.

- Backbone: deberta-v3-large (token-classification GLiNER)
- Precision: float16 weights, fp32 I/O (`keep_io_types=True`)
- Size: ~850 MB total (`model_fp16.onnx` + `model_fp16.onnx_data`)
- Parity vs PyTorch checkpoint: 19/19 entities, zero score drift on the
  reference test in this repo.

## Usage

```python
from gliner import GLiNER

model = GLiNER.from_pretrained(
    "peterchou26/gliner-pii-onnx",
    load_onnx_model=True,
    load_tokenizer=True,
    onnx_model_file="model_fp16.onnx",
)
ents = model.predict_entities(text, labels=[...], threshold=0.5)
```

## Files

| File | Purpose |
|---|---|
| `model_fp16.onnx` | ONNX graph (small — references external weights) |
| `model_fp16.onnx_data` | fp16 weight tensors (must sit next to the .onnx) |
| `gliner_config.json` | GLiNER head config (labels, max_len, max_width) |
| `tokenizer.json`, `tokenizer_config.json` | DeBERTa-v3 sentencepiece tokenizer |

## How this was built

See `export_gliner_onnx.py` in
[id-scrubber-bundle](https://github.com/peterchou-xa/id-scrubber-bundle):

1. Load PyTorch checkpoint via `GLiNER.from_pretrained("nvidia/gliner-pii")`.
2. `model.export_to_onnx(...)` → fp32 `model.onnx`.
3. `onnxruntime.transformers.float16.convert_float_to_float16(...,
   keep_io_types=True)` → `model_fp16.onnx`.

## License

Inherits the license of the source model
([nvidia/gliner-pii](https://huggingface.co/nvidia/gliner-pii)).
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--include-fp32", action="store_true",
                    help="Also upload model.onnx (1.7GB).")
    ap.add_argument("--private", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        sys.exit("HF_TOKEN env var is required (write-scope token).")

    src = Path(args.src).resolve()
    if not src.is_dir():
        sys.exit(f"src directory not found: {src}")

    files = list(REQUIRED)
    if args.include_fp32:
        files.append("model.onnx")
    missing = [f for f in files if not (src / f).is_file()]
    if missing:
        sys.exit(f"missing files in {src}: {missing}")

    from huggingface_hub import HfApi, create_repo

    print(f"[hf] ensuring repo {args.repo} (private={args.private})...", flush=True)
    create_repo(
        repo_id=args.repo,
        repo_type="model",
        private=args.private,
        exist_ok=True,
        token=token,
    )

    api = HfApi(token=token)

    # Write README into src dir so it ships with the rest. Don't overwrite a
    # hand-edited one if present.
    readme_path = src / "README.md"
    if not readme_path.exists():
        readme_path.write_text(README)
        print(f"[hf] wrote default README to {readme_path}", flush=True)

    upload = files + ["README.md"]
    total_bytes = sum((src / f).stat().st_size for f in upload)
    print(
        f"[hf] uploading {len(upload)} files ({total_bytes / 1024 / 1024:.1f} MB total)...",
        flush=True,
    )
    for f in upload:
        sz = (src / f).stat().st_size / 1024 / 1024
        print(f"  -> {f} ({sz:.1f} MB)", flush=True)

    api.upload_folder(
        folder_path=str(src),
        repo_id=args.repo,
        repo_type="model",
        allow_patterns=upload,
        commit_message="upload fp16 ONNX export",
    )
    print(f"[hf] done. https://huggingface.co/{args.repo}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
