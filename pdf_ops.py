"""
pdf_ops.py — PDF text extraction and PII scrubbing using pikepdf + pdfminer.

Text extraction: pdfminer.six (MIT license).
PDF manipulation: pikepdf (MPL-2.0 license).
"""

from __future__ import annotations

import os
import platform
import re
import struct
from io import BytesIO

import pikepdf
from fontTools.ttLib import TTFont
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer


# ── System font discovery ──────────────────────────────────────────

# Well-known font paths per platform, keyed by bold vs regular.
_FALLBACK_FONTS: dict[str, list[str]] = {}

if platform.system() == "Darwin":
    _FALLBACK_FONTS = {
        "bold": [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ],
        "regular": [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ],
    }
elif platform.system() == "Windows":
    _win = os.environ.get("WINDIR", r"C:\Windows")
    _FALLBACK_FONTS = {
        "bold": [os.path.join(_win, "Fonts", "arialbd.ttf")],
        "regular": [os.path.join(_win, "Fonts", "arial.ttf")],
    }
else:  # Linux
    _FALLBACK_FONTS = {
        "bold": [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ],
        "regular": [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ],
    }


def _is_bold_font(font: TTFont) -> bool:
    """Detect whether a font is bold from its metadata."""
    # Check PostScript name for "Bold"
    try:
        for record in font["name"].names:
            if record.nameID == 6:  # PostScript name
                if "Bold" in record.toUnicode():
                    return True
    except Exception:
        pass
    # Check OS/2 weight class (>=700 is bold)
    try:
        return font["OS/2"].usWeightClass >= 700
    except Exception:
        pass
    return False

# Standard directories to search for the original font
_SYSTEM_FONT_DIRS: list[str] = []
if platform.system() == "Darwin":
    _SYSTEM_FONT_DIRS = [
        "/System/Library/Fonts",
        "/Library/Fonts",
        os.path.expanduser("~/Library/Fonts"),
    ]
elif platform.system() == "Windows":
    _win = os.environ.get("WINDIR", r"C:\Windows")
    _SYSTEM_FONT_DIRS = [os.path.join(_win, "Fonts")]
else:
    _SYSTEM_FONT_DIRS = [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        os.path.expanduser("~/.fonts"),
    ]


def _find_system_font(ps_name: str) -> str | None:
    """Search system font directories for a font matching *ps_name*."""
    for d in _SYSTEM_FONT_DIRS:
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for f in files:
                if not f.lower().endswith((".ttf", ".otf", ".ttc")):
                    continue
                path = os.path.join(root, f)
                try:
                    font = TTFont(path)
                    for record in font["name"].names:
                        if record.nameID == 6:  # PostScript name
                            if record.toUnicode() == ps_name:
                                font.close()
                                return path
                    font.close()
                except Exception:
                    continue
    return None


def _get_donor_font(embedded_font: TTFont) -> TTFont | None:
    """Get a full font to copy missing glyphs from.

    Tries the original font (by PostScript name) first, then falls back
    to a well-known system font (Arial / Helvetica / DejaVu).
    """
    # Extract the original PostScript name from the embedded subset font
    ps_name = None
    try:
        for record in embedded_font["name"].names:
            if record.nameID == 6:
                raw = record.toUnicode()
                # Strip subset prefix like "AAAAAA+"
                ps_name = re.sub(r"^[A-Z]{6}\+", "", raw)
                break
    except Exception:
        pass

    # Try to find the original font on the system
    if ps_name:
        path = _find_system_font(ps_name)
        if path:
            try:
                return TTFont(path)
            except Exception:
                pass

    # Fall back to a well-known system font matching the weight
    weight = "bold" if _is_bold_font(embedded_font) else "regular"
    for path in _FALLBACK_FONTS.get(weight, []):
        if os.path.isfile(path):
            try:
                return TTFont(path)
            except Exception:
                continue

    return None


# ── Text extraction (pdfminer) ──────────────────────────────────────


