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
    # Optional rendered-page artifacts; populated when ocr_pdf is called
    # with image_output_dir. Pixel space, top-left origin.
    image_path: str | None = None
    image_width: int | None = None
    image_height: int | None = None


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


def ocr_pdf(
    pdf_path: str,
    dpi: int = DEFAULT_DPI,
    det_model: str = "mobile",
    image_output_dir: str | None = None,
) -> list[PageOcr]:
    """Render each page and OCR with RapidOCR. Bboxes in PDF user-space points.

    If image_output_dir is given, each rendered page is saved as
    page-{N}.png there and the path/dimensions are attached to PageOcr.
    """
    import numpy as np
    import os

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

        image_path = None
        if image_output_dir is not None:
            image_path = os.path.join(image_output_dir, f"page-{page_idx + 1}.png")
            img.save(image_path, "PNG")

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
            image_path=image_path,
            image_width=img.width,
            image_height=img_h,
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


def find_pii_bboxes_by_value(
    page_ocr: PageOcr, pii_values: list[str]
) -> dict[str, list[tuple[float, float, float, float]]]:
    """Per-PII-value variant of find_pii_bboxes.

    Returns {pii_value: [(x0, y0, x1, y1), ...]} in PDF user-space points.
    Every input value gets a key (possibly mapping to []) so callers can
    distinguish 'not present on this page' from 'never asked about'.

    See find_pii_bboxes for the matching algorithm; the only difference
    is that matches are bucketed by their originating pii_value instead
    of being flattened.
    """
    by_value: dict[str, list[tuple[float, float, float, float]]] = {
        pii: [] for pii in pii_values
    }
    lines = page_ocr.lines or []
    pad = 2.0

    def _pad(x0: float, y0: float, x1: float, y1: float):
        return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)

    line_norms: list[str] = []
    line_char_word: list[list[int]] = []
    line_char_offset: list[list[int]] = []
    line_word_norm_len: list[list[int]] = []
    line_bboxes: list[tuple[float, float, float, float]] = []
    for line in lines:
        norm_parts = []
        char_word = []
        char_offset = []
        word_lens = []
        for word_idx_in_line, w in enumerate(line):
            n = _norm(w.text)
            norm_parts.append(n)
            word_lens.append(len(n))
            char_word.extend([word_idx_in_line] * len(n))
            char_offset.extend(range(len(n)))
        line_norms.append("".join(norm_parts))
        line_char_word.append(char_word)
        line_char_offset.append(char_offset)
        line_word_norm_len.append(word_lens)
        line_bboxes.append(_line_bbox(line) if line else (0.0, 0.0, 0.0, 0.0))

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

    def _word_subbbox(line_idx: int, word_idx: int,
                      min_off: int, max_off_excl: int
                      ) -> tuple[float, float, float, float]:
        word = lines[line_idx][word_idx]
        norm_len = line_word_norm_len[line_idx][word_idx]
        if norm_len == 0 or (min_off == 0 and max_off_excl == norm_len):
            return (word.x0, word.y0, word.x1, word.y1)
        width = word.x1 - word.x0
        sub_x0 = word.x0 + (min_off / norm_len) * width
        sub_x1 = word.x0 + (max_off_excl / norm_len) * width
        return (sub_x0, word.y0, sub_x1, word.y1)

    for pii in pii_values:
        target = _norm(pii)
        if not target:
            continue
        bboxes = by_value[pii]
        seen_bboxes: set[tuple[float, float, float, float]] = set()

        for run in runs:
            run_text_parts: list[str] = []
            run_char_line: list[int] = []
            run_char_word: list[int] = []
            run_char_offset: list[int] = []
            for line_idx in run:
                txt = line_norms[line_idx]
                run_text_parts.append(txt)
                run_char_line.extend([line_idx] * len(txt))
                run_char_word.extend(line_char_word[line_idx])
                run_char_offset.extend(line_char_offset[line_idx])
            run_text = "".join(run_text_parts)
            if not run_text or len(target) > len(run_text):
                continue

            start = 0
            while True:
                pos = run_text.find(target, start)
                if pos < 0:
                    break
                end = pos + len(target)
                groups: dict[tuple[int, int], list[int]] = {}
                order: list[tuple[int, int]] = []
                for c in range(pos, end):
                    key = (run_char_line[c], run_char_word[c])
                    if key not in groups:
                        groups[key] = []
                        order.append(key)
                    groups[key].append(run_char_offset[c])
                per_line_subs: dict[int, list[tuple[float, float, float, float]]] = {}
                for line_idx, word_idx in order:
                    offsets = groups[(line_idx, word_idx)]
                    sub = _word_subbbox(line_idx, word_idx,
                                        min(offsets), max(offsets) + 1)
                    per_line_subs.setdefault(line_idx, []).append(sub)
                for subs in per_line_subs.values():
                    x0 = min(b[0] for b in subs)
                    y0 = min(b[1] for b in subs)
                    x1 = max(b[2] for b in subs)
                    y1 = max(b[3] for b in subs)
                    key = (round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1))
                    if key in seen_bboxes:
                        continue
                    seen_bboxes.add(key)
                    bboxes.append(_pad(x0, y0, x1, y1))
                start = end

    return by_value


