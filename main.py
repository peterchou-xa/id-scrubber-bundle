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
import sys
from collections import defaultdict
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF not installed. Run: pip install pymupdf")

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
    """Extract all text from a PDF using PyMuPDF."""
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        sys.exit(f"Failed to open PDF '{pdf_path}': {exc}")

    pages = []
    for page_num, page in enumerate(doc, start=1):
        text = page.get_text("text")
        if text.strip():
            pages.append(f"[Page {page_num}]\n{text}")

    doc.close()

    if not pages:
        sys.exit("No extractable text found in the PDF.")

    return "\n\n".join(pages)


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
        if not isinstance(items, list):
            return []
        return items
    except json.JSONDecodeError:
        # Attempt to extract JSON array from response
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        print("Warning: Could not parse model response as JSON.", file=sys.stderr)
        return []


def mask_pii_value(value: str) -> str:
    """Replace each digit with '0' and each letter with 'X', keeping other chars."""
    return "".join(
        "0" if ch.isdigit() else "X" if ch.isalpha() else ch
        for ch in value
    )


def _strip_subset_prefix(name: str) -> str:
    """Strip PDF subset prefix (e.g. 'ABCDEF+') from a font name."""
    return name.split("+", 1)[1] if "+" in name else name


def _build_font_map(doc: fitz.Document, page_num: int) -> dict[str, fitz.Font]:
    """Extract embedded fonts from the page, keyed by normalised font name."""
    font_map: dict[str, fitz.Font] = {}
    for entry in doc.get_page_fonts(page_num):
        xref, _, _, basefont, *_ = entry
        key = _strip_subset_prefix(basefont)
        if key in font_map:
            continue
        try:
            _, _, _, content = doc.extract_font(xref)
            if content:
                font_map[key] = fitz.Font(fontbuffer=content)
        except Exception:
            pass
    return font_map


def _style_for_rect(
    spans: list[dict], rect: fitz.Rect
) -> tuple[float, tuple, str, float]:
    """Return (fontsize, color_rgb, font_name, baseline_y) of the span that best overlaps rect."""
    best_area = 0.0
    fontsize, color, font_name = 11.0, (0.0, 0.0, 0.0), ""
    baseline_y = rect.y1  # fallback if no span matched
    for span in spans:
        overlap = rect & fitz.Rect(span["bbox"])
        if overlap.is_empty:
            continue
        area = overlap.width * overlap.height
        if area > best_area:
            best_area = area
            fontsize = span["size"]
            c = span["color"]  # packed sRGB int
            color = ((c >> 16) / 255, ((c >> 8) & 0xFF) / 255, (c & 0xFF) / 255)
            font_name = _strip_subset_prefix(span["font"])
            baseline_y = span["origin"][1]  # exact baseline from the span
    return fontsize, color, font_name, baseline_y


def scrub_pdf(pdf_path: str, pii_values: list[str], output_path: str) -> None:
    """Generate a new PDF with PII replaced, preserving the original font, size, and color."""
    doc = fitz.open(pdf_path)
    for page_num, page in enumerate(doc):
        font_map = _build_font_map(doc, page_num)
        spans = [
            span
            for block in page.get_text("dict")["blocks"]
            if block.get("type") == 0
            for line in block.get("lines", [])
            for span in line.get("spans", [])
        ]
        # Collect per-rect style info before redacting (redaction mutates the page)
        replacements = []
        for pii in pii_values:
            replacement = mask_pii_value(pii)
            for rect in page.search_for(pii):
                fontsize, text_color, font_name, baseline_y = _style_for_rect(spans, rect)
                replacements.append((rect, replacement, fontsize, text_color, font_name, baseline_y))
                # Mark for redaction — this removes the original text from the content stream
                page.add_redact_annot(rect, fill=(1, 1, 1))

        # Apply redactions first: scrubs original text data so it can't be recovered
        page.apply_redactions()

        # Now overlay the styled replacement text
        for rect, replacement, fontsize, text_color, font_name, baseline_y in replacements:
            font = font_map.get(font_name)
            point = fitz.Point(rect.x0, baseline_y)
            if font:
                tw = fitz.TextWriter(page.rect)
                tw.append(point, replacement, font=font, fontsize=fontsize)
                tw.write_text(page, color=text_color)
                text_width = font.text_length(replacement, fontsize=fontsize)
            else:
                page.insert_text(point, replacement, fontsize=fontsize, color=text_color)
                text_width = fitz.get_text_length(replacement, fontname=font_name, fontsize=fontsize)
            # Draw a transparent highlight border sized to the actual replacement text width
            text_rect = fitz.Rect(rect.x0, rect.y0, rect.x0 + text_width, rect.y1)
            page.draw_rect(text_rect, color=(1, 0.5, 0), width=0.8, fill=(1, 0.85, 0), fill_opacity=0.25)
    doc.save(output_path)
    doc.close()