def extract_text(pdf_path: str) -> list[tuple[int, str]]:
    """Extract text per page. Returns [(page_num, text), ...]."""
    pages: list[tuple[int, str]] = []
    for page_num, page_layout in enumerate(extract_pages(pdf_path), start=1):
        parts: list[str] = []
        for element in page_layout:
            if isinstance(element, LTTextContainer):
                parts.append(element.get_text())
        text = "".join(parts)
        if text.strip():
            pages.append((page_num, text))
    return pages


# ── Standard PDF encodings ──────────────────────────────────────────

# WinAnsiEncoding: maps byte values to Unicode code points
# Only non-trivial mappings listed (most 0x20-0x7E are identity)
_WINANSI: dict[int, int] = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178,
}


def _winansi_to_unicode(code: int) -> int:
    if code in _WINANSI:
        return _WINANSI[code]
    if 0x20 <= code <= 0xFF:
        return code  # identity for printable Latin-1 range
    return code


# MacRomanEncoding: differences from Latin-1 in 0x80-0xFF range
_MACROMAN_HIGH: list[int] = [
    0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1,
    0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8,
    0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3,
    0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC,
    0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF,
    0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8,
    0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211,
    0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x2126, 0x00E6, 0x00F8,
    0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB,
    0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153,
    0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA,
    0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02,
    0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1,
    0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4,
    0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC,
    0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7,
]


def _macroman_to_unicode(code: int) -> int:
    if 0x80 <= code <= 0xFF:
        return _MACROMAN_HIGH[code - 0x80]
    return code


# Adobe Standard Encoding (used by many Type1 fonts)
_STANDARD_DIFF: dict[int, int] = {
    0x27: 0x2019, 0x60: 0x2018, 0x80: 0x0000,
    0xA1: 0x00A1, 0xA2: 0x00A2, 0xA3: 0x00A3, 0xA4: 0x2044, 0xA5: 0x00A5,
    0xA6: 0x0192, 0xA7: 0x00A7, 0xA8: 0x00A4, 0xAC: 0x00AC, 0xAE: 0xFB01,
    0xAF: 0xFB02, 0xB1: 0x2013, 0xB2: 0x2020, 0xB3: 0x2021, 0xB4: 0x00B7,
    0xB6: 0x00B6, 0xB7: 0x2022, 0xB8: 0x201A, 0xB9: 0x201E, 0xBA: 0x201C,
    0xBB: 0x00AB, 0xBC: 0x2039, 0xBD: 0x203A, 0xC1: 0x2060, 0xC5: 0x0131,
    0xC8: 0x0141, 0xCA: 0x0152, 0xCB: 0x0160, 0xCC: 0x0178, 0xCD: 0x017D,
    0xD0: 0x2014, 0xE1: 0x00C6, 0xE3: 0x00AA, 0xE8: 0x0141, 0xE9: 0x00D8,
    0xEA: 0x0152, 0xEB: 0x00BA, 0xF1: 0x00E6, 0xF5: 0x0131, 0xF8: 0x0142,
    0xF9: 0x00F8, 0xFA: 0x0153, 0xFB: 0x00DF,
}


def _standard_to_unicode(code: int) -> int:
    if code in _STANDARD_DIFF:
        return _STANDARD_DIFF[code]
    return code


# ── ToUnicode CMap parsing ──────────────────────────────────────────


