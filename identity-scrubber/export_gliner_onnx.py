"""Export nvidia/gliner-pii to ONNX (+ int8 quantized variant).

Usage:
    python export_gliner_onnx.py [--out-dir resources/models/gliner-pii-onnx]

Produces, in --out-dir:
    model.onnx                — fp32 ONNX graph (+ model.onnx_data sidecar if >2GB)
    model_fp16.onnx           — float16 weights/activations (about half the size)
    gliner_config.json        — GLiNER's own config (needed by load_onnx_model)
    tokenizer.json / spm.model / etc.

Then load at runtime with:
    GLiNER.from_pretrained(out_dir, load_onnx_model=True,
                           onnx_model_file="model_fp16.onnx")
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

MODEL_NAME = "nvidia/gliner-pii"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="resources/models/gliner-pii-onnx")
    ap.add_argument("--no-fp16", action="store_true",
                    help="Skip producing model_fp16.onnx alongside the fp32 graph.")
    ap.add_argument("--opset", type=int, default=19)
    args = ap.parse_args()

    from gliner import GLiNER

    out = Path(args.out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    print(f"[export] loading {MODEL_NAME}...", flush=True)
    t0 = time.monotonic()
    model = GLiNER.from_pretrained(MODEL_NAME)
    print(f"[export] loaded in {time.monotonic() - t0:.1f}s", flush=True)

    print(f"[export] exporting fp32 ONNX to {out}", flush=True)
    t0 = time.monotonic()
    paths = model.export_to_onnx(
        save_dir=str(out),
        quantize=False,
        opset=args.opset,
    )
    print(f"[export] fp32 done in {time.monotonic() - t0:.1f}s", flush=True)
    fp32_path = Path(paths["onnx_path"])
    print(f"  fp32: {fp32_path} ({fp32_path.stat().st_size / 1024 / 1024:.1f} MB)")

    if not args.no_fp16:
        fp16_path = out / "model_fp16.onnx"
        print(f"[export] converting fp32 -> fp16 -> {fp16_path}", flush=True)
        t0 = time.monotonic()
        _convert_fp16(fp32_path, fp16_path)
        print(f"[export] fp16 done in {time.monotonic() - t0:.1f}s", flush=True)
        print(f"  fp16: {fp16_path} ({fp16_path.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


def _convert_fp16(fp32_path: Path, fp16_path: Path) -> None:
    """Convert an fp32 ONNX graph to fp16, keeping precision-sensitive ops in fp32.

    deberta-v3 (the gliner-pii backbone) uses disentangled attention with
    softmax over wide ranges; converting those ops to fp16 destroys accuracy.
    `keep_io_types=True` also leaves model inputs/outputs as fp32, so the
    GLiNER ORT wrapper does not need to know about the conversion.
    """
    import onnx
    # ORT's transformers.float16 is more robust than onnxconverter_common for
    # transformer graphs — it handles existing Cast nodes and dynamic axes
    # without leaving dangling type mismatches.
    from onnxruntime.transformers.float16 import convert_float_to_float16

    model = onnx.load(str(fp32_path))
    model_fp16 = convert_float_to_float16(
        model,
        keep_io_types=True,
        disable_shape_infer=True,
    )
    onnx.save(
        model_fp16,
        str(fp16_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=fp16_path.name + "_data",
        size_threshold=1024,
    )


if __name__ == "__main__":
    sys.exit(main())