def aggregate_results(all_items: list[dict]) -> dict:
    """Aggregate detected PII into counts and samples per category."""
    counts: dict[str, int] = defaultdict(int)
    samples: dict[str, list[str]] = defaultdict(list)
    seen: dict[str, set] = defaultdict(set)

    for item in all_items:
        pii_type = item.get("type", "other_pii").strip().lower()
        value = item.get("value", "").strip()

        if not value:
            continue

        # Normalise unknown types
        if pii_type not in PII_CATEGORIES:
            pii_type = "other_pii"

        # De-duplicate identical value per type
        if value not in seen[pii_type]:
            seen[pii_type].add(value)
            counts[pii_type] += 1
            if len(samples[pii_type]) < 3:
                samples[pii_type].append(value)

    result = {}
    for pii_type in PII_CATEGORIES:
        if counts[pii_type]:
            result[pii_type] = {
                "occurrences": counts[pii_type],
                "examples": samples[pii_type],
            }

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Detect PII in a PDF file using Ollama (gemma3).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("pdf", help="Path to the PDF file to analyze")
    parser.add_argument(
        "--model",
        default="gemma3",
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
        "--scrub",
        action="store_true",
        help="Generate a new PDF with PII replaced (digits→0, letters→X).",
    )
    args = parser.parse_args()

    print(f"Extracting text from: {args.pdf}", file=sys.stderr)
    full_text = extract_text_from_pdf(args.pdf)
    print(f"Extracted {len(full_text):,} characters.", file=sys.stderr)

    chunks = chunk_text(full_text, args.chunk_size)
    print(f"Processing {len(chunks)} chunk(s) with model '{args.model}'...", file=sys.stderr)

    all_items: list[dict] = []
    for i, chunk in enumerate(chunks, start=1):
        print(f"  Chunk {i}/{len(chunks)}...", file=sys.stderr, end=" ")
        items = query_ollama(chunk, args.model)
        print(f"{len(items)} PII item(s) found.", file=sys.stderr)
        all_items.extend(items)

    # Collect all unique PII values before aggregation caps examples at 3
    all_pii_values: set[str] = {
        item["value"].strip()
        for item in all_items
        if isinstance(item.get("value"), str) and item["value"].strip()
    }

    summary = aggregate_results(all_items)

    output = {
        "file": args.pdf,
        "model": args.model,
        "total_pii_types_detected": len(summary),
        "pii_summary": summary,
    }

    json_output = json.dumps(output, indent=2, ensure_ascii=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(json_output)
        print(f"Results written to: {args.output}", file=sys.stderr)
    else:
        print(json_output)

    if args.scrub:
        pdf_path = Path(args.pdf)
        scrubbed_path = str(pdf_path.with_stem(pdf_path.stem + "_scrubbed"))
        print(f"Scrubbing PDF...", file=sys.stderr)
        scrub_pdf(args.pdf, sorted(all_pii_values), scrubbed_path)
        print(f"Scrubbed PDF saved to: {scrubbed_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