def _parse_tounicode_cmap(cmap_bytes: bytes) -> dict[int, int]:
    """Parse a ToUnicode CMap. Returns {CID: unicode_codepoint}."""
    try:
        text = cmap_bytes.decode("latin-1")
    except Exception:
        text = cmap_bytes.decode("utf-8", errors="replace")

    mapping: dict[int, int] = {}

    # bfchar: <src> <dst>
    for block in re.findall(
        r"beginbfchar\s*(.*?)\s*endbfchar", text, re.DOTALL
    ):
        for m in re.finditer(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", block):
            mapping[int(m.group(1), 16)] = int(m.group(2), 16)

    # bfrange: <start> <end> <dst_start>  OR  <start> <end> [<d1> <d2> ...]
    for block in re.findall(
        r"beginbfrange\s*(.*?)\s*endbfrange", text, re.DOTALL
    ):
        # Array form
        for m in re.finditer(
            r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]+)\]", block
        ):
            start, end = int(m.group(1), 16), int(m.group(2), 16)
            dsts = re.findall(r"<([0-9a-fA-F]+)>", m.group(3))
            for i, dst_hex in enumerate(dsts):
                if start + i > end:
                    break
                mapping[start + i] = int(dst_hex, 16)

        # Scalar form (skip lines already matched by the array form above)
        for m in re.finditer(
            r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>"
            r"(?!\s*\[)",
            block,
        ):
            start, end = int(m.group(1), 16), int(m.group(2), 16)
            dst_start = int(m.group(3), 16)
            for i in range(end - start + 1):
                mapping[start + i] = dst_start + i

    return mapping


# ── Font encoding resolver ──────────────────────────────────────────


class FontCodec:
    """Bidirectional byte ↔ Unicode mapping for a single PDF font."""

    __slots__ = ("cid_to_uni", "uni_to_cid", "byte_width")

    def __init__(
        self,
        cid_to_uni: dict[int, int],
        byte_width: int,  # 1 for single-byte fonts, 2 for CID/Identity-H
    ):
        self.cid_to_uni = cid_to_uni
        self.uni_to_cid = {v: k for k, v in cid_to_uni.items()}
        self.byte_width = byte_width

    def decode(self, raw: bytes) -> str:
        chars: list[str] = []
        if self.byte_width == 2:
            for i in range(0, len(raw) - 1, 2):
                cid = struct.unpack(">H", raw[i : i + 2])[0]
                chars.append(chr(self.cid_to_uni.get(cid, 0xFFFD)))
            return "".join(chars)
        for b in raw:
            chars.append(chr(self.cid_to_uni.get(b, b)))
        return "".join(chars)

    def encode(self, text: str) -> bytes:
        parts: list[bytes] = []
        for ch in text:
            cid = self.uni_to_cid.get(ord(ch))
            if cid is None:
                cid = ord(ch)
            if self.byte_width == 2:
                parts.append(struct.pack(">H", cid))
            else:
                parts.append(bytes([cid & 0xFF]))
        return b"".join(parts)


def _resolve_font_codec(font_obj: pikepdf.Object) -> FontCodec | None:
    """Build a FontCodec from a PDF font object, handling all common encodings."""
    subtype = str(font_obj.get("/Subtype", ""))
    encoding_obj = font_obj.get("/Encoding")
    tounicode = font_obj.get("/ToUnicode")

    # --- Determine byte width ---
    byte_width = 1
    if subtype == "/Type0":
        byte_width = 2
    elif encoding_obj is not None:
        enc_str = str(encoding_obj)
        if "Identity" in enc_str:
            byte_width = 2

    # --- Priority 1: ToUnicode CMap (most reliable) ---
    if tounicode is not None:
        try:
            cmap_bytes = tounicode.read_bytes()
            cid_to_uni = _parse_tounicode_cmap(cmap_bytes)
            if cid_to_uni:
                return FontCodec(cid_to_uni, byte_width)
        except Exception:
            pass

    # --- Priority 2: Named encoding or encoding dict with Differences ---
    base_map: dict[int, int] = {}

    if encoding_obj is not None:
        if isinstance(encoding_obj, pikepdf.Name):
            enc_name = str(encoding_obj)
            if "WinAnsi" in enc_name:
                base_map = {i: _winansi_to_unicode(i) for i in range(256)}
            elif "MacRoman" in enc_name:
                base_map = {i: _macroman_to_unicode(i) for i in range(256)}
            elif "Standard" in enc_name or "MacExpert" in enc_name:
                base_map = {i: _standard_to_unicode(i) for i in range(256)}
            else:
                # Unknown named encoding — fallback to identity
                base_map = {i: i for i in range(256)}
        elif isinstance(encoding_obj, pikepdf.Dictionary):
            # Encoding dict: may have /BaseEncoding and /Differences
            base_enc = str(encoding_obj.get("/BaseEncoding", ""))
            if "WinAnsi" in base_enc:
                base_map = {i: _winansi_to_unicode(i) for i in range(256)}
            elif "MacRoman" in base_enc:
                base_map = {i: _macroman_to_unicode(i) for i in range(256)}
            else:
                base_map = {i: i for i in range(256)}

            # Apply /Differences array
            diffs = encoding_obj.get("/Differences")
            if diffs is not None:
                code = 0
                for item in diffs:
                    if isinstance(item, (int, pikepdf.Object)) and not isinstance(
                        item, pikepdf.Name
                    ):
                        code = int(item)
                    elif isinstance(item, pikepdf.Name):
                        glyph_name = str(item).lstrip("/")
                        uni = _glyph_name_to_unicode(glyph_name)
                        if uni is not None:
                            base_map[code] = uni
                        code += 1

    if not base_map:
        # Fallback: identity mapping (Latin-1)
        base_map = {i: i for i in range(256)}

    return FontCodec(base_map, byte_width)


