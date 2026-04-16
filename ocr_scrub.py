"""
ocr_scrub.py — OCR-driven PDF redaction.

Flow:
  1. Render each page to an image with pypdfium2.
  2. OCR the image via pytesseract, get word-level bounding boxes.
  3. Caller sends OCR text to an LLM, gets back PII strings.
  4. For each PII string, locate matching words in the OCR stream → bboxes.
  5. Walk the content stream with a text-state simulator. For every Tj/TJ,
     compute its PDF-space bbox. If it overlaps any PII bbox, mask the
     entire operand.
  6. Draw filled black rectangles over the PII regions (visual belt-and-
     suspenders — ensures nothing rendered survives).

All text-layer redactions reuse the existing FontCodec / mask_pii_value
machinery from pdf_ops, so the output has no recoverable PII via text
extraction or copy-paste.
"""

from __future__ import annotations

import io
import re
import sys
from dataclasses import dataclass
from decimal import Decimal

import pikepdf
import pypdfium2 as pdfium
import pytesseract

from pdf_ops import (
    FontCodec,
    _build_codecs_for_font_dict,
    _build_page_codecs,
    _ensure_mask_chars_in_fonts,
    mask_pii_value,
)


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
                matched = page_ocr.words[i : i + k]
                x0 = min(w.x0 for w in matched)
                y0 = min(w.y0 for w in matched)
                x1 = max(w.x1 for w in matched)
                y1 = max(w.y1 for w in matched)
                bboxes.append((x0, y0, x1, y1))
                i += k
            else:
                i += 1

    return bboxes


# ── Content-stream bbox simulator ──────────────────────────────────

def _bbox_overlap(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return not (ax1 < bx0 or bx1 < ax0 or ay1 < by0 or by1 < ay0)


def _mat_mul(a: list[float], b: list[float]) -> list[float]:
    """3x3 matrix multiply in PDF's [a b c d e f] form (row-major reduced)."""
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return [
        a0 * b0 + a1 * b2,
        a0 * b1 + a1 * b3,
        a2 * b0 + a3 * b2,
        a2 * b1 + a3 * b3,
        a4 * b0 + a5 * b2 + b4,
        a4 * b1 + a5 * b3 + b5,
    ]


def _identity() -> list[float]:
    return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]


