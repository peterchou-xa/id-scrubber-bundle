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
from collections import defaultdict
from pathlib import Path

try:
    import pdf_ops
except ImportError:
    sys.exit("pdf_ops module not found. Ensure pdf_ops.py is in the same directory.")

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

For each piece of PII found, output a JSON array where each element has:
- "type": one of {categories}
- "value": the exact string found
- "context": a short surrounding phrase (optional, for disambiguation)

Rules:
- Be thorough — find ALL occurrences.
- Do not infer or hallucinate values. Only report what is explicitly present.
- If no PII is found, return an empty array: []
- Output ONLY the raw JSON array, no markdown fences, no explanation.
""".format(categories=json.dumps(PII_CATEGORIES))


def extract_text_from_pdf(pdf_path: str) -> str:
    """Extract all text from a PDF using pdfminer via pdf_ops."""
    try:
        page_texts = pdf_ops.extract_text(pdf_path)
    except Exception as exc:
        sys.exit(f"Failed to open PDF '{pdf_path}': {exc}")

    if not page_texts:
        sys.exit("No extractable text found in the PDF.")

    return "\n\n".join(f"[Page {num}]\n{text}" for num, text in page_texts)


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
            print(f"Warning: Ollama error on chunk: {exc}", file=sys.stderr)
            return []
    except Exception as exc:
        print(f"Warning: Unexpected error querying Ollama: {exc}", file=sys.stderr)
        return []

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


def filter_pii_values(values: set[str]) -> set[str]:
    """Drop single letters and values subsumed by a longer detected value.

    An LLM will sometimes surface a middle initial ('E') or a state abbreviation
    ('PA') that's already covered by a richer detection ('PITTSBURGH, PA 15260').
    Scrubbing those short tokens standalone would blast unrelated text.
    """
    filtered = {v for v in values if len(v) >= 2}
    sorted_vals = sorted(filtered, key=len, reverse=True)
    result: set[str] = set()
    for v in sorted_vals:
        if any(v != longer and v in longer for longer in result):
            continue
        result.add(v)
    return result


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


def _detect_text_pii(args, pdf_path: str) -> tuple[list[dict], set[str]]:
    print(f"Extracting text from: {pdf_path}", file=sys.stderr)
    full_text = extract_text_from_pdf(pdf_path)
    print(f"Extracted {len(full_text):,} characters.", file=sys.stderr)

    print("text full text: ", full_text)
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

    return all_items, filter_pii_values(all_pii_values)


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
    import ocr_scrub

    print(f"Rendering and OCR-ing pages at {args.ocr_dpi} DPI...", file=sys.stderr)
    pages = ocr_scrub.ocr_pdf(input_pdf, dpi=args.ocr_dpi)
    print(f"  {len(pages)} page(s), {sum(len(p.words) for p in pages)} word(s) total.", file=sys.stderr)

    full_text = "\n\n".join(f"[Page {p.page_num}]\n{p.text}" for p in pages)
    ## TODO delete
    # print("ocr full text: ", full_text)
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
    ocr_scrub.scrub_with_ocr(input_pdf, page_bboxes, pii_list_sorted, output_pdf, dpi=args.ocr_dpi)
    print(f"Scrubbed PDF saved to: {output_pdf}", file=sys.stderr)
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Detect PII in a PDF file using Ollama (gemma3).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("pdf", help="Path to the PDF file to analyze")
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
        help="Generate a new PDF with PII replaced (digits→0, letters→X).",
    )
    parser.add_argument(
        "--ocr-scrub",
        action="store_true",
        help=(
            "Render each page to an image, OCR it, send the OCR text to the "
            "LLM for PII detection, then redact by masking overlapping Tj "
            "operators and overlaying black rectangles. Universal across "
            "fonts (no ToUnicode dependency)."
        ),
    )
    parser.add_argument(
        "--ocr-dpi",
        type=int,
        default=300,
        help="DPI used when rendering pages for OCR (only with --ocr-scrub).",
    )
    args = parser.parse_args()

    source_pdf = args.pdf
    final_scrubbed_path = _default_scrubbed_path(source_pdf)
    intermediate_path: str | None = None

    if args.scrub or not args.ocr_scrub:
        all_items, all_pii_values = _detect_text_pii(args, source_pdf)
        pii_list = aggregate_results(all_items)
        _write_json_output(args, source_pdf, pii_list)

    if args.scrub:
        try:
            print(f"Scrubbing PDF...", file=sys.stderr)
            print(f"PII values to scrub ({len(all_pii_values)}):", file=sys.stderr)
            for v in sorted(all_pii_values, key=len, reverse=True):
                print(f"  {repr(v)}", file=sys.stderr)

            if args.ocr_scrub:
                tmp = tempfile.NamedTemporaryFile(
                    prefix=Path(source_pdf).stem + "_text_",
                    suffix=".pdf",
                    delete=False,
                )
                tmp.close()
                intermediate_path = tmp.name
                pdf_ops.scrub_pdf(
                    source_pdf, sorted(all_pii_values), intermediate_path
                )
                print(
                    f"Chaining OCR scrub on top of text-scrubbed PDF: {intermediate_path}",
                    file=sys.stderr,
                )
                _run_ocr_scrub(args, intermediate_path, final_scrubbed_path)
            else:
                pdf_ops.scrub_pdf(
                    source_pdf, sorted(all_pii_values), final_scrubbed_path
                )
                print(f"Scrubbed PDF saved to: {final_scrubbed_path}", file=sys.stderr)
        finally:
            if intermediate_path and os.path.exists(intermediate_path):
                os.unlink(intermediate_path)

        return

    if args.ocr_scrub:
        _run_ocr_scrub(args, source_pdf, final_scrubbed_path)


if __name__ == "__main__":
    main()
