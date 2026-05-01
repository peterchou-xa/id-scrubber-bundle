#!/usr/bin/env python3
"""
qwen_vl_scrub.py — Extract text from PDF pages via Ollama (qwen3-vl:4b).

Renders each PDF page at 400 DPI and asks the vision model to transcribe
the visible text.

Usage:
    python qwen_vl_scrub.py <pdf_path> [--model qwen3-vl:4b]
"""

from __future__ import annotations

import argparse
import base64
import io
import os
import sys

import pypdfium2 as pdfium
from PIL import Image

try:
    import ollama
except ImportError:
    sys.exit("ollama not installed. Run: pip install ollama")


DPI = 200
DEFAULT_MODEL = "qwen3-vl:4b"

SYSTEM_PROMPT = (
    "You are an OCR engine. Transcribe all visible text from the page "
    "image in natural reading order. Output only the transcribed text — "
    "no commentary, no markdown fences."
)


_CLIENT = None


def _get_client():
    """Strip proxy env before building the client so local Ollama traffic
    doesn't get routed through an http proxy and stall (see main.py)."""
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT

    for key in ("http_proxy", "https_proxy", "all_proxy",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        os.environ.pop(key, None)

    host = os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434"
    try:
        import httpx
        transport = httpx.HTTPTransport(proxy=None, retries=0)
        _CLIENT = ollama.Client(host=host, timeout=300.0, trust_env=False,
                                transport=transport)
    except TypeError:
        _CLIENT = ollama.Client(host=host, timeout=300.0)
    return _CLIENT


def render_pdf_pages(pdf_path: str) -> list[Image.Image]:
    pdf = pdfium.PdfDocument(pdf_path)
    scale = DPI / 72.0
    images: list[Image.Image] = []
    try:
        for page_idx in range(len(pdf)):
            page = pdf[page_idx]
            bitmap = page.render(scale=scale)
            images.append(bitmap.to_pil().convert("RGB"))
    finally:
        pdf.close()
    return images


def extract_text(img: Image.Image, model: str = DEFAULT_MODEL) -> str:
    client = _get_client()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    response = client.chat(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",
             "content": "Transcribe all text in this page.",
             "images": [b64]},
        ],
        options={"temperature": 0},
    )
    return response["message"]["content"].strip()


def run(pdf_path: str, model: str) -> None:
    pages = render_pdf_pages(pdf_path)
    for idx, img in enumerate(pages, start=1):
        print(f"[qwen-vl] page {idx}/{len(pages)} "
              f"({img.width}x{img.height})...", file=sys.stderr, flush=True)
        try:
            text = extract_text(img, model=model)
        except Exception as exc:
            print(f"[qwen-vl] page {idx} failed: {exc!r}",
                  file=sys.stderr, flush=True)
            continue

        print(f"\n===== Page {idx} =====")
        print(text)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Transcribe PDF pages with qwen3-vl via Ollama.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("pdf", help="Input PDF path")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help="Ollama vision model tag")
    args = parser.parse_args()

    run(args.pdf, args.model)


if __name__ == "__main__":
    main()
