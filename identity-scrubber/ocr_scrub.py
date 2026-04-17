"""
ocr_scrub.py — OCR-driven PDF redaction.

Flow:
  1. Render each page to an image with pypdfium2.
  2. OCR the image via pytesseract, get word-level bounding boxes.
  3. Caller sends OCR text to an LLM, gets back PII strings.
  4. For each PII string, locate matching words in the OCR stream → bboxes.
  5. Draw filled black rectangles directly on the rasterized page images.
  6. Assemble the redacted images into a new image-only PDF.

Since the output PDF is purely rasterized images, there is no text layer
to extract — no PII is recoverable via text extraction or copy-paste.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pypdfium2 as pdfium
import pytesseract
from PIL import ImageDraw


DEFAULT_DPI = 300


# ── OCR ────────────────────────────────────────────────────────────

@dataclass
class OcrWord:
    text: str
    # Bounding box in PDF user-space points (origin = bottom-left).
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass
class PageOcr:
    page_num: int
    words: list[OcrWord]
    # Full text, words joined with spaces + newlines between rows.
    text: str
    # PDF-space page dimensions in points.
    page_width: float
    page_height: float


def ocr_pdf(pdf_path: str, dpi: int = DEFAULT_DPI) -> list[PageOcr]:
    """Render each page and OCR it. Returns per-page OcrWord lists with
    bounding boxes already in PDF user-space points."""
    pdf = pdfium.PdfDocument(pdf_path)
    pages: list[PageOcr] = []

    scale = dpi / 72.0  # points → pixels

    for page_idx in range(len(pdf)):
        page = pdf[page_idx]
        # Render at DPI. pypdfium2 returns a PIL image when render().to_pil()
        bitmap = page.render(scale=scale)
        img = bitmap.to_pil()

        page_width_pt = page.get_width()
        page_height_pt = page.get_height()
        img_h = img.height

        # Tesseract word-level data.
        data = pytesseract.image_to_data(
            img, output_type=pytesseract.Output.DICT
        )

        words: list[OcrWord] = []
        for i, text in enumerate(data["text"]):
            if not text or not text.strip():
                continue
            conf = data["conf"][i]
            try:
                if float(conf) < 30:
                    continue
            except (TypeError, ValueError):
                pass

            # Tesseract bbox: (left, top, width, height) in image pixels,
            # top-left origin.
            left = data["left"][i]
            top = data["top"][i]
            width = data["width"][i]
            height = data["height"][i]

            # Convert to PDF user-space (bottom-left origin, points).
            x0 = left / scale
            x1 = (left + width) / scale
            # PDF y goes up from bottom; image y goes down from top.
            y1 = (img_h - top) / scale
            y0 = (img_h - (top + height)) / scale

            words.append(OcrWord(text=text, x0=x0, y0=y0, x1=x1, y1=y1))

        # Rebuild text with rough line grouping (based on block/line ids).
        text_lines: list[str] = []
        current_line: list[str] = []
        current_block_line = None
        for i, text in enumerate(data["text"]):
            if not text or not text.strip():
                continue
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            if current_block_line is None:
                current_block_line = key
            if key != current_block_line:
                if current_line:
                    text_lines.append(" ".join(current_line))
                current_line = []
                current_block_line = key
            current_line.append(text)
        if current_line:
            text_lines.append(" ".join(current_line))

        pages.append(PageOcr(
            page_num=page_idx + 1,
            words=words,
            text="\n".join(text_lines),
            page_width=page_width_pt,
            page_height=page_height_pt,
        ))

    return pages


# ── PII → bbox matching ────────────────────────────────────────────

def _token_match(word: str, token: str) -> bool:
    """Fuzzy token equality using Levenshtein-style edit distance tolerance
    scaled to the shorter token's length. Roughly: allow 1 edit per 4 chars."""
    if not word or not token:
        return False
    if word == token:
        return True

    from difflib import SequenceMatcher
    shorter = min(len(word), len(token))
    longer = max(len(word), len(token))
    # Length mismatch rejection: if tokens differ by more than 30% length,
    # they're not the same word even if shorter happens to be a substring.
    if shorter * 10 < longer * 7:
        return False
    # SequenceMatcher ratio is in [0, 1]; 0.80 ≈ 1 edit per 5 chars.
    # For short tokens (≤3 chars) require an exact match since a single edit
    # would change too much of the token.
    if shorter <= 3:
        return False
    return SequenceMatcher(None, word, token).ratio() >= 0.80


def _group_words_by_line(
    words: list[OcrWord],
) -> list[tuple[float, float, float, float]]:
    """Split words into lines based on vertical overlap and return one
    bounding box per line.  Two words are on the same line if their
    y-ranges overlap by more than half the shorter word's height.
    Works for any number of lines."""
    if not words:
        return []

    lines: list[list[OcrWord]] = [[words[0]]]
    for w in words[1:]:
        placed = False
        for line in lines:
            rep = line[0]
            overlap_y0 = max(w.y0, rep.y0)
            overlap_y1 = min(w.y1, rep.y1)
            overlap = max(0.0, overlap_y1 - overlap_y0)
            shorter_h = min(w.y1 - w.y0, rep.y1 - rep.y0)
            if shorter_h > 0 and overlap / shorter_h > 0.5:
                line.append(w)
                placed = True
                break
        if not placed:
            lines.append([w])

    bboxes: list[tuple[float, float, float, float]] = []
    for line in lines:
        bboxes.append((
            min(w.x0 for w in line),
            min(w.y0 for w in line),
            max(w.x1 for w in line),
            max(w.y1 for w in line),
        ))
    return bboxes


