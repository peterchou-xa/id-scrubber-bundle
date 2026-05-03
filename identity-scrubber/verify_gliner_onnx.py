"""Compare ONNX-exported GLiNER vs PyTorch checkpoint on a sample text.

Usage:
    python verify_gliner_onnx.py --onnx-dir resources/models/gliner-pii-onnx
    python verify_gliner_onnx.py --onnx-dir ... --onnx-file model.onnx   # fp32
"""
from __future__ import annotations

import argparse
import sys
import time

LABELS = [
    "full_name", "first_name", "last_name",
    "email", "phone_number",
    "date_of_birth",
    "passport_number",
    "national_id", "ssn",
    "street_address", "address", "mailing_address",
    "credit_card", "bank_account_number",
    "ip_address", "city", "state", "postcode", "po_box",
]

SAMPLE = (
    "Patient Name: John A. Smith\n"
    "DOB: 1985-03-12   SSN: 123-45-6789\n"
    "Address: 1428 Elm Street, Springfield, IL 62704\n"
    "Email: john.smith@example.com   Phone: (415) 555-0123\n"
    "Passport: X12345678   Card on file: 4111 1111 1111 1111\n"
    "Visited from IP 192.168.1.42 on 2024-09-01.\n"
    "Emergency contact: Jane Smith, jane.smith@example.org, (415) 555-0987.\n"
)


def _run(model, threshold: float = 0.3):
    t0 = time.monotonic()
    ents = model.predict_entities(SAMPLE, LABELS, threshold=threshold)
    dt = time.monotonic() - t0
    norm = sorted(
        (e["label"], e["text"], round(float(e.get("score", 0.0)), 3),
         e.get("start"), e.get("end"))
        for e in ents
    )
    return norm, dt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx-dir", required=True)
    ap.add_argument("--onnx-file", default="model_quantized.onnx")
    ap.add_argument("--model-name", default="nvidia/gliner-pii")
    args = ap.parse_args()

    from gliner import GLiNER

    print(f"[verify] loading PyTorch {args.model_name}...", flush=True)
    pt = GLiNER.from_pretrained(args.model_name)
    pt_ents, pt_dt = _run(pt)
    print(f"[verify] pytorch: {len(pt_ents)} ents in {pt_dt:.2f}s", flush=True)
    del pt

    print(f"[verify] loading ONNX {args.onnx_file}...", flush=True)
    ox = GLiNER.from_pretrained(
        args.onnx_dir,
        load_onnx_model=True,
        load_tokenizer=True,
        onnx_model_file=args.onnx_file,
    )
    ox_ents, ox_dt = _run(ox)
    print(f"[verify] onnx:    {len(ox_ents)} ents in {ox_dt:.2f}s", flush=True)

    pt_keys = {(lbl, txt) for lbl, txt, _, _, _ in pt_ents}
    ox_keys = {(lbl, txt) for lbl, txt, _, _, _ in ox_ents}
    only_pt = pt_keys - ox_keys
    only_ox = ox_keys - pt_keys
    common = pt_keys & ox_keys

    print(f"\n[verify] common: {len(common)} | only-pytorch: {len(only_pt)} | only-onnx: {len(only_ox)}")
    if only_pt:
        print("\nOnly in PyTorch:")
        for k in sorted(only_pt):
            print(f"  {k}")
    if only_ox:
        print("\nOnly in ONNX:")
        for k in sorted(only_ox):
            print(f"  {k}")

    # Score deltas on shared entities
    pt_scores = {(l, t): s for l, t, s, _, _ in pt_ents}
    ox_scores = {(l, t): s for l, t, s, _, _ in ox_ents}
    deltas = sorted(
        ((k, pt_scores[k], ox_scores[k]) for k in common),
        key=lambda x: -abs(x[1] - x[2]),
    )
    if deltas:
        print("\nScore drift (top 5 by abs delta):")
        for k, ps, os_ in deltas[:5]:
            print(f"  {k}: pt={ps:.3f}  onnx={os_:.3f}  Δ={os_-ps:+.3f}")

    print(f"\n[verify] speedup: {pt_dt/ox_dt:.2f}x")
    return 0 if not (only_pt or only_ox) else 1


if __name__ == "__main__":
    sys.exit(main())
