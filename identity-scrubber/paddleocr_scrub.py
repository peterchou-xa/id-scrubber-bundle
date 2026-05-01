"""
paddleocr_scrub.py — OCR-driven PDF redaction using PaddleOCR.

Public surface mirrors rapidocr_scrub.py:
  - ocr_pdf(pdf_path, dpi, det_model, image_output_dir) -> list[PageOcr]
  - find_pii_bboxes_by_value(page_ocr, pii_values) -> dict[str, list[bbox]]
  - find_pii_bboxes(page_ocr, pii_values) -> list[bbox]
  - build_indexed_full_text(pages) -> (str, list[IndexedSpan])
  - resolve_entities_to_bboxes(spans, entities) -> list[dict]
  - render_redacted_pages(pdf_path, page_pii_bboxes, dpi) -> list[(page, img)]
  - scrub_with_ocr(pdf_path, page_pii_bboxes, output_path, dpi) -> None

PaddleOCR's predict(return_word_box=True) returns per-word polygons inside
each detected text line (text_word / text_word_region). Each word becomes
a separate OcrSpan, so per-word matching uses real bboxes — no proportional
character-width slicing needed for whole-word PII values.
"""

from __future__ import annotations

import os

from rapidocr_scrub import (
    IndexedSpan,
    OcrSpan,
    PageOcr,
    _cluster_lines,
    _reconstruct_text,
    build_indexed_full_text,
    find_pii_bboxes,
    find_pii_bboxes_by_value,
    render_redacted_pages,
    resolve_entities_to_bboxes,
    scrub_with_ocr,
)

import pypdfium2 as pdfium


DEFAULT_DPI = 300

_ENGINE = None


def _get_engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise ImportError(
            "paddleocr not installed. Run: pip install paddleocr paddlepaddle"
        ) from exc
    # Disable doc preprocessing — pages come straight from pypdfium2 so they
    # aren't skewed or rotated, and UVDoc unwarping in particular adds
    # 10-30s/page on CPU. Use the mobile text detector for a similar speedup.
    _ENGINE = PaddleOCR(
        lang="en",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_name="PP-OCRv5_mobile_det",
        # Loosen the detector polygon so line-level boxes — and the
        # recognizer-derived word boxes inside them — aren't shrink-wrapped
        # against the leading/trailing glyph edges. RapidOCR uses 2.0 here.
        text_det_unclip_ratio=2.0,
    )
    return _ENGINE


def ocr_pdf(
    pdf_path: str,
    dpi: int = DEFAULT_DPI,
    det_model: str = "mobile",  # accepted for API parity; ignored
    image_output_dir: str | None = None,
) -> list[PageOcr]:
    """Render each page and OCR with PaddleOCR. Bboxes in PDF user-space points."""
    import numpy as np

    engine = _get_engine()
    pdf = pdfium.PdfDocument(pdf_path)
    pages: list[PageOcr] = []

    scale = dpi / 72.0

    for page_idx in range(len(pdf)):
        page = pdf[page_idx]
        bitmap = page.render(scale=scale)
        img = bitmap.to_pil()

        page_width_pt = page.get_width()
        page_height_pt = page.get_height()
        img_h = img.height

        image_path = None
        if image_output_dir is not None:
            image_path = os.path.join(image_output_dir, f"page-{page_idx + 1}.png")
            img.save(image_path, "PNG")

        results = engine.predict(np.array(img), return_word_box=True)

        spans: list[OcrSpan] = []

        # PaddleOCR 3.x .predict(return_word_box=True) returns a list of
        # OCRResult objects with text_word / text_word_region: per-line
        # lists of word strings and their tight quadrilateral polygons.
        # Whitespace tokens get their own entries; we skip those.
        for res in results or []:
            text_words = res.get("text_word") or []
            text_word_regions = res.get("text_word_region") or []
            scores = res.get("rec_scores") or []
            for line_idx, (line_words, line_regions) in enumerate(
                zip(text_words, text_word_regions)
            ):
                # rec_scores is line-level; gate the whole line on it.
                try:
                    if line_idx < len(scores) and float(scores[line_idx]) < 0.3:
                        continue
                except (TypeError, ValueError):
                    pass
                for word, poly in zip(line_words, line_regions):
                    if not word or not word.strip():
                        continue
                    xs = [float(p[0]) for p in poly]
                    ys = [float(p[1]) for p in poly]
                    px0, py0 = min(xs), min(ys)
                    px1, py1 = max(xs), max(ys)

                    # Recognizer-derived word polygons are tight against
                    # glyph edges and routinely shave a few pixels off the
                    # leading/trailing characters. Expand horizontally by
                    # ~20% of the box height so redactions reliably cover
                    # the visible glyphs at any DPI.
                    expand = max(4.0, (py1 - py0) * 0.20)
                    px0 -= expand
                    px1 += expand

                    x0 = px0 / scale
                    x1 = px1 / scale
                    y1 = (img_h - py0) / scale
                    y0 = (img_h - py1) / scale

                    spans.append(OcrSpan(text=word, x0=x0, y0=y0, x1=x1, y1=y1))

        lines = _cluster_lines(spans)
        ordered = [s for line in lines for s in line]

        pages.append(PageOcr(
            page_num=page_idx + 1,
            words=ordered,
            text=_reconstruct_text(lines),
            page_width=page_width_pt,
            page_height=page_height_pt,
            lines=lines,
            image_path=image_path,
            image_width=img.width,
            image_height=img_h,
        ))

    return pages


__all__ = [
    "OcrSpan",
    "PageOcr",
    "IndexedSpan",
    "ocr_pdf",
    "find_pii_bboxes",
    "find_pii_bboxes_by_value",
    "build_indexed_full_text",
    "resolve_entities_to_bboxes",
    "render_redacted_pages",
    "scrub_with_ocr",
]
