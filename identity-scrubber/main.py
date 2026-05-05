#!/usr/bin/env python3
"""
PII Detector: parses a PDF, OCRs each page, and uses GLiNER (nvidia/gliner-pii
via onnxruntime) to detect personally identifiable information.

Usage:
    python main.py <path_to_pdf> --scrub \\
        --gliner-onnx-dir <dir> --gliner-onnx-file model_fp16.onnx
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from collections import defaultdict
from pathlib import Path

# Canonical, end-user-facing PII categories. The UI groups detections by
# these values, so they need to read naturally (e.g. "Name", not "Full Name"
# / "First Name" / "Last Name" as three separate sections). Order here is
# the display order.
PII_CATEGORY_LABELS = [
    "name",
    "date_of_birth",
    "email",
    "phone_number",
    "address",
    "passport_number",
    "national_id",
    "credit_card",
    "bank_account",
    "ip_address",
    "other",
]


_GLINER_MODEL_NAME = "nvidia/gliner-pii"

# Labels passed to nvidia/gliner-pii at inference time.
_GLINER_LABELS = [
    "full_name", "first_name", "last_name",
    "email", "phone_number",
    "date_of_birth",
    "passport_number",
    "national_id", "ssn",
    "street_address",
    "credit_card", "bank_account_number",
    "ip_address", "city", "state", "postcode", "po_box",
]

# Each raw gliner label collapses to one user-facing category. Anything not
# in this map falls through to "other".
_GLINER_LABEL_TO_CATEGORY = {
    "full_name": "name",
    "first_name": "name",
    "last_name": "name",
    "email": "email",
    "phone_number": "phone_number",
    "date_of_birth": "date_of_birth",
    "passport_number": "passport_number",
    "national_id": "national_id",
    "ssn": "ssn",
    "street_address": "address",
    "city": "address",
    "state": "address",
    "postcode": "address",
    "po_box": "address",
    "credit_card": "credit_card",
    "bank_account_number": "bank_account",
    "ip_address": "ip_address",
}


def gliner_label_to_category(label: str) -> str:
    return _GLINER_LABEL_TO_CATEGORY.get((label or "").strip().lower(), "other")

_GLINER_MODEL = None

# Set by --gliner-onnx-dir on the CLI to switch from PyTorch to onnxruntime.
# When None, the original HF PyTorch checkpoint is used.
_GLINER_ONNX_DIR: str | None = None
_GLINER_ONNX_FILE: str = "model_fp16.onnx"


def _get_gliner_model():
    global _GLINER_MODEL
    if _GLINER_MODEL is not None:
        return _GLINER_MODEL
    try:
        from gliner import GLiNER
    except ImportError:
        sys.exit("gliner not installed. Run: pip install gliner")
    t0 = time.monotonic()
    if _GLINER_ONNX_DIR:
        print(
            f"[gliner] loading ONNX model from {_GLINER_ONNX_DIR} ({_GLINER_ONNX_FILE})...",
            file=sys.stderr, flush=True,
        )
        _GLINER_MODEL = GLiNER.from_pretrained(
            _GLINER_ONNX_DIR,
            load_onnx_model=True,
            load_tokenizer=True,
            onnx_model_file=_GLINER_ONNX_FILE,
        )
    else:
        print(f"[gliner] loading {_GLINER_MODEL_NAME}...", file=sys.stderr, flush=True)
        _GLINER_MODEL = GLiNER.from_pretrained(_GLINER_MODEL_NAME)
    print(f"[gliner] model loaded in {time.monotonic() - t0:.1f}s", file=sys.stderr, flush=True)
    return _GLINER_MODEL


GLINER_THRESHOLD = 0.3

def query_gliner_entities(text_chunk: str) -> list[dict]:
    """Run nvidia/gliner-pii and preserve per-entity char offsets.

    Returns raw [{start, end, text, label}, ...] entities so the caller
    can reverse-map (start, end) onto OCR words instead of re-matching
    the value as a string (which produces false positives for short
    values like "WA" hitting "WALMART").
    """
    model = _get_gliner_model()
    t0 = time.monotonic()
    entities = model.predict_entities(text_chunk, _GLINER_LABELS, threshold=GLINER_THRESHOLD)
    print(
        f"[gliner] {len(entities)} entities in {time.monotonic() - t0:.1f}s",
        file=sys.stderr, flush=True,
    )
    return entities


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
DEFAULT_SCRUB_COLOR = "#DC2626"


def _normalize_hex_color(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    return value if HEX_COLOR_RE.match(value) else fallback


def is_valid_pii_item(item: dict) -> bool:
    """Drop LLM detections whose value obviously doesn't match the claimed type.

    The small OCR'd-PDF pipeline sees a lot of garbled Tesseract output, and
    smaller models will happily label noise like '[e |' as an email_address.
    """
    pii_type = (item.get("type") or "").strip().lower()
    value = (item.get("value") or "").strip()
    if not value:
        return False
    if pii_type == "email" and not EMAIL_RE.match(value):
        return False
    return True


def parse_custom_pii_values(raw_values: list[str] | None) -> set[str]:
    """Parse custom PII values passed on the CLI.

    Supports multiple values after ``--custom-pii`` as well as comma/newline-
    separated values within a single argument.
    """
    if not raw_values:
        return set()

    values: set[str] = set()
    for raw in raw_values:
        for part in re.split(r"[\n,]", raw):
            value = part.strip()
            if value:
                values.add(value)
    return values


def aggregate_results(all_items: list[dict]) -> list[dict]:
    """Aggregate detected PII into a flat list of unique values with types."""
    seen: dict[tuple[str, str], int] = defaultdict(int)  # (type, value) -> count

    for item in all_items:
        pii_type = item.get("type", "other").strip().lower()
        value = item.get("value", "").strip()

        if not value:
            continue

        if pii_type not in PII_CATEGORY_LABELS:
            pii_type = "other"

        seen[(pii_type, value)] += 1

    # Sort by category order then value
    cat_order = {c: i for i, c in enumerate(PII_CATEGORY_LABELS)}
    return [
        {"value": value, "type": pii_type, "occurrences": count}
        for (pii_type, value), count in sorted(
            seen.items(), key=lambda x: (cat_order.get(x[0][0], 99), x[0][1])
        )
    ]


def _default_scrubbed_path(pdf_path: str) -> str:
    path = Path(pdf_path)
    return str(path.with_stem(path.stem + "_scrubbed"))


def _default_full_text_path(pdf_path: str) -> str:
    path = Path(pdf_path)
    return str(path.with_stem(path.stem + "_fulltext").with_suffix(".txt"))


def _write_json_output(args, file_path: str, pii_list: list[dict]) -> None:
    output = {
        "file": file_path,
        "model": args.model,
        "total_pii_detected": len(pii_list),
        "pii": pii_list,
    }
    json_output = json.dumps(output, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(json_output)
        print(f"Results written to: {args.output}", file=sys.stderr)
    else:
        print(json_output)


def _run_ocr_scrub(args, input_pdf: str, output_pdf: str, *, do_scrub: bool) -> bool:
    """OCR-based detect flow; optionally redacts. With do_scrub=False
    the PII JSON is still written but the PDF is left untouched."""
    failed = {"value": False}
    detect_done: dict = {}
    scrub_done: dict = {}

    def cli_emit(obj: dict) -> None:
        cmd = obj.get("cmd")
        status = obj.get("status")
        phase = obj.get("phase")
        if status == "error":
            print(f"[{cmd}] ERROR: {obj.get('message')}", file=sys.stderr)
            failed["value"] = True
            return
        if cmd == "detect" and phase == "ocr" and status == "done":
            print(f"OCR complete: {obj['pages']} page(s).", file=sys.stderr)
        elif cmd == "detect" and phase == "analyze" and status == "in_progress":
            print(f"  Chunk {obj['chunk']}/{obj['total']} starting.", file=sys.stderr)
        elif cmd == "scrub" and phase == "redact" and status == "in_progress":
            print(
                f"Redacting {obj['bboxes']} PII region(s) across {obj['pages']} page(s).",
                file=sys.stderr,
            )
        if status == "done":
            if cmd == "detect" and phase == "analyze":
                detect_done.update(obj)
            elif cmd == "scrub" and phase == "redact":
                scrub_done.update(obj)
        # kind:"pii" / kind:"page" events are silent on the CLI; full list is
        # written via _write_json_output.

    detect_req = {
        "path": input_pdf,
        "options": {
            "model": args.model,
            "chunk_size": args.chunk_size,
            "ocr_dpi": args.ocr_dpi,
        },
    }
    state: dict = {}
    try:
        _serve_detect(detect_req, state, args, emit=cli_emit)
        if failed["value"]:
            return False

        pii_list = detect_done.get("pii", [])
        _write_json_output(args, input_pdf, pii_list)

        if not do_scrub:
            return False

        detected_values = {
            item["value"] for item in state.get("all_items", [])
            if isinstance(item.get("value"), str) and item["value"].strip()
        }
        custom_values = parse_custom_pii_values(args.custom_pii)
        selected = sorted(detected_values | custom_values)
        if not selected:
            print("No PII detected; nothing to redact.", file=sys.stderr)
            shutil.copyfile(input_pdf, output_pdf)
            print(f"Scrubbed PDF saved to: {output_pdf}", file=sys.stderr)
            return False

        # Custom values weren't in the detect-time bbox map; match them now
        # so _serve_scrub finds them in the cache.
        if custom_values:
            ocr_module = state["ocr_module"]
            cached = state["bboxes_pdf_by_value"]
            extras = [v for v in sorted(custom_values) if v not in cached]
            for v in extras:
                cached[v] = []
            for page in state["pages"]:
                per_value = ocr_module.find_pii_bboxes_by_value(page, extras)
                for v, pdf_bboxes in per_value.items():
                    for pdf_bbox in pdf_bboxes:
                        cached[v].append((page.page_num, pdf_bbox))

        print(f"Redacting PDF (rasterizing at {args.ocr_dpi} DPI)...", file=sys.stderr)
        _serve_scrub(
            {"selected": selected, "output": output_pdf}, state, args, emit=cli_emit,
        )
        if failed["value"]:
            return False

        print(f"Scrubbed PDF saved to: {scrub_done.get('output', output_pdf)}", file=sys.stderr)
        return bool(scrub_done.get("redacted"))
    finally:
        _cleanup_image_dir(state)


def _emit(obj: dict) -> None:
    """Write one NDJSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _pdf_bbox_to_pixel(
    pdf_bbox: tuple[float, float, float, float],
    page_height_pt: float,
    scale: float,
) -> dict:
    """Convert a PDF-point bbox (origin bottom-left) to image-pixel
    rect (origin top-left, x/y/w/h) suitable for canvas drawing."""
    x0, y0, x1, y1 = pdf_bbox
    return {
        "x": x0 * scale,
        "y": (page_height_pt - y1) * scale,
        "w": (x1 - x0) * scale,
        "h": (y1 - y0) * scale,
    }


