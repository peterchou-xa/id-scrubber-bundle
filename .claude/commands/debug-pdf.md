Render a PDF to PNG images for visual debugging. This is useful for inspecting OCR bounding box placement and redaction coverage.

Usage: /debug-pdf <pdf_path> [--pages <page_numbers>] [--dpi <dpi>] [--bboxes <pii_values>]

Arguments:
- pdf_path: Path to the PDF file to render
- --pages: Comma-separated page numbers to render (default: all pages). 1-based.
- --dpi: Resolution for rendering (default: 200)
- --bboxes: Comma-separated PII values. If provided, draw bounding boxes showing where the OCR scrub path would place redaction rectangles.

Steps:
1. Use pypdfium2 to render each requested page of the PDF to a PIL image.
2. If --bboxes PII values are provided:
   a. Use ocr_scrub.ocr_pdf to OCR the PDF and get per-page word bounding boxes.
   b. Use ocr_scrub.find_pii_bboxes to compute the OCR-path bboxes for each page.
   c. Draw red semi-transparent rectangles on the rendered image at those bbox positions (convert PDF user-space coords to pixel coords).
   d. Label each box with "OCR".
3. Save each page as /tmp/debug_page_<N>.png
4. Open each saved PNG using the system viewer: `open /tmp/debug_page_<N>.png` on macOS.
5. Report the file paths and what was drawn.

Implementation — write this as inline Python using the project's bin/python interpreter. Here is the script structure:

```python
import sys
sys.path.insert(0, '/Users/peterchou/workspaces/identity-scrubber')

import pypdfium2 as pdfium
from PIL import ImageDraw, ImageFont
import ocr_scrub

# Parse the arguments from $ARGUMENTS
# Render pages
# If bboxes requested:
#   - Call ocr_scrub.ocr_pdf to get PageOcr list
#   - For each page, call ocr_scrub.find_pii_bboxes with the PII values
#   - Convert PDF coords to pixel coords
#   - Draw rectangles with PIL ImageDraw
# Save to /tmp/debug_page_N.png
# Open with `open` command
```

Coordinate conversion notes:
- PDF user-space: origin at bottom-left, y goes up
- Image pixels: origin at top-left, y goes down
- scale = dpi / 72.0
- pixel_x = pdf_x * scale
- pixel_y = (page_height_pts - pdf_y) * scale
- For a bbox (x0, y0, x1, y1) in PDF space:
  - pixel rect = (x0*scale, (page_h - y1)*scale, x1*scale, (page_h - y0)*scale)

Color coding:
- Red boxes (with "OCR" label): OCR path bounding boxes from find_pii_bboxes
