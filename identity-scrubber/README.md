# identity-scrubber

A CLI tool that detects personally identifiable information (PII) in PDF files using a local Ollama LLM (gemma3), and produces a scrubbed PDF with the PII redacted. Each page is rendered to an image, OCR'd with Tesseract, and the OCR text is sent to the LLM for PII detection. Detected PII regions are blacked out and the output is saved as a rasterized PDF.

## Prerequisites

Install the system dependencies via Homebrew:

```bash
brew install python@3.13 tesseract ollama
```

- **python@3.13** — runtime for the tool
- **tesseract** — OCR engine for extracting text and word bounding boxes
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

Scrub a PDF, writing a redacted PDF alongside the original:

```bash
python main.py path/to/document.pdf --scrub
```

Add custom PII values that the LLM might miss:

```bash
python main.py path/to/document.pdf --scrub --custom-pii "JOHN DOE" "123 MAIN ST"
```

### Options

- `--scrub` — detect and redact PII, saving a new `_scrubbed.pdf`
- `--model MODEL` — Ollama model to use (default: `gemma3:4b`)
- `--chunk-size N` — characters per chunk sent to the model (default: `3000`)
- `--output FILE` — write JSON detection result to a file instead of stdout
- `--custom-pii VALUE [VALUE ...]` — extra PII values to scrub that the LLM might miss
- `--ocr-dpi N` — DPI when rendering pages for OCR (default: `300`; higher = more accurate but slower)
