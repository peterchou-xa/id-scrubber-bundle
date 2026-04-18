"""
rapidocr_scrub.py — OCR-driven PDF redaction using RapidOCR (ONNX Runtime).

Public surface matches ocr_scrub.py:
  - ocr_pdf(pdf_path, dpi) -> list[PageOcr]
  - find_pii_bboxes(page_ocr, pii_values) -> list[bbox]
  - render_redacted_pages(pdf_path, page_pii_bboxes, dpi) -> list[(page, img)]
  - scrub_with_ocr(pdf_path, page_pii_bboxes, output_path, dpi) -> None
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pypdfium2 as pdfium
from PIL import ImageDraw


DEFAULT_DPI = 300

_ENGINE = None
_ENGINE_DET_MODEL: str | None = None

# The default Chinese recognizer doesn't emit spaces between Latin words,
# so "ELIZABETH A DARLING" comes back as "ELIZABETHADARLING". Switching the
# recognizer to the English PP-OCRv4 model preserves whitespace.


def _get_engine(det_model: str = "mobile"):
    global _ENGINE, _ENGINE_DET_MODEL
    if _ENGINE is not None and _ENGINE_DET_MODEL == det_model:
        return _ENGINE
    try:
        from rapidocr import RapidOCR
    except ImportError as exc:
        raise ImportError(
            "rapidocr not installed. Run: pip install rapidocr onnxruntime"
        ) from exc
    from rapidocr import LangRec, ModelType
    model_type = ModelType.SERVER if det_model == "server" else ModelType.MOBILE
    _ENGINE = RapidOCR(params={
        "Rec.lang_type": LangRec.EN,
        "Det.model_type": model_type,
        # Defaults (0.3 / 0.5 / 1.6) miss thin light text like small-font
        # contact lines on resumes. Loosen them so the detector keeps
        # marginal regions; recognition-side confidence still filters noise.
        "Det.thresh": 0.2,
        "Det.box_thresh": 0.3,
        "Det.unclip_ratio": 2.0,
    })
    _ENGINE_DET_MODEL = det_model
    return _ENGINE


# ── OCR ────────────────────────────────────────────────────────────


@dataclass
class OcrWord:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass
class PageOcr:
    page_num: int
    words: list[OcrWord]
    text: str
    page_width: float
    page_height: float


def ocr_pdf(pdf_path: str, dpi: int = DEFAULT_DPI, det_model: str = "mobile") -> list[PageOcr]:
    """Render each page and OCR with RapidOCR. Bboxes in PDF user-space points."""
    import numpy as np

    engine = _get_engine(det_model)
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

        result = engine(np.array(img), return_word_box=True)

        words: list[OcrWord] = []
        text_lines: list[str] = []

        if result is not None and result.txts is not None:
            line_texts = list(result.txts)
            line_scores = (
                list(result.scores) if result.scores is not None else []
            )
            word_results = (
                list(result.word_results) if result.word_results else []
            )

            for i, line_text in enumerate(line_texts):
                if not line_text or not line_text.strip():
                    continue
                try:
                    if i < len(line_scores) and float(line_scores[i]) < 0.3:
                        continue
                except (TypeError, ValueError):
                    pass
                text_lines.append(line_text)

            for line_words in word_results:
                for word_entry in line_words:
                    tok, conf, poly = word_entry
                    if not tok or not tok.strip():
                        continue
                    try:
                        if float(conf) < 0.3:
                            continue
                    except (TypeError, ValueError):
                        pass

                    xs = [p[0] for p in poly]
                    ys = [p[1] for p in poly]
                    px0, py0 = min(xs), min(ys)
                    px1, py1 = max(xs), max(ys)

                    x0 = px0 / scale
                    x1 = px1 / scale
                    y1 = (img_h - py0) / scale
                    y0 = (img_h - py1) / scale

                    words.append(OcrWord(text=tok, x0=x0, y0=y0, x1=x1, y1=y1))

        pages.append(PageOcr(
            page_num=page_idx + 1,
            words=words,
            text="\n".join(text_lines),
            page_width=page_width_pt,
            page_height=page_height_pt,
        ))

    return pages


# ── PII → bbox matching ────────────────────────────────────────────


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _same_line(a: OcrWord, b: OcrWord) -> bool:
    overlap = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    shorter = min(a.y1 - a.y0, b.y1 - b.y0)
    return shorter > 0 and overlap / shorter > 0.5


def find_pii_bboxes(
    page_ocr: PageOcr, pii_values: list[str]
) -> list[tuple[float, float, float, float]]:
    """Return one bbox per OCR token involved in a PII match.

    Two passes:
      1. Target fits inside a single OCR token (substring).
      2. Target equals the concatenation of consecutive same-line OCR tokens,
         built up prefix-by-prefix so we only extend when the accumulated
         string is still a prefix of the target.
    """
    bboxes: list[tuple[float, float, float, float]] = []
    words = page_ocr.words
    norms = [_norm(w.text) for w in words]
    n = len(words)
    pad = 2.0

    def _pad(x0: float, y0: float, x1: float, y1: float):
        return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)

    for pii in pii_values:
        target = _norm(pii)
        if not target:
            continue

        for i in range(n):
            if norms[i] and target in norms[i]:
                w = words[i]
                bboxes.append(_pad(w.x0, w.y0, w.x1, w.y1))
                continue

            if not norms[i] or not target.startswith(norms[i]):
                continue
            acc = norms[i]
            span = [i]
            j = i + 1
            while j < n and acc != target:
                if not norms[j]:
                    j += 1
                    continue
                if not _same_line(words[span[-1]], words[j]):
                    break
                candidate = acc + norms[j]
                if not target.startswith(candidate):
                    break
                acc = candidate
                span.append(j)
                j += 1
            if acc == target and len(span) > 1:
                matched = [words[k] for k in span]
                bboxes.append(_pad(
                    min(w.x0 for w in matched),
                    min(w.y0 for w in matched),
                    max(w.x1 for w in matched),
                    max(w.y1 for w in matched),
                ))

    return bboxes


# ── Top-level entry ────────────────────────────────────────────────


def render_redacted_pages(
    pdf_path: str,
    page_pii_bboxes: dict[int, list[tuple[float, float, float, float]]],
    dpi: int = DEFAULT_DPI,
) -> list:
    """Render each page and draw black rectangles over PII regions."""
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
    """Redact PDF by drawing on rasterized page images, then save as PDF."""
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