# Minimal Adobe glyph name → Unicode mapping for /Differences
_GLYPH_TO_UNI: dict[str, int] = {}


def _init_glyph_map() -> None:
    """Populate common Adobe glyph names. Called once on first use."""
    if _GLYPH_TO_UNI:
        return
    # Printable ASCII
    import string

    for c in string.printable:
        _GLYPH_TO_UNI[c] = ord(c)
    # Named glyphs from the Adobe Glyph List (common subset)
    names = {
        "space": 0x0020, "exclam": 0x0021, "quotedbl": 0x0022, "numbersign": 0x0023,
        "dollar": 0x0024, "percent": 0x0025, "ampersand": 0x0026, "quotesingle": 0x0027,
        "parenleft": 0x0028, "parenright": 0x0029, "asterisk": 0x002A, "plus": 0x002B,
        "comma": 0x002C, "hyphen": 0x002D, "period": 0x002E, "slash": 0x002F,
        "zero": 0x0030, "one": 0x0031, "two": 0x0032, "three": 0x0033,
        "four": 0x0034, "five": 0x0035, "six": 0x0036, "seven": 0x0037,
        "eight": 0x0038, "nine": 0x0039, "colon": 0x003A, "semicolon": 0x003B,
        "less": 0x003C, "equal": 0x003D, "greater": 0x003E, "question": 0x003F,
        "at": 0x0040, "bracketleft": 0x005B, "backslash": 0x005C,
        "bracketright": 0x005D, "asciicircum": 0x005E, "underscore": 0x005F,
        "grave": 0x0060, "braceleft": 0x007B, "bar": 0x007C,
        "braceright": 0x007D, "asciitilde": 0x007E,
        "bullet": 0x2022, "endash": 0x2013, "emdash": 0x2014,
        "quoteleft": 0x2018, "quoteright": 0x2019,
        "quotedblleft": 0x201C, "quotedblright": 0x201D,
        "fi": 0xFB01, "fl": 0xFB02,
        "Euro": 0x20AC, "trademark": 0x2122, "copyright": 0x00A9,
        "registered": 0x00AE, "degree": 0x00B0, "plusminus": 0x00B1,
        "multiply": 0x00D7, "divide": 0x00F7,
    }
    # A-Z, a-z by name
    for i in range(26):
        names[chr(0x41 + i)] = 0x41 + i  # A-Z
        names[chr(0x61 + i)] = 0x61 + i  # a-z
    # Accented Latin (common)
    for name, cp in [
        ("Agrave", 0xC0), ("Aacute", 0xC1), ("Acircumflex", 0xC2),
        ("Atilde", 0xC3), ("Adieresis", 0xC4), ("Aring", 0xC5),
        ("AE", 0xC6), ("Ccedilla", 0xC7), ("Egrave", 0xC8),
        ("Eacute", 0xC9), ("Ecircumflex", 0xCA), ("Edieresis", 0xCB),
        ("Igrave", 0xCC), ("Iacute", 0xCD), ("Icircumflex", 0xCE),
        ("Idieresis", 0xCF), ("Ntilde", 0xD1), ("Ograve", 0xD2),
        ("Oacute", 0xD3), ("Ocircumflex", 0xD4), ("Otilde", 0xD5),
        ("Odieresis", 0xD6), ("Ugrave", 0xD9), ("Uacute", 0xDA),
        ("Ucircumflex", 0xDB), ("Udieresis", 0xDC), ("Yacute", 0xDD),
        ("agrave", 0xE0), ("aacute", 0xE1), ("acircumflex", 0xE2),
        ("atilde", 0xE3), ("adieresis", 0xE4), ("aring", 0xE5),
        ("ae", 0xE6), ("ccedilla", 0xE7), ("egrave", 0xE8),
        ("eacute", 0xE9), ("ecircumflex", 0xEA), ("edieresis", 0xEB),
        ("igrave", 0xEC), ("iacute", 0xED), ("icircumflex", 0xEE),
        ("idieresis", 0xEF), ("ntilde", 0xF1), ("ograve", 0xF2),
        ("oacute", 0xF3), ("ocircumflex", 0xF4), ("otilde", 0xF5),
        ("odieresis", 0xF6), ("ugrave", 0xF9), ("uacute", 0xFA),
        ("ucircumflex", 0xFB), ("udieresis", 0xFC), ("yacute", 0xFD),
        ("ydieresis", 0xFF),
    ]:
        names[name] = cp
    _GLYPH_TO_UNI.update(names)