def _apply_matrix(m: list[float], x: float, y: float) -> tuple[float, float]:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def redact_content_stream(
    page_or_stream,
    codecs: dict[str, FontCodec],
    pii_bboxes: list[tuple[float, float, float, float]],
    pii_mask_values: list[str],
    *,
    parent_ctm: list[float] | None = None,
) -> tuple[list, list, bool]:
    """Walk the content stream and mask every Tj/TJ whose rendered bbox
    overlaps any PII bbox. Returns (original_instructions, new_instructions,
    modified).

    *parent_ctm*, when supplied, is pre-multiplied into the initial CTM so
    that bbox calculations for content inside Form XObjects are in page-space
    and can be compared against page-space OCR bboxes.
    """

    if not pii_bboxes:
        orig = list(pikepdf.parse_content_stream(page_or_stream))
        return orig, orig, False

    if isinstance(page_or_stream, pikepdf.Page):
        page_or_stream.contents_coalesce()
    orig_instructions = list(pikepdf.parse_content_stream(page_or_stream))
    new_instructions: list = []
    modified = False

    # Graphics-state stack for CTM.
    initial_ctm = list(parent_ctm) if parent_ctm is not None else _identity()
    ctm_stack: list[list[float]] = [initial_ctm]

    # Text state.
    tm: list[float] = _identity()
    tlm: list[float] = _identity()
    font_name: str | None = None
    font_size: float = 0.0
    leading: float = 0.0
    tc: float = 0.0  # char spacing
    tw: float = 0.0  # word spacing
    tz: float = 100.0  # horizontal scaling (percent)
    trise: float = 0.0
    in_text = False

    def current_font_codec() -> FontCodec | None:
        if font_name is None:
            return None
        return codecs.get(font_name)

    def char_positions(decoded: str, codec: FontCodec) -> tuple[list[float], list[float]]:
        starts: list[float] = []
        ends: list[float] = []
        cursor = 0.0
        for idx, ch in enumerate(decoded):
            starts.append(cursor)
            width_units = codec.glyph_width_sum(codec.encode(ch))
            cursor += (width_units / 1000.0) * font_size * (tz / 100.0)
            ends.append(cursor)
            if idx < len(decoded) - 1:
                cursor += tc * (tz / 100.0)
                if ch == " ":
                    cursor += tw * (tz / 100.0)
        return starts, ends

    def decoded_bbox(
        decoded: str,
        codec: FontCodec,
        start_idx: int = 0,
        end_idx: int | None = None,
    ) -> tuple[float, float, float, float] | None:
        """Compute the PDF-space bbox of a decoded substring at current text state."""
        if end_idx is None:
            end_idx = len(decoded)
        if start_idx < 0 or end_idx > len(decoded) or start_idx >= end_idx:
            return None
        starts, ends = char_positions(decoded, codec)
        x0_text = starts[start_idx]
        x1_text = ends[end_idx - 1]
        y0_text = trise + (codec.descent / 1000.0) * font_size
        y1_text = trise + (codec.ascent / 1000.0) * font_size
        corners = [
            (x0_text, y0_text),
            (x1_text, y0_text),
            (x0_text, y1_text),
            (x1_text, y1_text),
        ]

        # Combine Tm and CTM: user-space = CTM × Tm × point.
        combined = _mat_mul(tm, ctm_stack[-1])

        xs: list[float] = []
        ys: list[float] = []
        for cx, cy in corners:
            ux, uy = _apply_matrix(combined, cx, cy)
            xs.append(ux)
            ys.append(uy)
        return (min(xs), min(ys), max(xs), max(ys))

    def tj_bbox(raw: bytes, codec: FontCodec) -> tuple[float, float, float, float] | None:
        decoded = codec.decode(raw)
        return decoded_bbox(decoded, codec, 0, len(decoded))

    def advance_tm(width_units: float, n_chars: int, n_spaces: int) -> None:
        nonlocal tm
        advance = (width_units / 1000.0) * font_size + n_chars * tc + n_spaces * tw
        advance *= tz / 100.0
        tm = _mat_mul([1.0, 0.0, 0.0, 1.0, advance, 0.0], tm)

    def overlap_spans(decoded: str, codec: FontCodec) -> list[tuple[int, int]]:
        spans: list[tuple[int, int]] = []
        start: int | None = None
        for idx, ch in enumerate(decoded):
            if ch.isspace():
                hit = False
            else:
                char_box = decoded_bbox(decoded, codec, idx, idx + 1)
                hit = char_box is not None and any(
                    _bbox_overlap(char_box, pb) for pb in pii_bboxes
                )
            if hit and start is None:
                start = idx
            elif not hit and start is not None:
                spans.append((start, idx))
                start = None
        if start is not None:
            spans.append((start, len(decoded)))

        if not spans:
            return spans

        # OCR bboxes are often slightly narrower than PDF glyph extents,
        # leaving trailing (or leading) characters just outside the PII
        # bbox.  When a matched span abuts the edge of the decoded string,
        # extend it to include any remaining non-space characters on that
        # side — they almost certainly belong to the same PII value.
        last_non_space = len(decoded) - 1
        while last_non_space >= 0 and decoded[last_non_space].isspace():
            last_non_space -= 1
        first_non_space = 0
        while first_non_space < len(decoded) and decoded[first_non_space].isspace():
            first_non_space += 1

        extended: list[tuple[int, int]] = []
        for s, e in spans:
            # If the span's end is near the last non-space char (within a
            # small gap of spaces or 1-2 chars), extend to the end.
            if e > last_non_space:
                e = len(decoded)
            elif e >= last_non_space - 1:
                e = last_non_space + 1
            # Similarly for the start.
            if s <= first_non_space + 1:
                s = first_non_space
            extended.append((s, e))

        return extended

    def expand_replaced_segment(orig_str: str, codec: FontCodec) -> tuple[list, bool]:
        spans = overlap_spans(orig_str, codec)
        if not spans:
            return [pikepdf.String(codec.encode(orig_str))], False

        parts: list = []
        cursor = 0
        for start_idx, end_idx in spans:
            if start_idx > cursor:
                parts.append(pikepdf.String(codec.encode(orig_str[cursor:start_idx])))

            replaced_piece = "".join(
                " " if not ch.isspace() else ch for ch in orig_str[start_idx:end_idx]
            )
            if replaced_piece:
                parts.append(pikepdf.String(codec.encode(replaced_piece)))

            orig_width = codec.glyph_width_sum(codec.encode(orig_str[start_idx:end_idx]))
            new_width = codec.glyph_width_sum(codec.encode(replaced_piece))
            width_delta = orig_width - new_width
            if width_delta:
                parts.append(-width_delta)
            cursor = end_idx

        if cursor < len(orig_str):
            parts.append(pikepdf.String(codec.encode(orig_str[cursor:])))

        compact: list = []
        for part in parts:
            if isinstance(part, pikepdf.String) and len(bytes(part)) == 0:
                continue
            compact.append(part)
        return compact or [pikepdf.String(b"")], True

    for operands, operator in orig_instructions:
        op = str(operator)

        if op == "q":
            ctm_stack.append(list(ctm_stack[-1]))
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Q":
            if len(ctm_stack) > 1:
                ctm_stack.pop()
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "cm" and len(operands) == 6:
            m = [float(x) for x in operands]
            ctm_stack[-1] = _mat_mul(m, ctm_stack[-1])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "BT":
            tm = _identity()
            tlm = _identity()
            in_text = True
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "ET":
            in_text = False
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Tf" and len(operands) >= 2:
            font_name = str(operands[0])
            font_size = float(operands[1])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Tc" and operands:
            tc = float(operands[0])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Tw" and operands:
            tw = float(operands[0])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Tz" and operands:
            tz = float(operands[0])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "TL" and operands:
            leading = float(operands[0])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Ts" and operands:
            trise = float(operands[0])
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Td" and len(operands) >= 2:
            tx, ty = float(operands[0]), float(operands[1])
            tlm = _mat_mul([1.0, 0.0, 0.0, 1.0, tx, ty], tlm)
            tm = list(tlm)
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "TD" and len(operands) >= 2:
            tx, ty = float(operands[0]), float(operands[1])
            leading = -ty
            tlm = _mat_mul([1.0, 0.0, 0.0, 1.0, tx, ty], tlm)
            tm = list(tlm)
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "Tm" and len(operands) == 6:
            m = [float(x) for x in operands]
            tm = m
            tlm = list(m)
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue
        if op == "T*":
            tlm = _mat_mul([1.0, 0.0, 0.0, 1.0, 0.0, -leading], tlm)
            tm = list(tlm)
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue

        if op in ("Tj", "'", '"') and operands:
            raw = bytes(operands[-1]) if isinstance(operands[-1], pikepdf.String) else None
            codec = current_font_codec()
            if raw is not None and codec is not None:
                decoded = codec.decode(raw)
                replaced_parts, hit = expand_replaced_segment(decoded, codec)
                if hit:
                    new_ops = list(operands)
                    if len(replaced_parts) == 1 and isinstance(replaced_parts[0], pikepdf.String):
                        new_ops[-1] = replaced_parts[0]
                        new_operator = operator
                    else:
                        new_ops = [pikepdf.Array(replaced_parts)]
                        new_operator = pikepdf.Operator("TJ")
                    new_instructions.append(pikepdf.ContentStreamInstruction(
                        pikepdf._core._ObjectList(new_ops), new_operator
                    ))
                    modified = True
                else:
                    new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
                # Advance text matrix.
                width = codec.glyph_width_sum(raw)
                decoded = codec.decode(raw)
                advance_tm(width, len(decoded), decoded.count(" "))
                continue
            new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue

        if op == "TJ" and operands:
            codec = current_font_codec()
            arr = list(operands[0])
            new_arr: list = []
            local_modified = False

            for elem in arr:
                if isinstance(elem, pikepdf.String) and codec is not None:
                    raw = bytes(elem)
                    decoded = codec.decode(raw)
                    replaced_parts, hit = expand_replaced_segment(decoded, codec)
                    if hit:
                        new_arr.extend(replaced_parts)
                        local_modified = True
                    else:
                        new_arr.append(elem)
                    width = codec.glyph_width_sum(raw)
                    advance_tm(width, len(decoded), decoded.count(" "))
                elif isinstance(elem, (int, float, Decimal)):
                    adj = float(elem)
                    advance = -(adj / 1000.0) * font_size * (tz / 100.0)
                    tm = _mat_mul([1.0, 0.0, 0.0, 1.0, advance, 0.0], tm)
                    new_arr.append(elem)
                else:
                    new_arr.append(elem)

            if local_modified:
                new_instructions.append(pikepdf.ContentStreamInstruction(
                    pikepdf._core._ObjectList([pikepdf.Array(new_arr)]), operator
                ))
                modified = True
            else:
                new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))
            continue

        new_instructions.append(pikepdf.ContentStreamInstruction(operands, operator))

    return orig_instructions, new_instructions, modified


