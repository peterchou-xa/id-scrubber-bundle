#!/usr/bin/env python3
"""
PII Detector: Parses a PDF and uses Ollama (gemma3) to detect personally
identifiable information (PII), returning a JSON summary of types and counts.

Usage:
    python main.py <path_to_pdf> [--model gemma3] [--chunk-size 3000]
"""

import argparse
import json
import re
import shutil
import sys
import traceback
from collections import defaultdict
from pathlib import Path

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

Each "value" must be the minimal atomic span that identifies one PII item.
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
  "1234 S Maple St Apt 5, Anytown, NY 10001",
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


def query_ollama(text_chunk: str, model: str) -> list[dict]:
    """Send a text chunk to Ollama and parse the PII JSON response."""
    user_message = (
        "Analyze the following text and return all PII as a JSON array:\n\n"
        + text_chunk
    )

    try:
        response = ollama.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            options={"temperature": 0},
        )
    except ollama.ResponseError as exc:
        if "not found" in str(exc).lower() or "pull" in str(exc).lower():
            print(f"Model '{model}' not found locally. Pulling now...")
            try:
                ollama.pull(model)
            except Exception as pull_exc:
                sys.exit(f"Failed to pull model '{model}': {pull_exc}")
            # Retry after pull
            response = ollama.chat(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                options={"temperature": 0},
            )
        else:
            raise RuntimeError(f"Ollama error on chunk: {exc}") from exc

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
    """OCR-based scrub flow: render → OCR → LLM → bbox → redact."""
    if args.rapidocr:
        import rapidocr_scrub as ocr_scrub
        backend = "rapidocr"
    else:
        import ocr_scrub
        backend = "tesseract"

    print(f"Rendering and OCR-ing pages at {args.ocr_dpi} DPI using {backend}...", file=sys.stderr)
    ocr_kwargs = {"dpi": args.ocr_dpi}
    if args.rapidocr:
        ocr_kwargs["det_model"] = args.rapidocr_det_model
    pages = ocr_scrub.ocr_pdf(input_pdf, **ocr_kwargs)
    print(f"  {len(pages)} page(s), {sum(len(p.words) for p in pages)} word(s) total.", file=sys.stderr)

    full_text = "\n\n".join(f"[Page {p.page_num}]\n{p.text}" for p in pages)
    ## TODO delete
    print("ocr full text: ", full_text)
    print(f"OCR extracted {len(full_text):,} characters.", file=sys.stderr)

    chunks = chunk_text(full_text, args.chunk_size)
    print(f"Processing {len(chunks)} chunk(s) with model '{args.model}'...", file=sys.stderr)

    all_items: list[dict] = []
    for i, chunk in enumerate(chunks, start=1):
        print(f"  Chunk {i}/{len(chunks)}...", file=sys.stderr, end=" ")
        items = query_ollama(chunk, args.model)
        print(f"{len(items)} PII item(s) found.", file=sys.stderr)
        all_items.extend(items)

    all_pii_values: set[str] = {
        item["value"].strip()
        for item in all_items
        if isinstance(item.get("value"), str) and item["value"].strip()
    }
    all_pii_values.update(parse_custom_pii_values(args.custom_pii))
    # Don't run filter_pii_values here: in OCR mode each variant needs its
    # own independent match (e.g., both "51106" and "51106-3639" may appear
    # on different parts of the page).
    pii_list_sorted = sorted(all_pii_values)

    pii_list = aggregate_results(all_items)
    _write_json_output(args, input_pdf, pii_list)

    # Map PII → bboxes per page.
    page_bboxes: dict[int, list[tuple[float, float, float, float]]] = {}
    total_bboxes = 0
    for page in pages:
        bboxes = ocr_scrub.find_pii_bboxes(page, pii_list_sorted)
        if bboxes:
            page_bboxes[page.page_num] = bboxes
            total_bboxes += len(bboxes)

    print(f"Matched {total_bboxes} PII region(s) across {len(page_bboxes)} page(s).", file=sys.stderr)
    if not page_bboxes:
        print("Nothing to redact in OCR pass.", file=sys.stderr)
        shutil.copyfile(input_pdf, output_pdf)
        print(f"Scrubbed PDF saved to: {output_pdf}", file=sys.stderr)
        return False

    print(f"Redacting PDF (rasterizing at {args.ocr_dpi} DPI)...", file=sys.stderr)
    ocr_scrub.scrub_with_ocr(input_pdf, page_bboxes, output_pdf, dpi=args.ocr_dpi)
    print(f"Scrubbed PDF saved to: {output_pdf}", file=sys.stderr)
    return True