def _cleanup_image_dir(state: dict) -> None:
    """Remove the per-detect temp PNG dir if present."""
    image_dir = state.pop("image_dir", None)
    if image_dir and os.path.isdir(image_dir):
        shutil.rmtree(image_dir, ignore_errors=True)


def _detect_via_gliner_offsets(
    *,
    ocr_scrub,
    full_text: str,
    word_spans,
    chunk_size: int,
    bboxes_pdf_by_value: dict,
    bboxes_px_by_value: dict,
    scale: float,
    page_height_by_num: dict,
    emit,
) -> tuple[list[dict], bool]:
    """Gliner code path: chunk full_text, but track each chunk's char offset
    so the entity (start, end) returned by gliner can be reverse-mapped onto
    the OCR words that actually generated those characters.

    Mutates bboxes_pdf_by_value / bboxes_px_by_value in place. Returns
    (all_items, failed).
    """
    overlap = min(200, chunk_size // 10)
    chunk_offsets: list[int] = []
    chunk_texts: list[str] = []
    pos = 0
    while pos < len(full_text):
        chunk_offsets.append(pos)
        chunk_texts.append(full_text[pos:pos + chunk_size])
        pos += chunk_size - overlap
    if not chunk_texts:
        chunk_offsets.append(0)
        chunk_texts.append("")

    seen_global: set[tuple[int, int, str]] = set()
    seen_bbox_keys: set[tuple[str, int, int, int, int, int]] = set()
    all_items: list[dict] = []

    for i, (chunk_offset, chunk) in enumerate(zip(chunk_offsets, chunk_texts), start=1):
        emit({
            "cmd": "detect",
            "phase": "analyze",
            "status": "in_progress",
            "chunk": i,
            "total": len(chunk_texts),
        })
        try:
            entities = query_gliner_entities(chunk)
        except Exception as exc:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr)
            emit({
                "cmd": "detect",
                "status": "error",
                "message": f"gliner failed on chunk {i}: {type(exc).__name__}: {exc!r}",
                "traceback": tb,
            })
            return all_items, True

        print(
            f"[gliner chunk {i}/{len(chunk_texts)}] {len(entities)} raw entities "
            f"(chunk_offset={chunk_offset})",
            file=sys.stderr, flush=True,
        )
        for ent in entities:
            print(
                f"  start={ent.get('start')} end={ent.get('end')} "
                f"label={ent.get('label')!r} score={ent.get('score')} "
                f"text={ent.get('text')!r}",
                file=sys.stderr, flush=True,
            )

        deduped: list[dict] = []
        for ent in entities:
            e_start = ent.get("start")
            e_end = ent.get("end")
            if e_start is None or e_end is None:
                continue
            label = (ent.get("label") or "").strip().lower()
            value = (ent.get("text") or "").strip()
            if not label or not value:
                continue
            g_start = chunk_offset + int(e_start)
            g_end = chunk_offset + int(e_end)
            key = (g_start, g_end, label)
            if key in seen_global:
                continue
            seen_global.add(key)
            deduped.append({
                "start": g_start,
                "end": g_end,
                "text": value,
                "label": label,
            })

        resolved = ocr_scrub.resolve_entities_to_bboxes(word_spans, deduped)

        resolved_starts = {r["value"]: True for r in resolved}
        for d in deduped:
            if d["text"] not in resolved_starts:
                print(
                    f"  [drop] no word overlap for "
                    f"start={d['start']} end={d['end']} "
                    f"label={d['label']!r} text={d['text']!r}",
                    file=sys.stderr, flush=True,
                )

        for r in resolved:
            item = {"type": gliner_label_to_category(r["type"]), "value": r["value"]}
            if not is_valid_pii_item(item):
                continue
            page_num = r["page_num"]
            pdf_bbox = r["bbox"]
            bbox_key = (
                r["value"],
                page_num,
                round(pdf_bbox[0], 1),
                round(pdf_bbox[1], 1),
                round(pdf_bbox[2], 1),
                round(pdf_bbox[3], 1),
            )
            if bbox_key in seen_bbox_keys:
                continue
            seen_bbox_keys.add(bbox_key)

            bboxes_pdf_by_value.setdefault(r["value"], []).append((page_num, pdf_bbox))
            px = _pdf_bbox_to_pixel(pdf_bbox, page_height_by_num[page_num], scale)
            bboxes_px_by_value.setdefault(r["value"], []).append({"page_num": page_num, **px})

            emit({"cmd": "detect", "kind": "pii", "item": item})
            all_items.append(item)

    return all_items, False


