#!/usr/bin/env python3
"""
PII Detector: Parses a PDF and uses Ollama (gemma3) to detect personally
identifiable information (PII), returning a JSON summary of types and counts.

Usage:
    python main.py <path_to_pdf> [--model gemma3] [--chunk-size 3000]
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

_PROXY_ENV_KEYS = (
    "http_proxy", "https_proxy", "all_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
)
_popped = {k: os.environ.pop(k, None) for k in _PROXY_ENV_KEYS if k in os.environ}
if _popped:
    print(f"[startup] popped proxy env: {_popped}", file=sys.stderr, flush=True)

try:
    import ollama
except ImportError:
    sys.exit("ollama not installed. Run: pip install ollama")



PII_CATEGORIES = [
    "full_name",
    "date_of_birth",
    "passport_number",
    "national_id",
    "email_address",
    "phone_number",
    "home_address",
    "social_security_number",
    "credit_card_number",
    "bank_account_number",
    "ip_address",
    "other_pii",
]

SYSTEM_PROMPT = """\
You are a PII (Personally Identifiable Information) detection assistant.
Your task is to analyze text and identify every occurrence of PII.

For each piece of PII found, output a JSON array where each element has
exactly two fields:
- "type": one of {categories}
- "value": the exact string found

Example output:
[{{"type": "full_name", "value": "Jane Doe"}}, {{"type": "email_address", "value": "jane.doe@example.com"}}]

Each "value" must be one full PII item.
Do not include field labels, column headers, or adjacent unrelated tokens
in the value. US-format examples of the acceptable variety per category:
- full_name: "Jane Doe", "Dr. Alan T. Turing", "Mary-Jane O'Neill",
  "Robert E. Lee Jr.", "J. K. Rowling"
- date_of_birth: "03/14/1987", "3/14/87", "March 14, 1987",
  "Mar 14, 1987", "1987-03-14", "14-MAR-1987"
- passport_number: "A12345678", "123456789" (9 alphanumeric chars)
- national_id: "123-45-6789", "123456789" (treat same as SSN if in doubt)
- email_address: "jane.doe@example.com", "j.doe+tag@sub.example.co",
  "first_last@example.org"
- phone_number: "(415) 555-0199", "415-555-0199", "415.555.0199",
  "+1-415-555-0199", "4155550199", "1 (415) 555-0199 ext. 1234"
- home_address: "742 Evergreen Terrace, Springfield, IL 62704",
  "1234 S Maple St Apt 5 Anytown, NY 10001",
  "P.O. Box 1234, Anytown, CA 90210"
- social_security_number: "123-45-6789", "123456789", "XXX-XX-6789"
- credit_card_number: "4111 1111 1111 1111", "4111-1111-1111-1111",
  "4111111111111111", "378282246310005" (15-digit Amex)
- bank_account_number: "000123456789", "12345678" (8–17 digits),
  routing+account pairs like "021000021 000123456789"
- ip_address: "192.0.2.42", "2001:db8::1", "::ffff:192.0.2.42"
- other_pii: a single specific identifier not covered above (e.g.
  "driver's license D1234567", "EIN 12-3456789"), never a sentence