def _glyph_name_to_unicode(name: str) -> int | None:
    """Map an Adobe glyph name to a Unicode code point."""
    _init_glyph_map()
    if name in _GLYPH_TO_UNI:
        return _GLYPH_TO_UNI[name]
    # "uniXXXX" convention
    if name.startswith("uni") and len(name) == 7:
        try:
            return int(name[3:], 16)
        except ValueError:
            pass
    return None


# ── Masking ─────────────────────────────────────────────────────────


def mask_pii_value(value: str) -> str:
    """Replace each digit with '0' and each letter with 'X', keeping other chars."""
    return "".join(
        "0" if ch.isdigit() else "X" if ch.isalpha() else ch for ch in value
    )


# ── Subset font expansion ───────────────────────────────────────────


def _avg_capital_margin(glyf_table, hmtx, glyph_order, cid_to_uni, identity_mapping, gid_map_data=None):
    """Compute average side-bearing ratio from existing capital glyphs."""
    ratios = []
    for cid, uni in cid_to_uni.items():
        if not (0x41 <= uni <= 0x5A):
            continue
        if identity_mapping:
            if cid >= len(glyph_order):
                continue
            gname = glyph_order[cid]
        elif gid_map_data is not None:
            gid_bytes = gid_map_data[cid * 2 : cid * 2 + 2]
            if len(gid_bytes) < 2:
                continue
            gid = struct.unpack(">H", gid_bytes)[0]
            if gid == 0 or gid >= len(glyph_order):
                continue
            gname = glyph_order[gid]
        else:
            continue
        w, lsb = hmtx[gname]
        if w <= 0:
            continue
        g = glyf_table[gname]
        rsb = w - g.xMax
        ratios.append((lsb + rsb) / w)
    return sum(ratios) / len(ratios) if ratios else 0.15


