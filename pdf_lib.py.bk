"""
pdf_lib.py — Minimal pure-Python PDF library for text extraction and PII scrubbing.

Scope:
- Text extraction from typical Western-language PDFs.
- Byte-level content-stream replacement for redaction.
- Incremental-update writes (modified objects appended to the end).

Supports:
- PDF 1.4 traditional xref tables and PDF 1.5+ xref/object streams.
- FlateDecode filter with PNG predictors, plus ASCIIHex/ASCII85 decode.
- Simple fonts with WinAnsi / MacRoman / Standard encodings + /Differences.
- ToUnicode CMaps (bfchar, bfrange) for Type 0 / Identity-H fonts.

Not supported:
- Encrypted PDFs.
- CCITTFax / DCT / JBIG2 (affects only images, which this library never touches).
- CJK fonts without a ToUnicode CMap (text extraction will degrade gracefully).
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass
from typing import Any, Iterator, Optional


# ==================================================================
# Exceptions
# ==================================================================

class PDFError(Exception):
    pass


class PDFUnsupported(PDFError):
    pass


# ==================================================================
# Object types
# ==================================================================

class PDFName:
    __slots__ = ("value",)

    def __init__(self, value: str):
        self.value = value

    def __repr__(self) -> str:
        return f"/{self.value}"

    def __eq__(self, other) -> bool:
        return isinstance(other, PDFName) and self.value == other.value

    def __hash__(self) -> int:
        return hash(("N", self.value))


class PDFRef:
    __slots__ = ("num", "gen")

    def __init__(self, num: int, gen: int = 0):
        self.num = num
        self.gen = gen

    def __repr__(self) -> str:
        return f"{self.num} {self.gen} R"

    def __eq__(self, other) -> bool:
        return isinstance(other, PDFRef) and self.num == other.num and self.gen == other.gen

    def __hash__(self) -> int:
        return hash(("R", self.num, self.gen))


class PDFLitString(bytes):
    pass


class PDFHexString(bytes):
    pass


@dataclass
class PDFStream:
    params: dict
    raw_data: bytes  # still-filtered

    def decode(self) -> bytes:
        data = self.raw_data
        filt = self.params.get(PDFName("Filter"))
        if filt is None:
            return data
        filters = [filt] if isinstance(filt, PDFName) else list(filt)
        parms = self.params.get(PDFName("DecodeParms"))
        if parms is None:
            parms_list: list = [None] * len(filters)
        elif isinstance(parms, dict):
            parms_list = [parms]
        else:
            parms_list = list(parms)
        for f, p in zip(filters, parms_list):
            name = f.value if isinstance(f, PDFName) else str(f)
            if name in ("FlateDecode", "Fl"):
                data = zlib.decompress(data)
                if p:
                    predictor = p.get(PDFName("Predictor"), 1)
                    if predictor >= 10:
                        columns = p.get(PDFName("Columns"), 1)
                        data = _png_unpredict(data, columns)
                    elif predictor != 1:
                        raise PDFUnsupported(f"Predictor {predictor}")
            elif name in ("ASCIIHexDecode", "AHx"):
                hs = bytes(b for b in data if b not in b" \t\n\r\f\x00")
                if hs.endswith(b">"):
                    hs = hs[:-1]
                if len(hs) % 2:
                    hs += b"0"
                data = bytes.fromhex(hs.decode("ascii"))
            elif name in ("ASCII85Decode", "A85"):
                data = _ascii85_decode(data)
            else:
                raise PDFUnsupported(f"Filter: {name}")
        return data


def _png_unpredict(data: bytes, columns: int) -> bytes:
    row_size = columns + 1
    if len(data) % row_size:
        return data
    out = bytearray()
    prev = bytearray(columns)
    for i in range(0, len(data), row_size):
        ftype = data[i]
        row = bytearray(data[i + 1 : i + row_size])
        if ftype == 0:
            pass
        elif ftype == 1:
            for j in range(len(row)):
                left = row[j - 1] if j > 0 else 0
                row[j] = (row[j] + left) & 0xFF
        elif ftype == 2:
            for j in range(len(row)):
                row[j] = (row[j] + prev[j]) & 0xFF
        elif ftype == 3:
            for j in range(len(row)):
                left = row[j - 1] if j > 0 else 0
                row[j] = (row[j] + (left + prev[j]) // 2) & 0xFF
        elif ftype == 4:
            for j in range(len(row)):
                left = row[j - 1] if j > 0 else 0
                up = prev[j]
                upleft = prev[j - 1] if j > 0 else 0
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                pred = left if pa <= pb and pa <= pc else (up if pb <= pc else upleft)
                row[j] = (row[j] + pred) & 0xFF
        out.extend(row)
        prev = row
    return bytes(out)


def _ascii85_decode(data: bytes) -> bytes:
    data = bytes(b for b in data if b not in b" \t\n\r\f\x00")
    if data.startswith(b"<~"):
        data = data[2:]
    if data.endswith(b"~>"):
        data = data[:-2]
    out = bytearray()
    i = 0
    while i < len(data):
        if data[i : i + 1] == b"z":
            out.extend(b"\x00\x00\x00\x00")
            i += 1
            continue
        chunk = data[i : i + 5]
        i += 5
        pad = 5 - len(chunk)
        chunk += b"u" * pad
        n = 0
        for c in chunk:
            n = n * 85 + (c - 33)
        raw = n.to_bytes(4, "big")
        if pad:
            raw = raw[:-pad]
        out.extend(raw)
    return bytes(out)


# ==================================================================
# Lexer
# ==================================================================

_WS = set(b"\x00\t\n\x0c\r ")
_DELIMS = set(b"()<>[]{}/%")

DICT_OPEN = object()
DICT_CLOSE = object()
ARR_OPEN = object()
ARR_CLOSE = object()


class PDFLexer:
    __slots__ = ("data", "pos")

    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos

    def skip_ws(self) -> None:
        d = self.data
        n = len(d)
        p = self.pos
        while p < n:
            c = d[p]
            if c in _WS:
                p += 1
            elif c == 0x25:  # %
                while p < n and d[p] not in (0x0A, 0x0D):
                    p += 1
            else:
                break
        self.pos = p

    def next_token(self):
        self.skip_ws()
        d = self.data
        if self.pos >= len(d):
            return None
        c = d[self.pos]
        if c == 0x2F:
            return self._read_name()
        if c == 0x28:
            return self._read_literal()
        if c == 0x3C:
            if self.pos + 1 < len(d) and d[self.pos + 1] == 0x3C:
                self.pos += 2
                return DICT_OPEN
            return self._read_hex()
        if c == 0x3E:
            if self.pos + 1 < len(d) and d[self.pos + 1] == 0x3E:
                self.pos += 2
                return DICT_CLOSE
            self.pos += 1
            return ">"
        if c == 0x5B:
            self.pos += 1
            return ARR_OPEN
        if c == 0x5D:
            self.pos += 1
            return ARR_CLOSE

        start = self.pos
        while self.pos < len(d):
            ch = d[self.pos]
            if ch in _WS or ch in _DELIMS:
                break
            self.pos += 1
        tok = d[start : self.pos]
        try:
            if b"." in tok:
                return float(tok)
            return int(tok)
        except ValueError:
            return tok.decode("latin-1")

    def _read_name(self) -> PDFName:
        self.pos += 1
        d = self.data
        start = self.pos
        while self.pos < len(d):
            ch = d[self.pos]
            if ch in _WS or ch in _DELIMS:
                break
            self.pos += 1
        raw = d[start : self.pos]
        if b"#" not in raw:
            return PDFName(raw.decode("latin-1"))
        out = bytearray()
        i = 0
        while i < len(raw):
            if raw[i] == 0x23 and i + 2 < len(raw):
                try:
                    out.append(int(raw[i + 1 : i + 3], 16))
                    i += 3
                    continue
                except ValueError:
                    pass
            out.append(raw[i])
            i += 1
        return PDFName(bytes(out).decode("latin-1"))

    def _read_literal(self) -> PDFLitString:
        self.pos += 1
        d = self.data
        out = bytearray()
        depth = 1
        while self.pos < len(d) and depth:
            c = d[self.pos]
            if c == 0x28:
                depth += 1
                out.append(c)
                self.pos += 1
            elif c == 0x29:
                depth -= 1
                if depth:
                    out.append(c)
                self.pos += 1
            elif c == 0x5C:
                self.pos += 1
                if self.pos >= len(d):
                    break
                nc = d[self.pos]
                if nc == 0x6E:
                    out.append(0x0A); self.pos += 1
                elif nc == 0x72:
                    out.append(0x0D); self.pos += 1
                elif nc == 0x74:
                    out.append(0x09); self.pos += 1
                elif nc == 0x62:
                    out.append(0x08); self.pos += 1
                elif nc == 0x66:
                    out.append(0x0C); self.pos += 1
                elif nc in (0x28, 0x29, 0x5C):
                    out.append(nc); self.pos += 1
                elif nc == 0x0D:
                    self.pos += 1
                    if self.pos < len(d) and d[self.pos] == 0x0A:
                        self.pos += 1
                elif nc == 0x0A:
                    self.pos += 1
                elif 0x30 <= nc <= 0x37:
                    octal = 0
                    cnt = 0
                    while cnt < 3 and self.pos < len(d) and 0x30 <= d[self.pos] <= 0x37:
                        octal = octal * 8 + (d[self.pos] - 0x30)
                        self.pos += 1
                        cnt += 1
                    out.append(octal & 0xFF)
                else:
                    out.append(nc); self.pos += 1
            else:
                out.append(c)
                self.pos += 1
        return PDFLitString(bytes(out))

    def _read_hex(self) -> PDFHexString:
        self.pos += 1
        d = self.data
        start = self.pos
        while self.pos < len(d) and d[self.pos] != 0x3E:
            self.pos += 1
        hex_data = bytes(b for b in d[start : self.pos] if b not in _WS)
        self.pos += 1
        if len(hex_data) % 2:
            hex_data += b"0"
        return PDFHexString(bytes.fromhex(hex_data.decode("ascii")))


# ==================================================================
# Object parser
# ==================================================================

class PDFParser:
    def __init__(self, data: bytes):
        self.data = data
        self.lex = PDFLexer(data)

    def parse_indirect_at(self, offset: int):
        self.lex.pos = offset
        onum = self.lex.next_token()
        ogen = self.lex.next_token()
        kw = self.lex.next_token()
        if kw != "obj":
            raise PDFError(f"Expected 'obj' at {offset}, got {kw!r}")
        value = self._build(self.lex.next_token())
        self.lex.skip_ws()
        # Detect 'stream' keyword
        if self.data[self.lex.pos : self.lex.pos + 6] == b"stream":
            if not isinstance(value, dict):
                raise PDFError("stream without dict")
            self.lex.pos += 6
            if self.lex.pos < len(self.data) and self.data[self.lex.pos] == 0x0D:
                self.lex.pos += 1
            if self.lex.pos < len(self.data) and self.data[self.lex.pos] == 0x0A:
                self.lex.pos += 1
            length = value.get(PDFName("Length"))
            if not isinstance(length, int):
                raise PDFError(f"Object {onum}: /Length not a direct int (got {length!r})")
            raw = self.data[self.lex.pos : self.lex.pos + length]
            value = PDFStream(value, raw)
        return value

    def _build(self, tok):
        if tok is DICT_OPEN:
            d: dict = {}
            while True:
                k = self.lex.next_token()
                if k is DICT_CLOSE:
                    return d
                if not isinstance(k, PDFName):
                    raise PDFError(f"Dict key must be name: {k!r}")
                d[k] = self._build(self.lex.next_token())
        if tok is ARR_OPEN:
            arr = []
            while True:
                t = self.lex.next_token()
                if t is ARR_CLOSE:
                    return arr
                arr.append(self._build(t))
        if isinstance(tok, int):
            save = self.lex.pos
            t2 = self.lex.next_token()
            if isinstance(t2, int):
                t3 = self.lex.next_token()
                if t3 == "R":
                    return PDFRef(tok, t2)
            self.lex.pos = save
            return tok
        if tok == "true":
            return True
        if tok == "false":
            return False
        if tok == "null":
            return None
        return tok


# ==================================================================
# Encoding tables — glyph-name to unicode
# ==================================================================

# Minimal Adobe glyph list coverage (common glyphs only).
_GLYPH_TO_UNICODE = {
    "space": " ", "exclam": "!", "quotedbl": '"', "numbersign": "#",
    "dollar": "$", "percent": "%", "ampersand": "&", "quotesingle": "'",
    "parenleft": "(", "parenright": ")", "asterisk": "*", "plus": "+",
    "comma": ",", "hyphen": "-", "period": ".", "slash": "/",
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "colon": ":", "semicolon": ";", "less": "<", "equal": "=",
    "greater": ">", "question": "?", "at": "@",
    **{c: c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    "bracketleft": "[", "backslash": "\\", "bracketright": "]",
    "asciicircum": "^", "underscore": "_", "grave": "`",
    **{c: c for c in "abcdefghijklmnopqrstuvwxyz"},
    "braceleft": "{", "bar": "|", "braceright": "}", "asciitilde": "~",
    "quoteleft": "\u2018", "quoteright": "\u2019",
    "quotedblleft": "\u201c", "quotedblright": "\u201d",
    "endash": "\u2013", "emdash": "\u2014", "bullet": "\u2022",
    "ellipsis": "\u2026", "trademark": "\u2122", "copyright": "\u00a9",
    "registered": "\u00ae", "paragraph": "\u00b6", "section": "\u00a7",
    "dagger": "\u2020", "daggerdbl": "\u2021",
    "guilsinglleft": "\u2039", "guilsinglright": "\u203a",
    "florin": "\u0192", "fi": "\ufb01", "fl": "\ufb02",
    "Euro": "\u20ac", "sterling": "\u00a3", "yen": "\u00a5", "cent": "\u00a2",
}


def _build_winansi() -> dict[int, str]:
    base = {}
    for i in range(0x20, 0x7F):
        base[i] = chr(i)
    # Win-1252 high bytes
    high = {
        0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e",
        0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02c6",
        0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152",
        0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201c",
        0x94: "\u201d", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
        0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a",
        0x9c: "\u0153", 0x9e: "\u017e", 0x9f: "\u0178",
    }
    base.update(high)
    for i in range(0xA0, 0x100):
        base.setdefault(i, chr(i))
    return base


WIN_ANSI = _build_winansi()
STANDARD_ENCODING = {i: chr(i) for i in range(0x20, 0x7F)}
MAC_ROMAN = {i: chr(i) for i in range(0x20, 0x7F)}


# ==================================================================
# Font — decodes bytes to unicode via encoding or ToUnicode CMap
# ==================================================================

class Font:
    """Decodes content-stream bytes to unicode for text extraction/search.

    Two paths:
    1. ToUnicode CMap (authoritative): maps 1- or 2-byte codes to unicode.
    2. Simple encoding (WinAnsi/Standard/MacRoman) + /Differences overrides.
    """

    def __init__(self):
        self.to_unicode: dict[int, str] = {}
        self.encoding: dict[int, str] = dict(WIN_ANSI)
        self.is_cid = False  # two-byte codes

    @classmethod
    def from_dict(cls, fd: dict, doc: "PDFDocument") -> "Font":
        f = cls()
        subtype = fd.get(PDFName("Subtype"))
        if isinstance(subtype, PDFName) and subtype.value == "Type0":
            f.is_cid = True
        # ToUnicode CMap
        tu = fd.get(PDFName("ToUnicode"))
        if tu is not None:
            tu_obj = doc.resolve(tu)
            if isinstance(tu_obj, PDFStream):
                f.to_unicode = _parse_tounicode(tu_obj.decode())
        # Simple encoding
        enc = fd.get(PDFName("Encoding"))
        if enc is not None:
            enc_obj = doc.resolve(enc)
            if isinstance(enc_obj, PDFName):
                f.encoding = _select_encoding(enc_obj.value)
            elif isinstance(enc_obj, dict):
                base = enc_obj.get(PDFName("BaseEncoding"))
                if isinstance(base, PDFName):
                    f.encoding = _select_encoding(base.value)
                diffs = enc_obj.get(PDFName("Differences"))
                if isinstance(diffs, list):
                    code = 0
                    for item in diffs:
                        if isinstance(item, int):
                            code = item
                        elif isinstance(item, PDFName):
                            ch = _GLYPH_TO_UNICODE.get(item.value)
                            if ch:
                                f.encoding[code] = ch
                            code += 1
        return f

    def decode_bytes(self, data: bytes) -> list[tuple[int, int, str]]:
        """Return list of (byte_start, byte_end, unicode_char)."""
        out = []
        if self.is_cid or (self.to_unicode and max(k for k in self.to_unicode) > 0xFF):
            step = 2
        else:
            step = 1
        i = 0
        while i < len(data):
            if step == 2 and i + 1 < len(data):
                code = (data[i] << 8) | data[i + 1]
                ch = self.to_unicode.get(code, "")
                out.append((i, i + 2, ch))
                i += 2
            else:
                code = data[i]
                ch = self.to_unicode.get(code)
                if ch is None:
                    ch = self.encoding.get(code, "")
                out.append((i, i + 1, ch))
                i += 1
        return out


def _select_encoding(name: str) -> dict[int, str]:
    if name == "WinAnsiEncoding":
        return dict(WIN_ANSI)
    if name == "MacRomanEncoding":
        return dict(MAC_ROMAN)
    if name == "StandardEncoding":
        return dict(STANDARD_ENCODING)
    return dict(WIN_ANSI)


def _parse_tounicode(data: bytes) -> dict[int, str]:
    """Very small CMap parser — handles bfchar and bfrange."""
    result: dict[int, str] = {}
    text = data.decode("latin-1", errors="replace")

    def _hex_to_int(h: str) -> int:
        return int(h, 16)

    def _hex_to_str(h: str) -> str:
        b = bytes.fromhex(h)
        if len(b) % 2 == 0:
            try:
                return b.decode("utf-16-be")
            except UnicodeDecodeError:
                pass
        return b.decode("latin-1", errors="replace")

    # bfchar
    for m in re.finditer(r"beginbfchar(.*?)endbfchar", text, re.DOTALL):
        body = m.group(1)
        for cm in re.finditer(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", body):
            code = _hex_to_int(cm.group(1))
            result[code] = _hex_to_str(cm.group(2))
    # bfrange
    for m in re.finditer(r"beginbfrange(.*?)endbfrange", text, re.DOTALL):
        body = m.group(1)
        # Form: <start> <end> <dst>   or   <start> <end> [ <dst1> <dst2> ... ]
        tokens = re.findall(r"<([0-9A-Fa-f]+)>|(\[)|(\])", body)
        i = 0
        flat = [t for t in tokens]
        while i < len(flat):
            if flat[i][0]:
                start = _hex_to_int(flat[i][0])
                i += 1
                if i >= len(flat) or not flat[i][0]:
                    break
                end = _hex_to_int(flat[i][0])
                i += 1
                if i < len(flat) and flat[i][1] == "[":
                    i += 1
                    idx = 0
                    while i < len(flat) and flat[i][1] != "]":
                        if flat[i][0]:
                            result[start + idx] = _hex_to_str(flat[i][0])
                            idx += 1
                        i += 1
                    if i < len(flat):
                        i += 1
                elif i < len(flat) and flat[i][0]:
                    dst_hex = flat[i][0]
                    dst_base = bytes.fromhex(dst_hex)
                    for off in range(end - start + 1):
                        # Increment last byte
                        mod = bytearray(dst_base)
                        if mod:
                            new_last = mod[-1] + off
                            carry_bytes = new_last.to_bytes(
                                max(1, (new_last.bit_length() + 7) // 8), "big"
                            )
                            mod = mod[:-1] + carry_bytes[-1:]
                        try:
                            ch = bytes(mod).decode("utf-16-be") if len(mod) % 2 == 0 else bytes(mod).decode("latin-1")
                        except UnicodeDecodeError:
                            ch = ""
                        result[start + off] = ch
                    i += 1
            else:
                i += 1
    return result


# ==================================================================
# PDF document
# ==================================================================

class PDFDocument:
    def __init__(self, data: bytes):
        self.data = data
        self.parser = PDFParser(data)
        self.xref: dict[int, tuple[str, int, int]] = {}
        # (kind, a, b):
        #   ('n', offset, gen)   — uncompressed in-file object
        #   ('c', objstm_num, index) — inside object stream
        #   ('m', obj_num, 0)    — in-memory modified object (for save)
        self.trailer: dict = {}
        self._cache: dict[int, Any] = {}
        self._modified: dict[int, Any] = {}  # objects to write on save
        self._next_obj_num: int = 0
        self._read_xref()
        self._next_obj_num = max(self.xref.keys(), default=0) + 1

    # ------------------------------------------------------------
    # XRef
    # ------------------------------------------------------------

    @classmethod
    def open(cls, path: str) -> "PDFDocument":
        with open(path, "rb") as f:
            return cls(f.read())

    def _read_xref(self) -> None:
        tail = self.data[-2048:]
        m = None
        for m_ in re.finditer(rb"startxref\s+(\d+)", tail):
            m = m_
        if not m:
            raise PDFError("startxref not found")
        offset = int(m.group(1))
        seen: set[int] = set()
        while offset is not None and offset not in seen:
            seen.add(offset)
            offset = self._read_xref_at(offset)

    def _read_xref_at(self, offset: int) -> Optional[int]:
        # Traditional table starts with 'xref'; xref stream is an indirect object.
        if self.data[offset : offset + 4] == b"xref":
            return self._read_traditional_xref(offset)
        return self._read_xref_stream(offset)

    def _read_traditional_xref(self, offset: int) -> Optional[int]:
        lex = self.parser.lex
        lex.pos = offset
        lex.next_token()  # 'xref'
        while True:
            save = lex.pos
            t = lex.next_token()
            if t == "trailer":
                trailer = self.parser._build(lex.next_token())
                if isinstance(trailer, dict):
                    for k, v in trailer.items():
                        self.trailer.setdefault(k, v)
                    prev = trailer.get(PDFName("Prev"))
                    if isinstance(prev, int):
                        return prev
                return None
            if not isinstance(t, int):
                lex.pos = save
                return None
            count = lex.next_token()
            if not isinstance(count, int):
                return None
            lex.skip_ws()
            for i in range(count):
                entry = self.data[lex.pos : lex.pos + 20]
                lex.pos += 20
                parts = entry.split()
                if len(parts) < 3:
                    continue
                off = int(parts[0])
                gen = int(parts[1])
                flag = parts[2].decode("ascii")
                obj_num = t + i
                if flag == "n" and obj_num not in self.xref:
                    self.xref[obj_num] = ("n", off, gen)

    def _read_xref_stream(self, offset: int) -> Optional[int]:
        obj = self.parser.parse_indirect_at(offset)
        if not isinstance(obj, PDFStream):
            raise PDFError(f"xref at {offset} is not a stream")
        d = obj.params
        for k, v in d.items():
            self.trailer.setdefault(k, v)
        size = d.get(PDFName("Size"), 0)
        index = d.get(PDFName("Index"), [0, size])
        w = d.get(PDFName("W"))
        if not isinstance(w, list) or len(w) != 3:
            raise PDFError("xref stream missing /W")
        w1, w2, w3 = w
        raw = obj.decode()
        row_size = w1 + w2 + w3
        pos = 0
        # Index is a list of [first, count, first, count, ...]
        pairs = list(zip(index[0::2], index[1::2]))
        for first, count in pairs:
            for i in range(count):
                row = raw[pos : pos + row_size]
                pos += row_size
                f1 = int.from_bytes(row[:w1], "big") if w1 else 1
                f2 = int.from_bytes(row[w1 : w1 + w2], "big") if w2 else 0
                f3 = int.from_bytes(row[w1 + w2 : w1 + w2 + w3], "big") if w3 else 0
                obj_num = first + i
                if obj_num in self.xref:
                    continue
                if f1 == 0:
                    pass  # free
                elif f1 == 1:
                    self.xref[obj_num] = ("n", f2, f3)
                elif f1 == 2:
                    self.xref[obj_num] = ("c", f2, f3)
        prev = d.get(PDFName("Prev"))
        if isinstance(prev, int):
            return prev
        return None

    # ------------------------------------------------------------
    # Resolve
    # ------------------------------------------------------------

    def resolve(self, obj):
        while isinstance(obj, PDFRef):
            if obj.num in self._cache:
                obj = self._cache[obj.num]
                continue
            if obj.num in self._modified:
                obj = self._modified[obj.num]
                self._cache[obj.num] = obj
                continue
            entry = self.xref.get(obj.num)
            if entry is None:
                return None
            kind = entry[0]
            if kind == "n":
                offset = entry[1]
                # /Length may itself be an indirect ref — handle it here
                resolved = self._parse_with_length_resolution(offset)
                self._cache[obj.num] = resolved
                obj = resolved
            elif kind == "c":
                obj_stm_num, idx = entry[1], entry[2]
                resolved = self._fetch_from_object_stream(obj_stm_num, idx)
                self._cache[obj.num] = resolved
                obj = resolved
            else:
                return None
        return obj

    def _parse_with_length_resolution(self, offset: int):
        # First, peek at the dict. If stream /Length is a ref, resolve it.
        lex = self.parser.lex
        lex.pos = offset
        lex.next_token(); lex.next_token(); lex.next_token()  # num gen obj
        value = self.parser._build(lex.next_token())
        lex.skip_ws()
        if self.data[lex.pos : lex.pos + 6] == b"stream":
            if not isinstance(value, dict):
                raise PDFError("stream without dict")
            length_ref = value.get(PDFName("Length"))
            if isinstance(length_ref, PDFRef):
                length_val = self.resolve(length_ref)
                if not isinstance(length_val, int):
                    raise PDFError("Indirect /Length did not resolve to int")
                value[PDFName("Length")] = length_val
            lex.pos += 6
            if lex.pos < len(self.data) and self.data[lex.pos] == 0x0D:
                lex.pos += 1
            if lex.pos < len(self.data) and self.data[lex.pos] == 0x0A:
                lex.pos += 1
            length = value[PDFName("Length")]
            raw = self.data[lex.pos : lex.pos + length]
            return PDFStream(value, raw)
        return value

    def _fetch_from_object_stream(self, objstm_num: int, idx: int):
        objstm = self.resolve(PDFRef(objstm_num, 0))
        if not isinstance(objstm, PDFStream):
            raise PDFError(f"ObjStm {objstm_num} is not a stream")
        first = objstm.params.get(PDFName("First"))
        n = objstm.params.get(PDFName("N"))
        if not isinstance(first, int) or not isinstance(n, int):
            raise PDFError("ObjStm missing /First or /N")
        data = objstm.decode()
        # Header: N pairs of (obj_num, offset) space-separated
        lex = PDFLexer(data, 0)
        pairs = []
        for _ in range(n):
            a = lex.next_token()
            b = lex.next_token()
            pairs.append((a, b))
        if idx >= len(pairs):
            return None
        target_off = first + pairs[idx][1]
        sub_parser = PDFParser(data)
        sub_parser.lex.pos = target_off
        return sub_parser._build(sub_parser.lex.next_token())

    # ------------------------------------------------------------
    # Pages
    # ------------------------------------------------------------

    def _pages_root(self) -> dict:
        root = self.resolve(self.trailer.get(PDFName("Root")))
        if not isinstance(root, dict):
            raise PDFError("Missing /Root")
        pages = self.resolve(root.get(PDFName("Pages")))
        if not isinstance(pages, dict):
            raise PDFError("Missing /Pages")
        return pages

    def pages(self) -> list[tuple[PDFRef, dict]]:
        """Return list of (page_ref, page_dict) in order."""
        out: list[tuple[PDFRef, dict]] = []
        self._walk_pages(self.trailer.get(PDFName("Root")), out, inherited={})
        return out

    def _walk_pages(self, node_ref, out, inherited):
        node = self.resolve(node_ref) if isinstance(node_ref, PDFRef) else node_ref
        if isinstance(node, dict) and PDFName("Root") in (node.keys() if False else []):
            pass
        # If called with trailer-root, descend to /Pages
        if isinstance(node, dict) and PDFName("Pages") in node:
            self._walk_pages(node.get(PDFName("Pages")), out, inherited)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get(PDFName("Type"))
        # Merge inherited
        merged = dict(inherited)
        for k in (PDFName("Resources"), PDFName("MediaBox"), PDFName("CropBox")):
            if k in node:
                merged[k] = node[k]
        if isinstance(node_type, PDFName) and node_type.value == "Pages":
            kids = node.get(PDFName("Kids"), [])
            for k in kids:
                self._walk_pages(k, out, merged)
        else:
            # Leaf page — attach inherited
            for k, v in merged.items():
                node.setdefault(k, v)
            if isinstance(node_ref, PDFRef):
                out.append((node_ref, node))

    def _page_fonts(self, page: dict) -> dict[str, Font]:
        resources = self.resolve(page.get(PDFName("Resources"), {}))
        if not isinstance(resources, dict):
            return {}
        fonts_obj = self.resolve(resources.get(PDFName("Font")))
        if not isinstance(fonts_obj, dict):
            return {}
        out: dict[str, Font] = {}
        for name, ref in fonts_obj.items():
            fd = self.resolve(ref)
            if isinstance(fd, dict):
                out[name.value] = Font.from_dict(fd, self)
        return out

    def _page_content_streams(self, page: dict) -> list[tuple[Optional[PDFRef], PDFStream]]:
        """Return list of (ref, stream) for page contents. ref=None if inlined."""
        contents = page.get(PDFName("Contents"))
        if contents is None:
            return []
        out: list[tuple[Optional[PDFRef], PDFStream]] = []
        items = contents if isinstance(contents, list) else [contents]
        for item in items:
            if isinstance(item, PDFRef):
                resolved = self.resolve(item)
                if isinstance(resolved, PDFStream):
                    out.append((item, resolved))
            elif isinstance(item, PDFStream):
                out.append((None, item))
        return out

    # ------------------------------------------------------------
    # Text extraction
    # ------------------------------------------------------------

    def extract_text(self) -> list[str]:
        """Return a list of strings — one per page."""
        pages = self.pages()
        result: list[str] = []
        for page_ref, page in pages:
            fonts = self._page_fonts(page)
            streams = self._page_content_streams(page)
            text_parts: list[str] = []
            for _, stream in streams:
                raw = stream.decode()
                text_parts.append(_extract_text_from_stream(raw, fonts))
            result.append("".join(text_parts))
        return result

    # ------------------------------------------------------------
    # Scrubbing
    # ------------------------------------------------------------

    def scrub(self, mask_fn) -> int:
        """Replace PII in all pages in-place.

        mask_fn: callable(str) -> Optional[str]. Return None to leave unchanged,
        or the replacement unicode string (will be re-encoded via the same font).

        Returns number of replacements made.
        """
        total = 0
        for page_ref, page in self.pages():
            fonts = self._page_fonts(page)
            for stream_ref, stream in self._page_content_streams(page):
                raw = stream.decode()
                new_raw, count = _scrub_stream(raw, fonts, mask_fn)
                if count > 0:
                    total += count
                    # Replace stream: rebuild with new length, drop filter
                    new_params = dict(stream.params)
                    new_params.pop(PDFName("Filter"), None)
                    new_params.pop(PDFName("DecodeParms"), None)
                    new_params[PDFName("Length")] = len(new_raw)
                    new_stream = PDFStream(new_params, new_raw)
                    if stream_ref is not None:
                        self._modified[stream_ref.num] = new_stream
                        self._cache[stream_ref.num] = new_stream
                    else:
                        # Inline stream inside page dict — mark page as modified
                        page[PDFName("Contents")] = new_stream
                        self._modified[page_ref.num] = page
                        self._cache[page_ref.num] = page
        return total

    # ------------------------------------------------------------
    # Save (incremental update)
    # ------------------------------------------------------------

    def save(self, path: str) -> None:
        if not self._modified:
            with open(path, "wb") as f:
                f.write(self.data)
            return
        out = bytearray(self.data)
        if out and out[-1] != 0x0A:
            out.append(0x0A)
        new_offsets: dict[int, int] = {}
        for num, obj in sorted(self._modified.items()):
            new_offsets[num] = len(out)
            out.extend(f"{num} 0 obj\n".encode("ascii"))
            out.extend(_serialize(obj))
            out.extend(b"\nendobj\n")
        xref_offset = len(out)
        # Emit a single-section xref covering the modified objects.
        # Include object 0 free entry for the required first subsection.
        entries = sorted(new_offsets.items())
        # Group by contiguous ranges for xref subsections
        groups: list[tuple[int, list[int]]] = []
        i = 0
        while i < len(entries):
            start = entries[i][0]
            group = [entries[i][1]]
            j = i + 1
            while j < len(entries) and entries[j][0] == entries[j - 1][0] + 1:
                group.append(entries[j][1])
                j += 1
            groups.append((start, group))
            i = j
        out.extend(b"xref\n")
        out.extend(b"0 1\n")
        out.extend(b"0000000000 65535 f \n")
        for start, offs in groups:
            out.extend(f"{start} {len(offs)}\n".encode("ascii"))
            for off in offs:
                out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
        # Trailer
        trailer = {
            PDFName("Size"): max(new_offsets.keys()) + 1 if new_offsets else self.trailer.get(PDFName("Size"), 0),
            PDFName("Root"): self.trailer.get(PDFName("Root")),
            PDFName("Prev"): self._find_original_startxref(),
        }
        info = self.trailer.get(PDFName("Info"))
        if info is not None:
            trailer[PDFName("Info")] = info
        ids = self.trailer.get(PDFName("ID"))
        if ids is not None:
            trailer[PDFName("ID")] = ids
        out.extend(b"trailer\n")
        out.extend(_serialize(trailer))
        out.extend(b"\nstartxref\n")
        out.extend(f"{xref_offset}\n".encode("ascii"))
        out.extend(b"%%EOF\n")
        with open(path, "wb") as f:
            f.write(bytes(out))

    def _find_original_startxref(self) -> int:
        tail = self.data[-2048:]
        m = None
        for m_ in re.finditer(rb"startxref\s+(\d+)", tail):
            m = m_
        return int(m.group(1)) if m else 0


# ==================================================================
# Content stream parsing for text extraction and scrubbing
# ==================================================================

# Reuse the PDFLexer for content streams — operator keywords come through
# as string tokens from next_token().

def _iter_content_tokens(stream: bytes) -> Iterator[tuple[int, int, Any]]:
    """Yield (start_offset, end_offset, token) pairs.

    TJ-style arrays are folded into a single list token spanning [..] so the
    operator dispatcher can see them as one operand.
    """
    lex = PDFLexer(stream)
    while True:
        lex.skip_ws()
        start = lex.pos
        tok = lex.next_token()
        if tok is None:
            return
        if tok is ARR_OPEN:
            items: list = []
            while True:
                inner = lex.next_token()
                if inner is ARR_CLOSE or inner is None:
                    break
                items.append(inner)
            end = lex.pos
            yield start, end, items
            continue
        if tok is DICT_OPEN:
            # Skip over inline dicts (e.g. BDC marked content properties).
            depth = 1
            while depth:
                t = lex.next_token()
                if t is None:
                    break
                if t is DICT_OPEN:
                    depth += 1
                elif t is DICT_CLOSE:
                    depth -= 1
            continue
        end = lex.pos
        yield start, end, tok


def _extract_text_from_stream(stream: bytes, fonts: dict[str, Font]) -> str:
    parts: list[str] = []
    operands: list = []
    current_font: Optional[Font] = None
    in_text = False
    for _, _, tok in _iter_content_tokens(stream):
        if isinstance(tok, (int, float, PDFName, list, bytes)):
            operands.append(tok)
            continue
        if tok is DICT_OPEN or tok is DICT_CLOSE or tok is ARR_OPEN or tok is ARR_CLOSE:
            continue
        # Keyword / operator
        op = tok
        if op == "BT":
            in_text = True
        elif op == "ET":
            in_text = False
            parts.append("\n")
        elif op == "Tf" and len(operands) >= 2:
            name = operands[-2]
            if isinstance(name, PDFName):
                current_font = fonts.get(name.value)
        elif op in ("Tj", "'", '"') and operands:
            s = operands[-1]
            if isinstance(s, (bytes, bytearray)) and current_font is not None:
                parts.append("".join(c for _, _, c in current_font.decode_bytes(bytes(s))))
                if op in ("'", '"'):
                    parts.append("\n")
        elif op == "TJ" and operands:
            arr = operands[-1]
            if isinstance(arr, list) and current_font is not None:
                buf = []
                for item in arr:
                    if isinstance(item, (bytes, bytearray)):
                        buf.append("".join(c for _, _, c in current_font.decode_bytes(bytes(item))))
                    elif isinstance(item, (int, float)) and item < -100:
                        buf.append(" ")
                parts.append("".join(buf))
        elif op in ("Td", "TD", "T*"):
            parts.append(" ")
        operands.clear()
    return "".join(parts)


def _scrub_stream(stream: bytes, fonts: dict[str, Font], mask_fn) -> tuple[bytes, int]:
    """Find PII strings inside text operators and replace the bytes in-place.

    Returns (new_stream, num_replacements).
    """
    # Collect replacement patches as (start, end, new_bytes).
    patches: list[tuple[int, int, bytes]] = []
    operands: list = []
    operand_spans: list[tuple[int, int]] = []
    current_font: Optional[Font] = None
    count = 0

    def _patch_string_token(tok_start: int, tok_end: int, raw: bytes, font: Font) -> Optional[bytes]:
        """If the decoded content contains PII, return a replacement bytes object
        (same textual shape, re-encoded using the font's encoding). Returns None
        if no change."""
        decoded_pairs = font.decode_bytes(raw)
        decoded_str = "".join(c for _, _, c in decoded_pairs)
        masked = mask_fn(decoded_str)
        if masked is None or masked == decoded_str:
            return None
        # Re-encode via reverse encoding lookup
        reverse = {v: k for k, v in font.encoding.items() if v}
        # Also add reverse of to_unicode as fallback
        for k, v in font.to_unicode.items():
            if v and v not in reverse:
                reverse[v] = k
        new_bytes = bytearray()
        for ch in masked:
            code = reverse.get(ch)
            if code is None:
                # Preserve unknown chars as space (0x20)
                code = 0x20
            if code > 0xFF:
                new_bytes.append((code >> 8) & 0xFF)
                new_bytes.append(code & 0xFF)
            else:
                new_bytes.append(code)
        return bytes(new_bytes)

    for start, end, tok in _iter_content_tokens(stream):
        if isinstance(tok, (int, float, PDFName, list, bytes, bytearray)):
            operands.append(tok)
            operand_spans.append((start, end))
            continue
        if tok is DICT_OPEN or tok is DICT_CLOSE or tok is ARR_OPEN or tok is ARR_CLOSE:
            continue
        op = tok
        if op == "Tf" and len(operands) >= 2:
            name = operands[-2]
            if isinstance(name, PDFName):
                current_font = fonts.get(name.value)
        elif op in ("Tj", "'", '"') and operands and current_font is not None:
            s = operands[-1]
            sp = operand_spans[-1]
            if isinstance(s, (bytes, bytearray)):
                replacement = _patch_string_token(sp[0], sp[1], bytes(s), current_font)
                if replacement is not None:
                    # Rewrite the source token region with a new literal/hex string.
                    new_literal = _encode_pdf_string(replacement)
                    patches.append((sp[0], sp[1], new_literal))
                    count += 1
        elif op == "TJ" and operands and current_font is not None:
            arr = operands[-1]
            arr_span = operand_spans[-1]
            if isinstance(arr, list):
                # Re-parse the TJ array from the original bytes to map each
                # string item back to its byte positions.
                inner_patches = _patch_tj_array(
                    stream, arr_span[0], arr_span[1], current_font, mask_fn
                )
                if inner_patches:
                    patches.extend(inner_patches)
                    count += len(inner_patches)
        operands.clear()
        operand_spans.clear()

    if not patches:
        return stream, 0

    patches.sort()
    out = bytearray()
    cursor = 0
    for s, e, nb in patches:
        out.extend(stream[cursor:s])
        out.extend(nb)
        cursor = e
    out.extend(stream[cursor:])
    return bytes(out), count


def _patch_tj_array(stream: bytes, start: int, end: int, font: Font, mask_fn):
    """Scan a TJ array in the stream and emit patches for any PII strings inside."""
    patches: list[tuple[int, int, bytes]] = []
    lex = PDFLexer(stream, start)
    lex.next_token()  # ARR_OPEN
    while lex.pos < end:
        lex.skip_ws()
        tok_start = lex.pos
        tok = lex.next_token()
        if tok is ARR_CLOSE:
            break
        if isinstance(tok, (bytes, bytearray)):
            tok_end = lex.pos
            decoded = "".join(c for _, _, c in font.decode_bytes(bytes(tok)))
            masked = mask_fn(decoded)
            if masked is not None and masked != decoded:
                reverse = {v: k for k, v in font.encoding.items() if v}
                for k, v in font.to_unicode.items():
                    if v and v not in reverse:
                        reverse[v] = k
                new_bytes = bytearray()
                for ch in masked:
                    code = reverse.get(ch, 0x20)
                    if code > 0xFF:
                        new_bytes.append((code >> 8) & 0xFF)
                        new_bytes.append(code & 0xFF)
                    else:
                        new_bytes.append(code)
                patches.append((tok_start, tok_end, _encode_pdf_string(bytes(new_bytes))))
    return patches


def _encode_pdf_string(data: bytes) -> bytes:
    """Encode bytes as a PDF literal string with escapes."""
    out = bytearray(b"(")
    for b in data:
        if b == 0x28:
            out.extend(b"\\(")
        elif b == 0x29:
            out.extend(b"\\)")
        elif b == 0x5C:
            out.extend(b"\\\\")
        elif b == 0x0A:
            out.extend(b"\\n")
        elif b == 0x0D:
            out.extend(b"\\r")
        elif b < 0x20 or b > 0x7E:
            out.extend(f"\\{b:03o}".encode("ascii"))
        else:
            out.append(b)
    out.append(0x29)
    return bytes(out)


# ==================================================================
# Serialization (for save)
# ==================================================================

def _serialize(obj) -> bytes:
    if obj is None:
        return b"null"
    if obj is True:
        return b"true"
    if obj is False:
        return b"false"
    if isinstance(obj, bool):  # pragma: no cover
        return b"true" if obj else b"false"
    if isinstance(obj, int):
        return str(obj).encode("ascii")
    if isinstance(obj, float):
        return f"{obj:g}".encode("ascii")
    if isinstance(obj, PDFName):
        return b"/" + obj.value.encode("latin-1")
    if isinstance(obj, PDFRef):
        return f"{obj.num} {obj.gen} R".encode("ascii")
    if isinstance(obj, PDFHexString):
        return b"<" + bytes(obj).hex().encode("ascii") + b">"
    if isinstance(obj, (PDFLitString, bytes, bytearray)):
        return _encode_pdf_string(bytes(obj))
    if isinstance(obj, list):
        parts = [_serialize(x) for x in obj]
        return b"[" + b" ".join(parts) + b"]"
    if isinstance(obj, dict):
        out = bytearray(b"<<")
        for k, v in obj.items():
            if v is None:
                continue
            out.extend(b" ")
            out.extend(_serialize(k))
            out.extend(b" ")
            out.extend(_serialize(v))
        out.extend(b" >>")
        return bytes(out)
    if isinstance(obj, PDFStream):
        params = dict(obj.params)
        params[PDFName("Length")] = len(obj.raw_data)
        header = _serialize(params)
        return header + b"\nstream\n" + obj.raw_data + b"\nendstream"
    raise PDFError(f"Cannot serialize {type(obj).__name__}")
