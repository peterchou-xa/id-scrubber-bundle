Render a PDF page with colored bounding box outlines (not filled) for given PII values. Useful for inspecting exactly where OCR bboxes land without obscuring the text underneath.

Usage: /debug-bbox <pdf_path> --pii <values> [--dpi <dpi>]

Arguments from $ARGUMENTS:
- First positional arg: path to the PDF file
- --pii: Comma-separated PII values to highlight (required)
- --dpi: Resolution for rendering (default: 300)

Run the following Python script via `bin/python3`, substituting the arguments parsed from $ARGUMENTS into the variables at the top. Set `no_proxy` and `NO_PROXY` env vars to `localhost,127.0.0.1` before running.

```python
import sys
sys.path.insert(0, '/Users/peterchou/workspaces/identity-scrubber')

import ocr_scrub
import pypdfium2 as pdfium
from PIL import ImageDraw

# ── Substitute these from $ARGUMENTS ──
pdf_path = "$PDF_PATH"
pii_values = ["$PII_1", "$PII_2"]  # from --pii, split by comma
dpi = 300  # from --dpi

scale = dpi / 72.0
colors = ["red", "blue", "green", "orange", "purple", "cyan", "magenta", "yellow"]

# OCR the PDF
pages = ocr_scrub.ocr_pdf(pdf_path, dpi=dpi)

# Render clean pages
pdf = pdfium.PdfDocument(pdf_path)

for page_idx in range(len(pdf)):
    page_ocr = pages[page_idx]
    page = pdf[page_idx]
    bitmap = page.render(scale=scale)
    img = bitmap.to_pil().convert("RGB")
    img_h = img.height
    draw = ImageDraw.Draw(img)

    for pii_idx, pii in enumerate(pii_values):
        color = colors[pii_idx % len(colors)]
        bboxes = ocr_scrub.find_pii_bboxes(page_ocr, [pii])
        for bbox in bboxes:
            x0, y0, x1, y1 = bbox
            px_x0 = x0 * scale
            px_x1 = x1 * scale
            px_y0 = img_h - y1 * scale
            px_y1 = img_h - y0 * scale
            draw.rectangle([px_x0, px_y0, px_x1, px_y1], outline=color, width=3)
            label = pii if len(pii) <= 25 else pii[:22] + "..."
            draw.text((px_x0, px_y0 - 15), f"{label}", fill=color)

    page_num = page_idx + 1
    out = f"/tmp/debug_bbox_page_{page_num}.png"
    img.save(out)
    print(f"Saved: {out} ({img.width}x{img.height})", file=sys.stderr)

pdf.close()
```

After the script finishes, open each PNG with `open /tmp/debug_bbox_page_<N>.png`.

Color coding: each PII value gets a distinct color (red, blue, green, orange, purple, cyan, magenta, yellow) cycling in order. Boxes are outlined (not filled) so the underlying text remains visible.