Rules:
- Be thorough — find ALL occurrences.
- Do not infer or hallucinate values. Only report what is explicitly present.
- If a line contains multiple PII items, emit each as its own entry.
- If no PII is found, return an empty array: []
- Output ONLY the raw JSON array, no markdown fences, no explanation.
""".format(categories=json.dumps(PII_CATEGORIES))


def chunk_text(text: str, chunk_size: int) -> list[str]:
    """Split text into overlapping chunks to stay within context limits."""
    overlap = min(200, chunk_size // 10)
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


_OLLAMA_CLIENT = None


def _get_client():
    """Build a single ollama.Client that explicitly disables HTTP proxies.
    Without this the underlying httpx Client picks up http_proxy /
    https_proxy / ALL_PROXY from the environment and tries to route
    127.0.0.1:11434 traffic through them, which silently hangs.
    """
    global _OLLAMA_CLIENT
    if _OLLAMA_CLIENT is not None:
        return _OLLAMA_CLIENT

    host = os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434"
    print(f"[ollama] building client host={host} (proxy disabled, timeout=120s)", file=sys.stderr, flush=True)
    # `proxy=None` overrides httpx's env-based proxy detection. trust_env=False
    # also stops httpx from re-reading HTTP_PROXY / NO_PROXY at request time.
    try:
        import httpx
        transport = httpx.HTTPTransport(proxy=None, retries=0)
        _OLLAMA_CLIENT = ollama.Client(host=host, timeout=120.0, trust_env=False, transport=transport)
        print("[ollama] client variant=full (trust_env=False, proxy=None)", file=sys.stderr, flush=True)
    except TypeError as exc:
        # Older ollama versions don't accept transport/trust_env kwargs.
        _OLLAMA_CLIENT = ollama.Client(host=host, timeout=120.0)
        print(f"[ollama] client variant=fallback (TypeError on full kwargs: {exc!r})", file=sys.stderr, flush=True)
    return _OLLAMA_CLIENT


def _chat_once(model: str, user_message: str):
    client = _get_client()
    print(f"[ollama chat] -> POST /api/chat model={model} msg_len={len(user_message)}", file=sys.stderr, flush=True)
    t0 = time.monotonic()
    try:
        response = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            options={"temperature": 0},
        )
    except Exception as exc:
        elapsed = time.monotonic() - t0
        print(f"[ollama chat] <- FAILED after {elapsed:.1f}s: {type(exc).__name__}: {exc!r}", file=sys.stderr, flush=True)
        raise
    elapsed = time.monotonic() - t0
    print(f"[ollama chat] <- OK in {elapsed:.1f}s", file=sys.stderr, flush=True)
    return response


def query_ollama(text_chunk: str, model: str) -> list[dict]:
    """Send a text chunk to Ollama and parse the PII JSON response."""
    user_message = (
        "Analyze the following text and return all PII as a JSON array:\n\n"
        + text_chunk
    )

    transient_statuses = {502, 503, 504}
    max_attempts = 8
    response = None
    for attempt in range(1, max_attempts + 1):
        try:
            if attempt == 1:
                proxy_env = {
                    k: v
                    for k, v in os.environ.items()
                    if "proxy" in k.lower()
                }
                print(
                    f"[ollama chat] attempt=1 host={os.environ.get('OLLAMA_HOST') or '(default)'} "
                    f"proxy_env={proxy_env}",
                    file=sys.stderr,
                    flush=True,
                )
            response = _chat_once(model, user_message)
            break
        except ollama.ResponseError as exc:
            status = getattr(exc, "status_code", None)
            err_attr = getattr(exc, "error", None)
            body = getattr(getattr(exc, "response", None), "text", None)
            detail = (
                f"attempt={attempt}/{max_attempts} status={status} error={err_attr!r} "
                f"body={body!r} repr={exc!r} "
                f"host={os.environ.get('OLLAMA_HOST') or '(default)'} model={model}"
            )
            print(f"[ollama chat failed] {detail}", file=sys.stderr, flush=True)

            if "not found" in str(exc).lower() or "pull" in str(exc).lower():
                print(f"Model '{model}' not found locally. Pulling now...")
                try:
                    ollama.pull(model)
                except Exception as pull_exc:
                    sys.exit(f"Failed to pull model '{model}': {pull_exc}")
                response = _chat_once(model, user_message)
                break

            if status in transient_statuses and attempt < max_attempts:
                wait = min(2 ** (attempt - 1), 10)
                print(
                    f"[ollama chat] transient {status}, retrying in {wait}s...",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(wait)
                continue

            raise RuntimeError(f"Ollama error on chunk: {exc}") from exc

    if response is None:
        raise RuntimeError("Ollama chat returned no response after retries")

    raw = response["message"]["content"].strip()

    # Strip markdown code fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            try:
                items = json.loads(match.group())
            except json.JSONDecodeError:
                print("Warning: Could not parse model response as JSON.", file=sys.stderr)
                return []
        else:
            print("Warning: Could not parse model response as JSON.", file=sys.stderr)
            return []

    if not isinstance(items, list):
        return []
    return [it for it in items if isinstance(it, dict) and is_valid_pii_item(it)]


_GLINER_MODEL_NAME = "nvidia/gliner-pii"

# Labels passed to nvidia/gliner-pii at inference time.
_GLINER_LABELS = [
    "full_name", "first_name", "last_name",
    "email", "phone_number",
    "date_of_birth",
    "passport_number",
    "national_id", "ssn",
    "street_address", "address", "mailing_address",
    "credit_card", "bank_account_number",
    "ip_address", "city", "state", "postcode", "po_box"
]

_GLINER_MODEL = None


def _get_gliner_model():
    global _GLINER_MODEL
    if _GLINER_MODEL is not None:
        return _GLINER_MODEL
    try:
        from gliner import GLiNER
    except ImportError:
        sys.exit("gliner not installed. Run: pip install gliner")
    print(f"[gliner] loading {_GLINER_MODEL_NAME}...", file=sys.stderr, flush=True)
    t0 = time.monotonic()
    _GLINER_MODEL = GLiNER.from_pretrained(_GLINER_MODEL_NAME)
    print(f"[gliner] model loaded in {time.monotonic() - t0:.1f}s", file=sys.stderr, flush=True)
    return _GLINER_MODEL


def query_gliner(text_chunk: str, threshold: float = 0.5) -> list[dict]:
    """Run nvidia/gliner-pii on a text chunk and return [{type, value}] items."""
    model = _get_gliner_model()
    t0 = time.monotonic()
    entities = model.predict_entities(text_chunk, _GLINER_LABELS, threshold=threshold)
    print(
        f"[gliner] {len(entities)} entities in {time.monotonic() - t0:.1f}s",
        file=sys.stderr, flush=True,
    )
    items = []
    for ent in entities:
        raw_label = (ent.get("label") or "").strip().lower()
        value = (ent.get("text") or "").strip()
        if value and raw_label:
            items.append({"type": raw_label, "value": value})
    return [it for it in items if is_valid_pii_item(it)]


def query_gliner_entities(text_chunk: str, threshold: float = 0.3) -> list[dict]:
    """Run nvidia/gliner-pii and preserve per-entity char offsets.

    Returns raw [{start, end, text, label}, ...] entities so the caller
    can reverse-map (start, end) onto OCR words instead of re-matching
    the value as a string (which produces false positives for short
    values like "WA" hitting "WALMART").
    """
    model = _get_gliner_model()
    t0 = time.monotonic()
    entities = model.predict_entities(text_chunk, _GLINER_LABELS, threshold=threshold)
    print(
        f"[gliner] {len(entities)} entities in {time.monotonic() - t0:.1f}s",
        file=sys.stderr, flush=True,
    )
    return entities


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_pii_item(item: dict) -> bool:
    """Drop LLM detections whose value obviously doesn't match the claimed type.

    The small OCR'd-PDF pipeline sees a lot of garbled Tesseract output, and
    smaller models will happily label noise like '[e |' as an email_address.
    """
    pii_type = (item.get("type") or "").strip().lower()
    value = (item.get("value") or "").strip()
    if not value:
        return False
    if pii_type == "email_address" and not EMAIL_RE.match(value):
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
        pii_type = item.get("type", "other_pii").strip().lower()
        value = item.get("value", "").strip()

        if not value:
            continue

        if pii_type not in PII_CATEGORIES:
            pii_type = "other_pii"

        seen[(pii_type, value)] += 1

    # Sort by category order then value
    cat_order = {c: i for i, c in enumerate(PII_CATEGORIES)}
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


def _run_ocr_scrub(args, input_pdf: str, output_pdf: str) -> bool:
    """OCR-based scrub flow: chains _serve_detect + _serve_scrub with a
    CLI-flavored event sink."""
    failed = {"value": False}
    detect_done: dict = {}
    scrub_done: dict = {}

    def cli_emit(obj: dict) -> None:
        event = obj.get("event")
        cmd = obj.get("cmd")
        if event == "error":
            print(f"[{cmd}] ERROR: {obj.get('message')}", file=sys.stderr)
            failed["value"] = True
        elif event == "progress":
            stage = obj.get("stage")
            if cmd == "detect" and stage == "ocr_done":
                print(f"OCR complete: {obj['pages']} page(s).", file=sys.stderr)
            elif cmd == "detect" and stage == "chunk":
                print(f"  Chunk {obj['chunk']}/{obj['total']} processed.", file=sys.stderr)
            elif cmd == "scrub" and stage == "matched":
                print(
                    f"Matched {obj['bboxes']} PII region(s) across {obj['pages']} page(s).",
                    file=sys.stderr,
                )
        elif event == "done":
            if cmd == "detect":
                detect_done.update(obj)
            elif cmd == "scrub":
                scrub_done.update(obj)
        # 'pii' events are silent on the CLI; full list is written via _write_json_output.

    detect_req = {
        "path": input_pdf,
        "options": {
            "model": args.model,
            "chunk_size": args.chunk_size,
            "ocr_dpi": args.ocr_dpi,
            "rapidocr_det_model": args.rapidocr_det_model,
            "paddleocr": args.paddleocr,
        },
    }
    state: dict = {}
    try:
        _serve_detect(detect_req, state, args, emit=cli_emit)
        if failed["value"]:
            return False

        pii_list = detect_done.get("pii", [])
        _write_json_output(args, input_pdf, pii_list)

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
        _serve_scrub({"selected": selected, "output": output_pdf}, state, emit=cli_emit)
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


def _get_ocr_module(opts_or_args):
    """Pick the OCR backend module based on the --paddleocr flag.

    Accepts either an argparse.Namespace (CLI defaults) or a request opts
    dict (per-call override from the serve loop)."""
    if isinstance(opts_or_args, dict):
        use_paddle = bool(opts_or_args.get("paddleocr", False))
    else:
        use_paddle = bool(getattr(opts_or_args, "paddleocr", False))
    if use_paddle:
        import paddleocr_scrub as ocr_scrub
    else:
        import rapidocr_scrub as ocr_scrub
    return ocr_scrub


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
        try:
            entities = query_gliner_entities(chunk)
        except Exception as exc:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr)
            emit({
                "event": "error",
                "cmd": "detect",
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
            item = {"type": r["type"], "value": r["value"]}
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

            emit({"event": "pii", "cmd": "detect", "item": item})
            all_items.append(item)

        emit({
            "event": "progress",
            "cmd": "detect",
            "stage": "chunk",
            "chunk": i,
            "total": len(chunk_texts),
        })

    return all_items, False


def _serve_detect(req: dict, state: dict, defaults: argparse.Namespace, emit=_emit) -> None:
    path = req.get("path")
    if not path:
        emit({"event": "error", "cmd": "detect", "message": "missing 'path'"})
        return

    opts = req.get("options") or {}
    model = opts.get("model", defaults.model)
    chunk_size = int(opts.get("chunk_size", defaults.chunk_size))
    ocr_dpi = int(opts.get("ocr_dpi", defaults.ocr_dpi))
    rapidocr_det_model = opts.get("rapidocr_det_model", defaults.rapidocr_det_model)
    debug_full_text = bool(opts.get("debug_full_text", getattr(defaults, "debug_full_text", False)))

    _cleanup_image_dir(state)
    state.clear()

    ocr_scrub = _get_ocr_module(opts if "paddleocr" in opts else defaults)

    image_dir = tempfile.mkdtemp(prefix="idscrub-")
    state["image_dir"] = image_dir

    print(f"[detect] OCR-ing {path} at {ocr_dpi} DPI (images → {image_dir})...", file=sys.stderr)
    try:
        pages = ocr_scrub.ocr_pdf(
            path,
            dpi=ocr_dpi,
            det_model=rapidocr_det_model,
            image_output_dir=image_dir,
        )
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        emit({
            "event": "error",
            "cmd": "detect",
            "message": f"ocr failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        _cleanup_image_dir(state)
        return

    emit({"event": "progress", "cmd": "detect", "stage": "ocr_done", "pages": len(pages)})

    # Tell the client about each rendered page so it can start displaying
    # them while the LLM chunks through the text.
    for p in pages:
        emit({
            "event": "page",
            "cmd": "detect",
            "page_num": p.page_num,
            "image_path": p.image_path,
            "image_width": p.image_width,
            "image_height": p.image_height,
        })

    use_gliner = model == _GLINER_MODEL_NAME

    if use_gliner:
        full_text, word_spans = ocr_scrub.build_indexed_full_text(pages)
    else:
        full_text = "\n\n".join(f"[Page {p.page_num}]\n{p.text}" for p in pages)
        word_spans = None

    if debug_full_text:
        full_text_path = _default_full_text_path(path)
        try:
            with open(full_text_path, "w", encoding="utf-8") as f:
                f.write(full_text)
            print(f"[detect] full OCR text saved to: {full_text_path}", file=sys.stderr)
        except OSError as exc:
            print(f"[detect] failed to write full text: {exc!r}", file=sys.stderr)

    bboxes_pdf_by_value: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = {}
    bboxes_px_by_value: dict[str, list[dict]] = {}
    scale = ocr_dpi / 72.0
    page_height_by_num = {p.page_num: p.page_height for p in pages}

    if use_gliner:
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
    else:
        chunks = chunk_text(full_text, chunk_size)
        all_items = []
        for i, chunk in enumerate(chunks, start=1):
            try:
                items = query_ollama(chunk, model)
            except Exception as exc:
                tb = traceback.format_exc()
                print(tb, file=sys.stderr)
                emit({
                    "event": "error",
                    "cmd": "detect",
                    "message": f"ollama failed on chunk {i}: {type(exc).__name__}: {exc!r}",
                    "traceback": tb,
                })
                return
            for item in items:
                emit({"event": "pii", "cmd": "detect", "item": item})
            all_items.extend(items)
            emit({
                "event": "progress",
                "cmd": "detect",
                "stage": "chunk",
                "chunk": i,
                "total": len(chunks),
            })

        detected_values = sorted({
            item["value"].strip()
            for item in all_items
            if isinstance(item.get("value"), str) and item["value"].strip()
        })
        for v in detected_values:
            bboxes_pdf_by_value.setdefault(v, [])
            bboxes_px_by_value.setdefault(v, [])
        for page in pages:
            per_value = ocr_scrub.find_pii_bboxes_by_value(page, detected_values)
            for value, pdf_bboxes in per_value.items():
                for pdf_bbox in pdf_bboxes:
                    bboxes_pdf_by_value[value].append((page.page_num, pdf_bbox))
                    px = _pdf_bbox_to_pixel(pdf_bbox, page.page_height, scale)
                    bboxes_px_by_value[value].append({"page_num": page.page_num, **px})

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
        "event": "done",
        "cmd": "detect",
        "total_pii": len(aggregated),
        "pii": aggregated,
    })


def _serve_scrub(req: dict, state: dict, emit=_emit) -> None:
    if "bboxes_pdf_by_value" not in state:
        emit({
            "event": "error",
            "cmd": "scrub",
            "message": "no document loaded; run detect first",
        })
        return

    selected = req.get("selected")
    if not isinstance(selected, list):
        emit({
            "event": "error",
            "cmd": "scrub",
            "message": "missing 'selected' (list of PII values)",
        })
        return

    values = [v.strip() for v in selected if isinstance(v, str) and v.strip()]
    if not values:
        emit({"event": "error", "cmd": "scrub", "message": "no PII values provided"})
        return

    input_pdf = state["pdf_path"]
    output_pdf = req.get("output") or _default_scrubbed_path(input_pdf)
    ocr_scrub = state["ocr_module"]
    ocr_dpi = state["ocr_dpi"]
    cached: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = state["bboxes_pdf_by_value"]

    page_bboxes: dict[int, list[tuple[float, float, float, float]]] = {}
    total_bboxes = 0
    for value in values:
        for page_num, pdf_bbox in cached.get(value, []):
            page_bboxes.setdefault(page_num, []).append(pdf_bbox)
            total_bboxes += 1

    emit({
        "event": "progress",
        "cmd": "scrub",
        "stage": "matched",
        "bboxes": total_bboxes,
        "pages": len(page_bboxes),
    })

    if not page_bboxes:
        shutil.copyfile(input_pdf, output_pdf)
        emit({
            "event": "done",
            "cmd": "scrub",
            "output": output_pdf,
            "redacted": False,
        })
        return

    try:
        ocr_scrub.scrub_with_ocr(input_pdf, page_bboxes, output_pdf, dpi=ocr_dpi)
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        emit({
            "event": "error",
            "cmd": "scrub",
            "message": f"redaction failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        return

    emit({
        "event": "done",
        "cmd": "scrub",
        "output": output_pdf,
        "redacted": True,
    })


def _serve_loop(defaults: argparse.Namespace) -> int:
    state: dict = {}
    _emit({"event": "ready"})
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"event": "error", "message": f"invalid JSON: {exc}"})
                continue

            cmd = req.get("cmd")
            if cmd == "detect":
                _serve_detect(req, state, defaults)
            elif cmd == "scrub":
                _serve_scrub(req, state)
            elif cmd == "close":
                break
            else:
                _emit({"event": "error", "message": f"unknown cmd: {cmd!r}"})
    finally:
        _cleanup_image_dir(state)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Detect PII in a PDF file using Ollama (gemma3).",
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
        default="gemma3:4b",
        help="Ollama model to use (e.g. gemma3, gemma3:4b, gemma2)",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=2500,
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
            "when a value may not be detected by Ollama."
        ),
    )
    parser.add_argument(
        "--scrub",
        action="store_true",
        help=(
            "Render each page to an image, OCR it, send the OCR text to the "
            "LLM for PII detection, then redact by drawing black rectangles "
            "over detected PII and rasterizing the output."
        ),
    )
    parser.add_argument(
        "--ocr-dpi",
        type=int,
        default=600,
        help="DPI used when rendering pages for OCR.",
    )
    parser.add_argument(
        "--rapidocr",
        action="store_true",
        help=(
            "Use RapidOCR (ONNX Runtime) instead of Tesseract. "
            "No native binary dependency; bboxes are estimated per-word "
            "from line-level detections."
        ),
    )
    parser.add_argument(
        "--paddleocr",
        action="store_true",
        help=(
            "Use PaddleOCR instead of RapidOCR. Per-word bboxes are "
            "approximated by slicing line polygons proportionally."
        ),
    )
    parser.add_argument(
        "--debug-full-text",
        action="store_true",
        help=(
            "Save the full OCR'd text to a .txt file alongside the PDF "
            "(e.g. foo.pdf -> foo_fulltext.txt) for debugging."
        ),
    )
    parser.add_argument(
        "--rapidocr-det-model",
        choices=("mobile", "server"),
        default="mobile",
        help=(
            "RapidOCR text detector variant. 'server' has higher recall on "
            "thin/small text at ~3x the latency."
        ),
    )
    args = parser.parse_args()

    if args.serve:
        sys.exit(_serve_loop(args))

    if not args.pdf:
        parser.error("pdf path is required unless --serve is used")

    source_pdf = args.pdf
    final_scrubbed_path = _default_scrubbed_path(source_pdf)

    if args.scrub:
        _run_ocr_scrub(args, source_pdf, final_scrubbed_path)


if __name__ == "__main__":
    main()
