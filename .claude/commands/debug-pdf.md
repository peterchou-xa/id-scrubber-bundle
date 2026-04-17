Render a PDF through the full OCR scrub pipeline and save the redacted page images as PNGs for visual debugging.

Usage: /debug-pdf <pdf_path> [--custom-pii <values>] [--dpi <dpi>] [--model <model>]

Arguments from $ARGUMENTS:
- First positional arg: path to the PDF file
- --custom-pii: Comma-separated extra PII values to add on top of LLM detections
- --dpi: Resolution for rendering (default: 300)
- --model: Ollama model (default: gemma3:4b)

Run the following Python script via `bin/python3`, substituting the arguments parsed from $ARGUMENTS into the variables at the top. Set `no_proxy` and `NO_PROXY` env vars to `localhost,127.0.0.1` before running.

```python
import sys
sys.path.insert(0, '/Users/peterchou/workspaces/identity-scrubber')

import ocr_scrub
from main import chunk_text, query_ollama, parse_custom_pii_values, is_valid_pii_item

# ── Substitute these from $ARGUMENTS ──
pdf_path = "$PDF_PATH"
dpi = 300          # from --dpi
model = "gemma3:4b"  # from --model
chunk_size = 3000
custom_pii_raw = []  # from --custom-pii, split by comma into list

# ── Step 1: OCR ──
print("OCR-ing pages...", file=sys.stderr)
pages = ocr_scrub.ocr_pdf(pdf_path, dpi=dpi)
print(f"  {len(pages)} page(s), {sum(len(p.words) for p in pages)} word(s)", file=sys.stderr)

# ── Step 2: LLM PII detection ──
full_text = "\n\n".join(f"[Page {p.page_num}]\n{p.text}" for p in pages)
print(f"OCR text: {len(full_text)} chars", file=sys.stderr)

chunks = chunk_text(full_text, chunk_size)
print(f"Sending {len(chunks)} chunk(s) to {model}...", file=sys.stderr)

all_items = []
for i, chunk in enumerate(chunks, 1):
    print(f"  Chunk {i}/{len(chunks)}...", file=sys.stderr, end=" ")
    items = query_ollama(chunk, model)
    print(f"{len(items)} PII item(s)", file=sys.stderr)
    all_items.extend(items)

all_pii_values = set()
for item in all_items:
    v = (item.get("value") or "").strip()
    if v:
        all_pii_values.add(v)

# Add custom PII values
if custom_pii_raw:
    all_pii_values.update(parse_custom_pii_values(custom_pii_raw))

pii_list_sorted = sorted(all_pii_values)
print(f"\nDetected PII values ({len(pii_list_sorted)}):", file=sys.stderr)
for v in pii_list_sorted:
    print(f"  {v!r}", file=sys.stderr)

# ── Step 3: Find bboxes per page ──
page_bboxes = {}
total_bboxes = 0
for page in pages:
    bboxes = ocr_scrub.find_pii_bboxes(page, pii_list_sorted)
    if bboxes:
        page_bboxes[page.page_num] = bboxes
        total_bboxes += len(bboxes)

print(f"\n{total_bboxes} bbox(es) across {len(page_bboxes)} page(s)", file=sys.stderr)

# ── Step 4: Render redacted pages ──
redacted = ocr_scrub.render_redacted_pages(pdf_path, page_bboxes, dpi=dpi)

# ── Step 5: Save PNGs and open ──
for page_num, img in redacted:
    out = f"/tmp/debug_page_{page_num}.png"
    img.save(out)
    print(f"Saved: {out} ({img.width}x{img.height})", file=sys.stderr)
```

After the script finishes, open each PNG with `open /tmp/debug_page_<N>.png`.
Report the detected PII values and number of bounding boxes.