def _copy_glyph_from_donor(
    donor: TTFont,
    char: str,
    target_upm: int,
) -> tuple | None:
    """Copy a glyph from *donor* font, scaling to *target_upm*.

    Returns (glyph_object, advance_width, lsb) or None if the char
    is not in the donor font.
    """
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.pens.transformPen import TransformPen

    cmap = donor.getBestCmap()
    if cmap is None or ord(char) not in cmap:
        return None

    glyph_name = cmap[ord(char)]
    donor_glyf = donor["glyf"]
    donor_hmtx = donor["hmtx"]

    if glyph_name not in donor_glyf:
        return None

    src_glyph = donor_glyf[glyph_name]
    if src_glyph.numberOfContours == 0:
        return None

    donor_upm = donor["head"].unitsPerEm
    scale = target_upm / donor_upm

    src_w, src_lsb = donor_hmtx[glyph_name]
    adv_w = round(src_w * scale)
    lsb = round(src_lsb * scale)

    # Draw the donor glyph into a new TTGlyphPen, applying the scale
    pen = TTGlyphPen(None)
    transform_pen = TransformPen(pen, (scale, 0, 0, scale, 0, 0))
    src_glyph.draw(transform_pen, donor_glyf)
    new_glyph = pen.glyph()

    return new_glyph, adv_w, lsb


def _expand_subset_font(
    font_obj: pikepdf.Object,
    needed_chars: set[str],
    pdf: pikepdf.Pdf,
) -> dict[str, int] | None:
    """Add missing mask characters to a subset font embedded in the PDF.

    Modifies the font program, CIDToGIDMap, ToUnicode CMap, and /W in place.
    Returns {char: cid} for newly added characters, or None if no changes needed.
    """
    subtype = str(font_obj.get("/Subtype", ""))
    if subtype != "/Type0":
        return None

    desc_fonts = font_obj.get("/DescendantFonts")
    if not desc_fonts:
        return None
    cid_font = desc_fonts[0]

    # Read existing ToUnicode to know what's already mapped
    tounicode = font_obj.get("/ToUnicode")
    if tounicode is None:
        return None
    cmap_bytes = tounicode.read_bytes()
    cid_to_uni = _parse_tounicode_cmap(cmap_bytes)
    existing_unis = set(cid_to_uni.values())

    # Filter to only truly missing characters
    missing = {ch for ch in needed_chars if ord(ch) not in existing_unis}
    if not missing:
        return None

    # Load embedded font program
    fd = cid_font.get("/FontDescriptor")
    if fd is None:
        return None
    ff_key = "/FontFile2" if "/FontFile2" in fd else "/FontFile3" if "/FontFile3" in fd else None
    if ff_key is None:
        return None

    font_data = fd[ff_key].read_bytes()
    font = TTFont(BytesIO(font_data))
    glyf_table = font["glyf"]
    hmtx = font["hmtx"]
    glyph_order = font.getGlyphOrder()
    num_glyphs = font["maxp"].numGlyphs

    # Read existing CIDToGIDMap — can be a stream or /Identity name
    gid_map_obj = cid_font.get("/CIDToGIDMap")
    identity_mapping = isinstance(gid_map_obj, pikepdf.Name)
    gid_map_data: bytearray | None = None
    if not identity_mapping and gid_map_obj is not None:
        gid_map_data = bytearray(gid_map_obj.read_bytes())

    # Find a reference capital letter glyph for sizing
    ref_glyph = None
    for cid, uni in cid_to_uni.items():
        if 0x41 <= uni <= 0x5A:  # A-Z
            if identity_mapping:
                # CID == GID with /Identity
                if cid < len(glyph_order):
                    ref_glyph = glyph_order[cid]
                    break
            elif gid_map_data is not None:
                gid_bytes = gid_map_data[cid * 2 : cid * 2 + 2]
                if len(gid_bytes) == 2:
                    gid = struct.unpack(">H", gid_bytes)[0]
                    if gid > 0:
                        ref_glyph = glyph_order[gid]
                        break
    if ref_glyph is None:
        # Fall back to first non-notdef glyph
        ref_glyph = glyph_order[1] if len(glyph_order) > 1 else None
    if ref_glyph is None:
        return None

    # Read /W widths array
    w_array = cid_font.get("/W")
    w_list = list(w_array) if w_array else []

    ref_width, _ = hmtx[ref_glyph]
    units_per_em = font["head"].unitsPerEm

    # Try to get a donor font (original full font or system fallback)
    # so we can copy real glyph outlines instead of drawing crude shapes.
    donor = _get_donor_font(font)

    new_mappings: dict[str, int] = {}

    for ch in sorted(missing):
        new_gid = num_glyphs
        new_glyph_name = f"glyph{new_gid:05d}"

        # Try to copy the real glyph from the donor font
        copied = None
        if donor is not None:
            copied = _copy_glyph_from_donor(donor, ch, units_per_em)

        if copied is not None:
            glyph, adv_w, lsb = copied
        else:
            # Last resort: use the ref glyph dimensions for a placeholder
            adv_w = ref_width
            lsb = 0
            glyph = glyf_table[ref_glyph]  # reuse an existing glyph shape

        # Add to font tables
        glyph_order.append(new_glyph_name)
        glyf_table[new_glyph_name] = glyph
        hmtx[new_glyph_name] = (adv_w, lsb)
        num_glyphs += 1
        font["maxp"].numGlyphs = num_glyphs

        # Pick a new CID
        if identity_mapping:
            # CID == GID with /Identity mapping
            new_cid = new_gid
        else:
            # Extend the CIDToGIDMap stream
            max_cid = len(gid_map_data) // 2
            new_cid = max_cid
            gid_map_data.extend(struct.pack(">H", new_gid))

        # Add /W entry: new_cid [width_in_pdf_units]
        pdf_width = adv_w * 1000 / units_per_em
        w_list.extend([new_cid, pikepdf.Array([pdf_width])])

        # Track for ToUnicode update
        new_mappings[ch] = new_cid

    if donor is not None:
        donor.close()

    # Save modified font back
    font.setGlyphOrder(glyph_order)
    buf = BytesIO()
    font.save(buf)
    new_font_data = buf.getvalue()
    font.close()

    # Update font program in PDF
    fd[ff_key] = pdf.make_stream(new_font_data)

    # Update CIDToGIDMap (only for stream-based maps, not /Identity)
    if gid_map_data is not None:
        cid_font[pikepdf.Name("/CIDToGIDMap")] = pdf.make_stream(bytes(gid_map_data))

    # Update /W
    cid_font[pikepdf.Name("/W")] = pikepdf.Array(w_list)

    # Update ToUnicode CMap — append new bfchar entries
    cmap_text = cmap_bytes.decode("latin-1")
    new_bfchars = "\n".join(
        f"<{cid:04X}> <{ord(ch):04X}>" for ch, cid in new_mappings.items()
    )
    insert_block = (
        f"\n{len(new_mappings)} beginbfchar\n{new_bfchars}\nendbfchar\n"
    )
    # Insert before "endcmap"
    cmap_text = cmap_text.replace("endcmap", insert_block + "endcmap")
    font_obj[pikepdf.Name("/ToUnicode")] = pdf.make_stream(
        cmap_text.encode("latin-1")
    )

    return new_mappings


