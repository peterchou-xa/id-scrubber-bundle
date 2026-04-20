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
    # Split-lines in reading order — used by the bbox matcher so it walks
    # the same column-aware sequence the LLM saw in `text`.
    lines: list[list[OcrWord]] = None  # type: ignore


def _cluster_lines(words: list[OcrWord]) -> list[list[OcrWord]]:
    """Cluster words into visual lines by y-overlap. Each line is sorted
    left→right by x0; lines are ordered top→bottom.

    This is the single source of truth for reading order. Both text
    reconstruction (LLM input) and PII bbox matching (redaction) consume
    the same ordering, so the LLM and the matcher see tokens in the same
    sequence — no mismatch between "what we showed the LLM" and "what we
    search when the LLM gives us a value back".
    """
    if not words:
        return []

    remaining = sorted(words, key=lambda w: -w.y1)
    lines: list[list[OcrWord]] = []
    for w in remaining:
        placed = False
        for line in lines:
            rep = line[0]
            overlap = max(0.0, min(w.y1, rep.y1) - max(w.y0, rep.y0))
            shorter = min(w.y1 - w.y0, rep.y1 - rep.y0)
            if shorter > 0 and overlap / shorter > 0.5:
                line.append(w)
                placed = True
                break
        if not placed:
            lines.append([w])

    lines.sort(key=lambda ln: -max(w.y1 for w in ln))
    for line in lines:
        line.sort(key=lambda w: w.x0)

    # Split each y-line on large horizontal gaps. Two words on the same
    # y-row but separated by a wide blank run are in different columns
    # (common in forms/tables). Split fragments are kept left-to-right
    # within their parent line so column A always precedes column B on
    # that row, regardless of individual token heights.
    split_lines: list[list[OcrWord]] = []
    for line in lines:
        if not line:
            continue
        heights = [w.y1 - w.y0 for w in line]
        median_h = sorted(heights)[len(heights) // 2]
        gap_threshold = max(median_h * 2.0, 15.0)
        current: list[OcrWord] = [line[0]]
        for w in line[1:]:
            prev = current[-1]
            if w.x0 - prev.x1 > gap_threshold:
                split_lines.append(current)
                current = [w]
            else:
                current.append(w)
        split_lines.append(current)

    return split_lines


def _reconstruct_text(lines: list[list[OcrWord]]) -> str:
    return "\n".join(" ".join(w.text for w in line) for line in lines)


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

        if result is not None and result.word_results:
            for line_words in result.word_results:
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

        lines = _cluster_lines(words)
        ordered_words = [w for line in lines for w in line]

        pages.append(PageOcr(
            page_num=page_idx + 1,
            words=ordered_words,
            text=_reconstruct_text(lines),
            page_width=page_width_pt,
            page_height=page_height_pt,
            lines=lines,
        ))

    return pages


# ── PII → bbox matching ────────────────────────────────────────────


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _same_line(a: OcrWord, b: OcrWord) -> bool:
    overlap = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    shorter = min(a.y1 - a.y0, b.y1 - b.y0)
    return shorter > 0 and overlap / shorter > 0.5


def _line_bbox(line: list[OcrWord]) -> tuple[float, float, float, float]:
    return (
        min(w.x0 for w in line),
        min(w.y0 for w in line),
        max(w.x1 for w in line),
        max(w.y1 for w in line),
    )


def _x_overlaps(a: tuple[float, float, float, float],
                b: tuple[float, float, float, float]) -> bool:
    """Do two line bboxes overlap in their x-range? Used to gate cross-line
    PII matches: multi-line values only extend into the next split-line if
    it shares a column with the current one. This keeps form-label columns
    from interleaving with data columns when they happen to share y-rows."""
    return min(a[2], b[2]) > max(a[0], b[0])


def find_pii_bboxes(
    page_ocr: PageOcr, pii_values: list[str]
) -> list[tuple[float, float, float, float]]:
    """Find bboxes for each PII value by substring-matching normalized
    target text against the normalized concatenation of each split-line.

    Algorithm per PII value:
      1. Build per-split-line normalized text with a parallel char→word
         index array. Adjacent split-lines are considered together only
         if they share a column (x-range overlap) — this prevents matches
         from straddling unrelated columns on the same y-row.
      2. For each maximal run of column-aligned split-lines, concatenate
         their normalized text and scan for substring occurrences of the
         target. Map the matched char range back to word indices, then
         emit one bbox per visual line.
    """
    bboxes: list[tuple[float, float, float, float]] = []
    lines = page_ocr.lines or []
    pad = 2.0

    def _pad(x0: float, y0: float, x1: float, y1: float):
        return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)

    # Precompute per-line normalized text + char→word-index map.
    line_norms: list[str] = []
    line_char_word: list[list[int]] = []  # char_idx -> index-within-line
    line_bboxes: list[tuple[float, float, float, float]] = []
    for line in lines:
        norm_parts = []
        char_word = []
        for word_idx_in_line, w in enumerate(line):
            n = _norm(w.text)
            norm_parts.append(n)
            char_word.extend([word_idx_in_line] * len(n))
        line_norms.append("".join(norm_parts))
        line_char_word.append(char_word)
        line_bboxes.append(_line_bbox(line) if line else (0.0, 0.0, 0.0, 0.0))

    # Build runs by walking lines top-down and extending a run with any
    # later line whose x-range overlaps the run's starting line's x-range,
    # as long as every line in between either also overlaps or can be
    # skipped. Skipping is what lets a Column A "12d" sit between two
    # Column B rows without breaking the column B match.
    #
    # Concretely: for each line as a potential anchor, emit runs that
    # extend downward, skipping non-overlapping lines and stopping when
    # we hit a line that overlaps in x but whose content doesn't match.
    # To keep the enumeration finite and simple, we instead generate one
    # run per "anchor" line containing that line plus every subsequent
    # line whose x-range overlaps the anchor's x-range. This gives us a
    # focused column view for each starting row.
    runs: list[list[int]] = []
    seen_sigs: set[tuple[int, ...]] = set()
    for anchor in range(len(lines)):
        anchor_bbox = line_bboxes[anchor]
        run = [anchor]
        for j in range(anchor + 1, len(lines)):
            if _x_overlaps(anchor_bbox, line_bboxes[j]):
                run.append(j)
        sig = tuple(run)
        if sig not in seen_sigs:
            seen_sigs.add(sig)
            runs.append(run)

    def _emit_match_words(matched_words: list[OcrWord]) -> None:
        if not matched_words:
            return
        by_line: list[list[OcrWord]] = []
        for w in matched_words:
            placed = False
            for grp in by_line:
                if _same_line(grp[0], w):
                    grp.append(w)
                    placed = True
                    break
            if not placed:
                by_line.append([w])
        for grp in by_line:
            bboxes.append(_pad(*_line_bbox(grp)))

    for pii in pii_values:
        target = _norm(pii)
        if not target:
            continue

        for run in runs:
            # Concatenate normalized text of this run, tracking for each
            # char which (line_idx, word_idx_in_line) it came from.
            run_text_parts: list[str] = []
            run_char_line: list[int] = []
            run_char_word: list[int] = []
            for line_idx in run:
                txt = line_norms[line_idx]
                run_text_parts.append(txt)
                run_char_line.extend([line_idx] * len(txt))
                run_char_word.extend(line_char_word[line_idx])
            run_text = "".join(run_text_parts)
            if not run_text or len(target) > len(run_text):
                continue

            start = 0
            while True:
                pos = run_text.find(target, start)
                if pos < 0:
                    break
                end = pos + len(target)
                # Collect unique (line_idx, word_idx) pairs in the char range.
                seen: set[tuple[int, int]] = set()
                matched: list[OcrWord] = []
                for c in range(pos, end):
                    key = (run_char_line[c], run_char_word[c])
                    if key in seen:
                        continue
                    seen.add(key)
                    matched.append(lines[key[0]][key[1]])
                _emit_match_words(matched)
                start = end

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