# ── Rectangle overlay ──────────────────────────────────────────────

def _rect_overlay_stream(
    bboxes: list[tuple[float, float, float, float]]
) -> bytes:
    """Build a content-stream snippet that draws filled black rectangles
    over *bboxes* (in PDF user-space points)."""
    parts = [b"q\n0 0 0 rg\n"]
    for x0, y0, x1, y1 in bboxes:
        w = x1 - x0
        h = y1 - y0
        parts.append(f"{x0:.2f} {y0:.2f} {w:.2f} {h:.2f} re f\n".encode())
    parts.append(b"Q\n")
    return b"".join(parts)


def _collect_form_ctms(
    page: pikepdf.Page,
) -> dict[str, list[float]]:
    """Walk the page content stream and return the CTM active at each ``Do``.

    Returns {"/XObjectName": ctm_at_Do_time}.
    """
    page.contents_coalesce()
    instructions = list(pikepdf.parse_content_stream(page))
    ctm_stack: list[list[float]] = [_identity()]
    result: dict[str, list[float]] = {}

    for operands, operator in instructions:
        op = str(operator)
        if op == "q":
            ctm_stack.append(list(ctm_stack[-1]))
        elif op == "Q" and len(ctm_stack) > 1:
            ctm_stack.pop()
        elif op == "cm" and len(operands) == 6:
            m = [float(x) for x in operands]
            ctm_stack[-1] = _mat_mul(m, ctm_stack[-1])
        elif op == "Do" and operands:
            name = str(operands[0])
            result[name] = list(ctm_stack[-1])

    return result