def _emit(obj: dict) -> None:
    """Write one NDJSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _serve_detect(req: dict, state: dict, defaults: argparse.Namespace) -> None:
    path = req.get("path")
    if not path:
        _emit({"event": "error", "cmd": "detect", "message": "missing 'path'"})
        return

    opts = req.get("options") or {}
    model = opts.get("model", defaults.model)
    chunk_size = int(opts.get("chunk_size", defaults.chunk_size))
    ocr_dpi = int(opts.get("ocr_dpi", defaults.ocr_dpi))
    use_rapidocr = bool(opts.get("rapidocr", defaults.rapidocr))
    rapidocr_det_model = opts.get("rapidocr_det_model", defaults.rapidocr_det_model)

    state.clear()

    if use_rapidocr:
        import rapidocr_scrub as ocr_scrub
    else:
        import ocr_scrub

    print(f"[serve] detect: OCR-ing {path} at {ocr_dpi} DPI...", file=sys.stderr)
    ocr_kwargs = {"dpi": ocr_dpi}
    if use_rapidocr:
        ocr_kwargs["det_model"] = rapidocr_det_model
    try:
        pages = ocr_scrub.ocr_pdf(path, **ocr_kwargs)
    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        _emit({
            "event": "error",
            "cmd": "detect",
            "message": f"ocr failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        return

    _emit({"event": "progress", "cmd": "detect", "stage": "ocr_done", "pages": len(pages)})

    full_text = "\n\n".join(f"[Page {p.page_num}]\n{p.text}" for p in pages)
    chunks = chunk_text(full_text, chunk_size)

    all_items: list[dict] = []
    for i, chunk in enumerate(chunks, start=1):
        try:
            items = query_ollama(chunk, model)
        except Exception as exc:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr)
            _emit({
                "event": "error",
                "cmd": "detect",
                "message": f"ollama failed on chunk {i}: {type(exc).__name__}: {exc!r}",
                "traceback": tb,
            })
            return
        for item in items:
            _emit({"event": "pii", "cmd": "detect", "item": item})
        all_items.extend(items)
        _emit({
            "event": "progress",
            "cmd": "detect",
            "stage": "chunk",
            "chunk": i,
            "total": len(chunks),
        })

    aggregated = aggregate_results(all_items)

    state["pdf_path"] = path
    state["pages"] = pages
    state["ocr_dpi"] = ocr_dpi
    state["ocr_module"] = ocr_scrub
    state["aggregated"] = aggregated

    _emit({
        "event": "done",
        "cmd": "detect",
        "total_pii": len(aggregated),
        "pii": aggregated,
    })


def _serve_scrub(req: dict, state: dict) -> None:
    if "pages" not in state:
        _emit({
            "event": "error",
            "cmd": "scrub",
            "message": "no document loaded; run detect first",
        })
        return

    selected = req.get("selected")
    if not isinstance(selected, list):
        _emit({
            "event": "error",
            "cmd": "scrub",
            "message": "missing 'selected' (list of PII values)",
        })
        return

    values: set[str] = {v.strip() for v in selected if isinstance(v, str) and v.strip()}
    if not values:
        _emit({"event": "error", "cmd": "scrub", "message": "no PII values provided"})
        return

    input_pdf = state["pdf_path"]
    output_pdf = _default_scrubbed_path(input_pdf)
    ocr_scrub = state["ocr_module"]
    ocr_dpi = state["ocr_dpi"]
    pages = state["pages"]

    pii_list_sorted = sorted(values)
    page_bboxes: dict[int, list[tuple[float, float, float, float]]] = {}
    total_bboxes = 0
    for page in pages:
        bboxes = ocr_scrub.find_pii_bboxes(page, pii_list_sorted)
        if bboxes:
            page_bboxes[page.page_num] = bboxes
            total_bboxes += len(bboxes)

    _emit({
        "event": "progress",
        "cmd": "scrub",
        "stage": "matched",
        "bboxes": total_bboxes,
        "pages": len(page_bboxes),
    })

    if not page_bboxes:
        shutil.copyfile(input_pdf, output_pdf)
        _emit({
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
        _emit({
            "event": "error",
            "cmd": "scrub",
            "message": f"redaction failed: {type(exc).__name__}: {exc!r}",
            "traceback": tb,
        })
        return

    _emit({
        "event": "done",
        "cmd": "scrub",
        "output": output_pdf,
        "redacted": True,
    })


def _serve_loop(defaults: argparse.Namespace) -> int:
    state: dict = {}
    _emit({"event": "ready"})
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
        default=3000,
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