def _ensure_mask_chars_in_fonts(
    page: pikepdf.Page, pdf: pikepdf.Pdf, mask_chars: set[str]
) -> None:
    """Expand all fonts on a page to include mask characters if missing."""
    resources = page.get("/Resources")
    if resources is None:
        return
    fonts = resources.get("/Font")
    if fonts is None:
        return
    for font_name, font_obj in fonts.items():
        _expand_subset_font(font_obj, mask_chars, pdf)


# ── Content stream scrubbing ────────────────────────────────────────


def _build_page_codecs(page: pikepdf.Page) -> dict[str, FontCodec]:
    """Build FontCodec for every font on a page."""
    resources = page.get("/Resources")
    if resources is None:
        return {}
    fonts = resources.get("/Font")
    if fonts is None:
        return {}

    codecs: dict[str, FontCodec] = {}
    for font_name, font_obj in fonts.items():
        codec = _resolve_font_codec(font_obj)
        if codec is not None:
            codecs[font_name] = codec
    return codecs


def _replace_pii(decoded: str, pii_values: list[str]) -> str | None:
    """Replace PII in decoded text. Returns None if no match."""
    result = decoded
    changed = False
    for pii in pii_values:
        if pii in result:
            result = result.replace(pii, mask_pii_value(pii))
            changed = True
    return result if changed else None