# ── Top-level entry ────────────────────────────────────────────────

def scrub_with_ocr(
    pdf_path: str,
    page_pii_bboxes: dict[int, list[tuple[float, float, float, float]]],
    pii_values: list[str],
    output_path: str,
) -> None:
    """Redact PDF using OCR-derived bounding boxes.

    page_pii_bboxes: {page_num (1-based): [(x0,y0,x1,y1), ...]} in PDF points.
    pii_values: flat list of all detected PII strings (used for mask-glyph
      embedding so the text layer's masked Tj operands render correctly).
    """
    mask_chars: set[str] = set()
    for pii in pii_values:
        mask_chars.update(mask_pii_value(pii))

    pdf = pikepdf.open(pdf_path)

    for page_idx, page in enumerate(pdf.pages):
        page_num = page_idx + 1
        bboxes = page_pii_bboxes.get(page_num, [])
        if not bboxes:
            continue

        _ensure_mask_chars_in_fonts(page, pdf, mask_chars)

        # --- Scrub Form XObjects (nested content streams) ---
        resources = page.get("/Resources")
        if resources:
            xobjects = resources.get("/XObject")
            if xobjects:
                # Walk page content stream to find the CTM at each Do.
                form_ctms = _collect_form_ctms(page)
                for xname, xobj in xobjects.items():
                    if str(xobj.get("/Subtype", "")) != "/Form":
                        continue
                    form_resources = xobj.get("/Resources")
                    form_fonts = (
                        form_resources.get("/Font") if form_resources else None
                    )
                    form_codecs = _build_codecs_for_font_dict(form_fonts)
                    if not form_codecs:
                        continue
                    parent_ctm = form_ctms.get(xname)
                    _, new_form, form_modified = redact_content_stream(
                        xobj,
                        form_codecs,
                        bboxes,
                        pii_values,
                        parent_ctm=parent_ctm,
                    )
                    if form_modified:
                        xobj.write(
                            pikepdf.unparse_content_stream(new_form),
                        )

        # --- Scrub page-level content stream ---
        codecs = _build_page_codecs(page)
        if not codecs:
            # No decodable fonts → still draw rectangles, skip text layer.
            overlay = _rect_overlay_stream(bboxes)
            orig_bytes = pikepdf.unparse_content_stream(
                list(pikepdf.parse_content_stream(page))
            )
            page.Contents = pdf.make_stream(
                b"q\n" + orig_bytes + b"\nQ\n" + overlay
            )
            continue

        orig, new, modified = redact_content_stream(
            page, codecs, bboxes, pii_values
        )
        overlay = _rect_overlay_stream(bboxes)

        combined = (
            b"q\n"
            + pikepdf.unparse_content_stream(new)
            + b"\nQ\n"
            + overlay
        )
        page.Contents = pdf.make_stream(combined)

    pdf.save(output_path)
    pdf.close()
