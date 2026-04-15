# identity-scrubber

A CLI tool that detects personally identifiable information (PII) in PDF files using a local Ollama LLM (gemma3), and optionally produces a scrubbed PDF with the PII redacted. Supports both text-based PDFs and scanned/non-Unicode PDFs via OCR.

## Prerequisites

Install the system dependencies via Homebrew:

```bash
brew install python@3.13 tesseract ollama
```

- **python@3.13** — runtime for the tool
- **tesseract** — OCR engine used by the `--ocr-scrub` mode
- **ollama** — local LLM server used for PII detection

## Setup

1. Clone the repo and enter the project directory:

   ```bash
   git clone <repo-url> identity-scrubber
   cd identity-scrubber
   ```

2. Create and activate a virtual environment:

   ```bash
   python3.13 -m venv .
   source bin/activate
   ```

3. Install Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

4. Start the Ollama server (in a separate terminal, or as a background service):

   ```bash
   ollama serve
   ```

5. Pull the default model (the tool will also auto-pull on first use):

   ```bash
   ollama pull gemma3:4b
   ```

## Usage

Detect PII in a PDF and print JSON to stdout:

```bash
python main.py path/to/document.pdf
```

Scrub the PDF (text-based), writing a new PDF alongside the original:

```bash
python main.py path/to/document.pdf --scrub
```

Scrub a scanned/non-Unicode PDF via OCR:

```bash
python main.py path/to/document.pdf --ocr-scrub
```

### Options

- `--model MODEL` — Ollama model to use (default: `gemma3:4b`)
- `--chunk-size N` — characters per chunk sent to the model (default: `3000`)
- `--output FILE` — write JSON result to a file instead of stdout
- `--custom-pii VALUE [VALUE ...]` — extra PII values to scrub that the LLM might miss
- `--scrub` — generate a new PDF with PII replaced (digits→`0`, letters→`X`)
- `--ocr-scrub` — render pages to images, OCR them, then redact via overlays (use for scanned PDFs)
- `--ocr-dpi N` — DPI when rendering pages for OCR (default: `300`)
