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
    print(full_text)
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

    all_pii_values = filter_pii_values(all_pii_values)

    pii_list = aggregate_results(all_items)

    output = {
        "file": args.pdf,
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

    if args.scrub:
        pdf_path = Path(args.pdf)
        scrubbed_path = str(pdf_path.with_stem(pdf_path.stem + "_scrubbed"))
        print(f"Scrubbing PDF...", file=sys.stderr)
        print(f"PII values to scrub ({len(all_pii_values)}):", file=sys.stderr)
        for v in sorted(all_pii_values, key=len, reverse=True):
            print(f"  {repr(v)}", file=sys.stderr)
        pdf_ops.scrub_pdf(args.pdf, sorted(all_pii_values), scrubbed_path)
        print(f"Scrubbed PDF saved to: {scrubbed_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