def _serve_detect(req: dict, state: dict, defaults: argparse.Namespace, emit=_emit) -> None:
    path = req.get("path")
    if not path:
        emit({"cmd": "detect", "status": "error", "message": "missing 'path'"})
        return

    opts = req.get("options") or {}
    model = opts.get("model", defaults.model)
    chunk_size = int(opts.get("chunk_size", defaults.chunk_size))
    ocr_dpi = int(opts.get("ocr_dpi", defaults.ocr_dpi))
    debug_full_text = bool(opts.get("debug_full_text", getattr(defaults, "debug_full_text", False)))

    _cleanup_image_dir(state)
    state.clear()

    import paddleocr_scrub as ocr_scrub

    image_dir = tempfile.mkdtemp(prefix="idscrub-")
    state["image_dir"] = image_dir

    print(f"[detect] OCR-ing {path} at {ocr_dpi} DPI (images → {image_dir})...", file=sys.stderr)
    emit({"cmd": "detect", "phase": "ocr", "status": "started"})
    try:
        pages = ocr_scrub.ocr_pdf(
            path,
            dpi=ocr_dpi,
            image_output_dir=image_dir,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        emit({
            "cmd": "detect",
            "status": "error",
            "message": f"ocr failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        _cleanup_image_dir(state)
        return

    emit({"cmd": "detect", "phase": "ocr", "status": "done", "pages": len(pages)})

    # Tell the client about each rendered page so it can start displaying
    # them while the LLM chunks through the text.
    for p in pages:
        emit({
            "cmd": "detect",
            "kind": "page",
            "page_num": p.page_num,
            "image_path": p.image_path,
            "image_width": p.image_width,
            "image_height": p.image_height,
        })

    if model != _GLINER_MODEL_NAME:
        emit({
            "cmd": "detect",
            "status": "error",
            "message": f"unsupported model {model!r}; only {_GLINER_MODEL_NAME!r} is supported",
        })
        return

    full_text, word_spans = ocr_scrub.build_indexed_full_text(pages)

    if debug_full_text:
        full_text_path = _default_full_text_path(path)
        overlap = min(200, chunk_size // 10)
        chunks: list[str] = []
        pos = 0
        while pos < len(full_text):
            chunks.append(full_text[pos:pos + chunk_size])
            pos += chunk_size - overlap
        if not chunks:
            chunks = [full_text]
        sep = "\n\n" + ("=" * 80) + "\n\n"
        try:
            with open(full_text_path, "w", encoding="utf-8") as f:
                for i, ch in enumerate(chunks, start=1):
                    f.write(f"[chunk {i}/{len(chunks)}]\n")
                    f.write(ch)
                    if i < len(chunks):
                        f.write(sep)
            print(f"[detect] full OCR text saved to: {full_text_path}", file=sys.stderr)
        except OSError as exc:
            print(f"[detect] failed to write full text: {exc!r}", file=sys.stderr)

    bboxes_pdf_by_value: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = {}
    bboxes_px_by_value: dict[str, list[dict]] = {}
    scale = ocr_dpi / 72.0
    page_height_by_num = {p.page_num: p.page_height for p in pages}

    all_items, gliner_failed = _detect_via_gliner_offsets(
        ocr_scrub=ocr_scrub,
        full_text=full_text,
        word_spans=word_spans,
        chunk_size=chunk_size,
        bboxes_pdf_by_value=bboxes_pdf_by_value,
        bboxes_px_by_value=bboxes_px_by_value,
        scale=scale,
        page_height_by_num=page_height_by_num,
        emit=emit,
    )
    if gliner_failed:
        return

    aggregated = aggregate_results(all_items)

    for entry in aggregated:
        entry["bboxes"] = bboxes_px_by_value.get(entry["value"], [])

    state["pdf_path"] = path
    state["pages"] = pages
    state["ocr_dpi"] = ocr_dpi
    state["ocr_module"] = ocr_scrub
    state["aggregated"] = aggregated
    state["all_items"] = all_items
    state["bboxes_pdf_by_value"] = bboxes_pdf_by_value

    emit({
        "cmd": "detect",
        "phase": "analyze",
        "status": "done",
        "total_pii": len(aggregated),
        "pii": aggregated,
    })


def _serve_scrub(req: dict, state: dict, defaults: argparse.Namespace | None = None, emit=_emit) -> None:
    if "bboxes_pdf_by_value" not in state:
        emit({
            "cmd": "scrub",
            "status": "error",
            "message": "no document loaded; run detect first",
        })
        return

    selected = req.get("selected")
    if not isinstance(selected, list):
        emit({
            "cmd": "scrub",
            "status": "error",
            "message": "missing 'selected' (list of PII values)",
        })
        return

    values = [v.strip() for v in selected if isinstance(v, str) and v.strip()]
    if not values:
        emit({"cmd": "scrub", "status": "error", "message": "no PII values provided"})
        return

    input_pdf = state["pdf_path"]
    output_pdf = req.get("output") or _default_scrubbed_path(input_pdf)
    ocr_scrub = state["ocr_module"]
    ocr_dpi = state["ocr_dpi"]
    default_color = (
        getattr(defaults, "scrub_color", DEFAULT_SCRUB_COLOR)
        if defaults is not None
        else DEFAULT_SCRUB_COLOR
    )
    fill_color = _normalize_hex_color(req.get("color"), default_color)
    cached: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = state["bboxes_pdf_by_value"]

    page_bboxes: dict[int, list[tuple[float, float, float, float]]] = {}
    total_bboxes = 0
    for value in values:
        for page_num, pdf_bbox in cached.get(value, []):
            page_bboxes.setdefault(page_num, []).append(pdf_bbox)
            total_bboxes += 1

    emit({
        "cmd": "scrub",
        "phase": "redact",
        "status": "in_progress",
        "bboxes": total_bboxes,
        "pages": len(page_bboxes),
    })

    if not page_bboxes:
        shutil.copyfile(input_pdf, output_pdf)
        emit({
            "cmd": "scrub",
            "phase": "redact",
            "status": "done",
            "output": output_pdf,
            "redacted": False,
        })
        return

    try:
        ocr_scrub.scrub_with_ocr(
            input_pdf, page_bboxes, output_pdf, dpi=ocr_dpi, fill_color=fill_color,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        emit({
            "cmd": "scrub",
            "status": "error",
            "message": f"redaction failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        return

    emit({
        "cmd": "scrub",
        "phase": "redact",
        "status": "done",
        "output": output_pdf,
        "redacted": True,
    })


def _serve_loop(defaults: argparse.Namespace) -> int:
    state: dict = {}
    _emit({"status": "ready"})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"status": "error", "message": f"invalid JSON: {exc}"})
                continue

            cmd = req.get("cmd")
            if cmd == "detect":
                _serve_detect(req, state, defaults)
            elif cmd == "scrub":
                _serve_scrub(req, state, defaults)
            elif cmd == "close":
                break
            else:
                _emit({"status": "error", "message": f"unknown cmd: {cmd!r}"})
    finally:
        _cleanup_image_dir(state)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Detect PII in a PDF file using GLiNER (nvidia/gliner-pii) over OCR'd text.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "pdf",
        nargs="?",
        help="Path to the PDF file to analyze (omit when using --serve)",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help=(
            "Run as a long-lived subprocess speaking NDJSON over stdin/stdout. "
            "Accepts {\"cmd\":\"detect\",\"path\":...} and {\"cmd\":\"scrub\",\"selected\":[...]} requests."
        ),
    )
    parser.add_argument(
        "--model",
        default=_GLINER_MODEL_NAME,
        help=(
            "PII detection model. Only nvidia/gliner-pii is supported; the flag "
            "exists so callers can pin the value explicitly."
        ),
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1000,
        help="Number of characters per chunk sent to the model",
    )
    parser.add_argument(
        "--output",
        help="Write JSON result to this file instead of stdout",
    )
    parser.add_argument(
        "--custom-pii",
        nargs="+",
        help=(
            "Custom PII values to scrub. Pass one or more values after the flag "
            "when a value may not be detected by GLiNER."
        ),
    )
    parser.add_argument(
        "--scrub",
        action="store_true",
        help=(
            "Render each page to an image, OCR it, run GLiNER on the OCR text "
            "for PII detection, then redact by drawing black rectangles over "
            "detected PII and rasterizing the output."
        ),
    )
    parser.add_argument(
        "--scrub-color",
        default=DEFAULT_SCRUB_COLOR,
        help=(
            "Hex color (e.g. '#DC2626') used to fill redaction rectangles. "
            "Overridden per-request by 'color' in serve mode."
        ),
    )
    parser.add_argument(
        "--ocr-dpi",
        type=int,
        default=300,
        help="DPI used when rendering pages for OCR.",
    )
    parser.add_argument(
        "--gliner-onnx-dir",
        default=None,
        help=(
            "Load GLiNER from this ONNX-export directory using onnxruntime "
            "instead of the PyTorch checkpoint. Directory must contain the "
            "files produced by export_gliner_onnx.py."
        ),
    )
    parser.add_argument(
        "--gliner-onnx-file",
        default="model_fp16.onnx",
        help="ONNX file inside --gliner-onnx-dir to load (e.g. model.onnx for fp32).",
    )
    parser.add_argument(
        "--debug-full-text",
        action="store_true",
        help=(
            "Save the full OCR'd text to a .txt file alongside the PDF "
            "(e.g. foo.pdf -> foo_fulltext.txt) for debugging."
        ),
    )
    args = parser.parse_args()

    if not HEX_COLOR_RE.match(args.scrub_color or ""):
        parser.error(f"--scrub-color must be a hex like '#DC2626' (got {args.scrub_color!r})")

    if args.gliner_onnx_dir:
        global _GLINER_ONNX_DIR, _GLINER_ONNX_FILE
        _GLINER_ONNX_DIR = args.gliner_onnx_dir
        _GLINER_ONNX_FILE = args.gliner_onnx_file

    if args.serve:
        sys.exit(_serve_loop(args))

    if not args.pdf:
        parser.error("pdf path is required unless --serve is used")

    source_pdf = args.pdf
    final_scrubbed_path = _default_scrubbed_path(source_pdf)

    _run_ocr_scrub(args, source_pdf, final_scrubbed_path, do_scrub=args.scrub)


if __name__ == "__main__":
    main()