# ── Offset-indexed full text (gliner reverse-mapping) ────────────────


@dataclass
class WordSpan:
    """A single OCR word's char-offset span inside a reconstructed full_text.

    Used by the gliner code path to reverse-map model-returned entity
    (start, end) offsets back to specific OCR words on specific pages,
    instead of string-matching the entity value against the page.
    """
    char_start: int
    char_end: int
    page_num: int
    line_idx: int          # global line index across all pages
    word_idx_in_line: int
    word: OcrWord


def build_indexed_full_text(pages: list[PageOcr]) -> tuple[str, list[WordSpan]]:
    """Build the same full_text the LLM/gliner sees, but emit a parallel
    list of WordSpan recording each OCR word's char-offset range inside it.

    Layout (must match _reconstruct_text + main.py join):
      "[Page {N}]\n" + lines joined by "\n" + "\n\n" between pages,
      where each line is words joined by " ".
    """
    parts: list[str] = []
    spans: list[WordSpan] = []
    cursor = 0
    global_line_idx = 0
    for page_idx, page in enumerate(pages):
        if page_idx > 0:
            parts.append("\n\n")
            cursor += 2
        header = f"[Page {page.page_num}]\n"
        parts.append(header)
        cursor += len(header)
        lines = page.lines or []
        for li, line in enumerate(lines):
            if li > 0:
                parts.append("\n")
                cursor += 1
            for wi, w in enumerate(line):
                if wi > 0:
                    parts.append(" ")
                    cursor += 1
                start = cursor
                parts.append(w.text)
                cursor += len(w.text)
                spans.append(WordSpan(
                    char_start=start,
                    char_end=cursor,
                    page_num=page.page_num,
                    line_idx=global_line_idx + li,
                    word_idx_in_line=wi,
                    word=w,
                ))
        global_line_idx += len(lines)
    return "".join(parts), spans


def resolve_entities_to_bboxes(
    word_spans: list[WordSpan],
    entities: list[dict],
) -> list[dict]:
    """Map gliner entities (each with global char offsets) to PDF bboxes.

    Each input entity must have keys: start, end, text, label (offsets are
    absolute into the full_text built by build_indexed_full_text).

    Returns one result per (entity, line) — multi-line entities (e.g.
    addresses spanning two visual lines) yield one bbox per line. Within
    a line, the matched words are merged into a single rectangle.
    Entities that fall entirely in gaps (page headers, whitespace) are
    silently dropped — that's the whole point of this path.
    """
    import bisect

    starts = [s.char_start for s in word_spans]
    results: list[dict] = []
    pad = 2.0

    for ent in entities:
        g_start = ent.get("start")
        g_end = ent.get("end")
        if g_start is None or g_end is None or g_end <= g_start:
            continue

        idx = bisect.bisect_left(starts, g_start)
        # The word at idx-1 may still overlap if its char_end > g_start.
        if idx > 0 and word_spans[idx - 1].char_end > g_start:
            idx -= 1

        matched: list[tuple[WordSpan, int, int]] = []
        i = idx
        while i < len(word_spans) and word_spans[i].char_start < g_end:
            sp = word_spans[i]
            ov_start = max(g_start, sp.char_start)
            ov_end = min(g_end, sp.char_end)
            if ov_end > ov_start:
                matched.append((sp, ov_start - sp.char_start, ov_end - sp.char_start))
            i += 1

        if not matched:
            continue

        groups: dict[tuple[int, int], list[tuple[WordSpan, int, int]]] = {}
        order: list[tuple[int, int]] = []
        for entry in matched:
            key = (entry[0].page_num, entry[0].line_idx)
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(entry)

        for key in order:
            group = groups[key]
            sub_bboxes: list[tuple[float, float, float, float]] = []
            for sp, sub_s, sub_e in group:
                w = sp.word
                wlen = len(w.text)
                if wlen == 0 or (sub_s == 0 and sub_e == wlen):
                    sub_bboxes.append((w.x0, w.y0, w.x1, w.y1))
                else:
                    width = w.x1 - w.x0
                    sx0 = w.x0 + (sub_s / wlen) * width
                    sx1 = w.x0 + (sub_e / wlen) * width
                    sub_bboxes.append((sx0, w.y0, sx1, w.y1))
            x0 = min(b[0] for b in sub_bboxes) - pad
            y0 = min(b[1] for b in sub_bboxes) - pad
            x1 = max(b[2] for b in sub_bboxes) + pad
            y1 = max(b[3] for b in sub_bboxes) + pad
            results.append({
                "value": ent.get("text", ""),
                "type": (ent.get("label") or "").strip().lower(),
                "page_num": key[0],
                "bbox": (x0, y0, x1, y1),
            })

    return results


def find_pii_bboxes(
    page_ocr: PageOcr, pii_values: list[str]
) -> list[tuple[float, float, float, float]]:
    """Flat list of (x0, y0, x1, y1) bboxes in PDF user-space points,
    aggregated across all matched PII values. See find_pii_bboxes_by_value
    for the algorithm — this is just a flattening shim around it.
    """
    by_value = find_pii_bboxes_by_value(page_ocr, pii_values)
    return [bbox for bboxes in by_value.values() for bbox in bboxes]


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