def _try_replace_string(
    operand: pikepdf.String,
    codec: FontCodec,
    pii_values: list[str],
) -> pikepdf.String | None:
    """Try to replace PII in a single text string. Returns None if unchanged."""
    raw = bytes(operand)
    decoded = codec.decode(raw)
    replaced = _replace_pii(decoded, pii_values)
    if replaced is None:
        return None
    return pikepdf.String(codec.encode(replaced))


def _try_replace_tj_array(
    arr: pikepdf.Array,
    codec: FontCodec,
    pii_values: list[str],
) -> list | None:
    """Replace PII across a TJ array, handling text that spans multiple elements.

    Returns a new array if changes were made, None otherwise.
    """
    # Decode all string elements and track their positions in the concatenated text
    segments: list[tuple[int, str, int]] = []  # (arr_idx, decoded_text, char_count)
    full_text_parts: list[str] = []
    for idx, item in enumerate(arr):
        if isinstance(item, pikepdf.String):
            decoded = codec.decode(bytes(item))
            segments.append((idx, decoded, len(decoded)))
            full_text_parts.append(decoded)

    full_text = "".join(full_text_parts)

    # Check for PII in the concatenated text
    replaced = _replace_pii(full_text, pii_values)
    if replaced is None:
        return None

    # Distribute the replaced text back to individual segments
    new_arr = list(arr)
    offset = 0
    for arr_idx, original, char_count in segments:
        segment_replaced = replaced[offset : offset + char_count]
        offset += char_count
        new_arr[arr_idx] = pikepdf.String(codec.encode(segment_replaced))

    return new_arr


def scrub_pdf(
    pdf_path: str, pii_values: list[str], output_path: str
) -> None:
    """Generate a new PDF with PII replaced in content streams."""
    # Collect all unique characters used in mask values
    mask_chars: set[str] = set()
    for pii in pii_values:
        mask_chars.update(mask_pii_value(pii))

    pdf = pikepdf.open(pdf_path)

    for page in pdf.pages:
        # Expand subset fonts to include mask characters (e.g. 'X') before replacing
        _ensure_mask_chars_in_fonts(page, pdf, mask_chars)
        codecs = _build_page_codecs(page)
        if not codecs:
            continue

        page.contents_coalesce()
        instructions = pikepdf.parse_content_stream(page)
        new_instructions: list = []
        current_font: str | None = None
        modified = False

        for operands, operator in instructions:
            op = str(operator)

            # Track font: <font_name> <size> Tf
            if op == "Tf" and len(operands) >= 2:
                current_font = str(operands[0])

            codec = codecs.get(current_font) if current_font else None

            # Tj — single string
            if op == "Tj" and codec:
                result = _try_replace_string(operands[0], codec, pii_values)
                if result is not None:
                    new_instructions.append(
                        pikepdf.ContentStreamInstruction(
                            pikepdf._core._ObjectList([result]), operator
                        )
                    )
                    modified = True
                    continue

            # TJ — array of strings and kerning numbers
            if op == "TJ" and codec:
                new_arr = _try_replace_tj_array(operands[0], codec, pii_values)
                if new_arr is not None:
                    new_instructions.append(
                        pikepdf.ContentStreamInstruction(
                            pikepdf._core._ObjectList([pikepdf.Array(new_arr)]),
                            operator,
                        )
                    )
                    modified = True
                    continue

            new_instructions.append(
                pikepdf.ContentStreamInstruction(operands, operator)
            )

        if modified:
            new_stream = pikepdf.unparse_content_stream(new_instructions)
            page.Contents = pdf.make_stream(new_stream)

    pdf.save(output_path)
    pdf.close()