def _compensate_bbox(
    word: OcrWord, ocr_norm: str, pii_norm: str,
) -> tuple[float, float, float, float]:
    """When Tesseract misreads a character (e.g. '4' → ':'), the OCR bbox
    may be narrower than the real glyph extent.  If the PII target is
    longer than the OCR word, extend the bbox proportionally using the
    average character width."""
    if len(pii_norm) <= len(ocr_norm) or len(ocr_norm) == 0:
        return (word.x0, word.y0, word.x1, word.y1)
    char_width = (word.x1 - word.x0) / len(ocr_norm)
    extra_chars = len(pii_norm) - len(ocr_norm)
    return (word.x0, word.y0, word.x1 + char_width * extra_chars, word.y1)


def find_pii_bboxes(
    page_ocr: PageOcr, pii_values: list[str]
) -> list[tuple[float, float, float, float]]:
    """For each PII string, find matching word sequences in OCR output.
    Returns a list of (x0, y0, x1, y1) bboxes in PDF user-space points."""
    bboxes: list[tuple[float, float, float, float]] = []

    # Normalize: strip punctuation/case for matching, keep a parallel index
    # into the original words list.
    def norm(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", s.lower())

    word_norms = [norm(w.text) for w in page_ocr.words]

    for pii in pii_values:
        pii_tokens = [norm(t) for t in pii.split() if norm(t)]
        if not pii_tokens:
            # Single-token (maybe with punctuation) PII.
            target = norm(pii)
            if not target:
                continue
            for i, wn in enumerate(word_norms):
                if _token_match(wn, target):
                    w = page_ocr.words[i]
                    bboxes.append((w.x0, w.y0, w.x1, w.y1))
            continue

        # Multi-token: sliding-window match over OCR word stream.
        n = len(word_norms)
        k = len(pii_tokens)
        i = 0
        while i <= n - k:
            if all(
                _token_match(word_norms[i + j], pii_tokens[j])
                for j in range(k)
            ):
                # Build compensated words so fuzzy-matched OCR
                # words get their bbox extended for missing chars.
                compensated: list[OcrWord] = []
                for j in range(k):
                    w = page_ocr.words[i + j]
                    cx0, cy0, cx1, cy1 = _compensate_bbox(
                        w, word_norms[i + j], pii_tokens[j],
                    )
                    compensated.append(OcrWord(
                        text=w.text, x0=cx0, y0=cy0, x1=cx1, y1=cy1,
                    ))
                # Group matched words by line so multi-line PII gets
                # one rectangle per line instead of one giant box.
                for line_bbox in _group_words_by_line(compensated):
                    bboxes.append(line_bbox)
                i += k
            else:
                i += 1

    return bboxes


# ── Top-level entry ────────────────────────────────────────────────

def render_redacted_pages(
    pdf_path: str,
    page_pii_bboxes: dict[int, list[tuple[float, float, float, float]]],
    dpi: int = DEFAULT_DPI,
) -> list:
    """Render each page and draw black rectangles over PII regions.

    Returns a list of (page_num, PIL.Image) tuples — one per page.
    Images are RGB with redaction rectangles already drawn.
    """
    from PIL import Image

    pdf = pdfium.PdfDocument(pdf_path)
    scale = dpi / 72.0

    results: list[tuple[int, Image.Image]] = []
    for page_idx in range(len(pdf)):
        page_num = page_idx + 1
        page = pdf[page_idx]
        bitmap = page.render(scale=scale)
        img = bitmap.to_pil()
        img_h = img.height

        bboxes = page_pii_bboxes.get(page_num, [])
        if bboxes:
            draw = ImageDraw.Draw(img)
            for x0, y0, x1, y1 in bboxes:
                px_x0 = x0 * scale
                px_x1 = x1 * scale
                px_y0 = img_h - y1 * scale
                px_y1 = img_h - y0 * scale
                draw.rectangle([px_x0, px_y0, px_x1, px_y1], fill="black")

        results.append((page_num, img.convert("RGB")))

    pdf.close()
    return results


def scrub_with_ocr(
    pdf_path: str,
    page_pii_bboxes: dict[int, list[tuple[float, float, float, float]]],
    output_path: str,
    dpi: int = DEFAULT_DPI,
) -> None:
    """Redact PDF by drawing on rasterized page images, then saving as PDF.

    page_pii_bboxes: {page_num (1-based): [(x0,y0,x1,y1), ...]} in PDF points.
    """
    pages = render_redacted_pages(pdf_path, page_pii_bboxes, dpi=dpi)
    if not pages:
        return
    images = [img for _, img in pages]
    images[0].save(
        output_path,
        "PDF",
        resolution=dpi,
        save_all=True,
        append_images=images[1:],
    )
