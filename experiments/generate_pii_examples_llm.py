#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from openai import OpenAI
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4")
EXAMPLES_PER_CALL = 10
TOTAL_EXAMPLES = 500
MIN_OCR_TEXT_CHARS = 300
MAX_OCR_TEXT_CHARS = 500




SYSTEM_INSTRUCTIONS = """You generate synthetic OCR training examples for a PII redaction model. Return only data that fits the response schema. Never truncate examples early. Fill each ocr_text with enough OCR noise, headers, footer chrome, form labels, and distractor text to satisfy the required length."""

PROMPT = r"""
You generate synthetic OCR training examples for a PII redaction model. Each example simulates raw text snippet extracted from a scanned document (W-2, paystub, ID card, medical record, bank statement, shipping label, boarding pass, utility bill, resume, driver license, passport, 1099, lease, voter registration, hotel folio, insurance claim, invoice, prescription, etc.) - including realistic OCR noise: form-field labels intruding into values, line breaks mid-value, repeated header/footer chrome, document-type box codes and field identifiers (e.g. W-2 box codes "12a 12d 15c", DL field codes "4a 4b 8 DD", ICD-10/CPT codes, IMb barcode digits, AAMVA codes, MRZ fragments), distractor numbers (invoice/PO/order #s), money amounts, and scanner artifacts.
DO NOT assume the OCR text is the beginning of the document. Most examples should look like snippets taken from the middle or end of a PDF, not page-opening content. Usually avoid document-opening patterns like full titles, introductory headers, complete top-of-page identity blocks, or the first field on a form. Prefer cropped continuations, partial sections, section tails, continuing tables, carry-over line items, repeated running headers or footers, references to earlier pages, and fragments with missing context before and after.

Each ocr_text should be about 300-500 characters and about 60-80 words. Keep the text dense with realistic OCR boilerplate, repeated form labels, extra line items, footer chrome, control numbers, payment details, and unrelated distractor text, but do not make the examples unnecessarily long.

PII COMPLETENESS: Tag every piece of PII present in ocr_text — do not omit any. The pii list must be exhaustive: if you wrote a name, date, phone, address, SSN, email, CC, account number, or ID into ocr_text, it must appear in the pii list.
- Some examples (<=10%) should contain ZERO PII (pure noise / distractor numbers only) and return an empty pii list

ALLOWED PII TYPES (use these strings exactly):
full_name, address, social_security_number, date, email_address, phone_number, credit_card_number, account_id, government_id, other_pii

Use government_id for: passport numbers, driver license numbers, state ID numbers, and other government-issued identity document numbers. The value must be the verbatim substring from ocr_text (e.g. "AB1234567", "D1234567").
Use other_pii for: MRN, employee ID, EIN, TIN, policy/claim/booking/PNR/tracking/case/voter ID numbers, and account numbers that aren't bank accounts. The value must be the verbatim substring from ocr_text (e.g. "1Z999AA10123456784").

VALUE FORMAT: Real PDFs show PII in many forms. Two possible forms — the mix between them is controlled by the noise level instruction below:
- CLEAN/CONTIGUOUS: PII appears as a single uninterrupted span. E.g. phone "(415) 555-0123", ssn "123-45-6789", credit_card "4111 1111 1111 1111", date "01/15/1980", address "123 Main St, Austin, TX 78701". Value is that exact span.
- SCATTERED/NOISY: PII tokens are split by label fields, box codes, or junk tokens. E.g. "First Name: Jason Last Name: Chow" → value "Jason Chow"; "987 Main ST do do do Boston WA box12 12d 214122" → value "987 Main ST Boston WA 214122". Value is only the meaningful PII tokens, joined naturally, skipping noise.
Every token in the value MUST appear somewhere in ocr_text.

CRITICAL RULES:
1. Every token in a pii value MUST appear somewhere in ocr_text. The value does NOT need to be a contiguous substring — OCR output often has noise labels or junk tokens interspersed within PII. Build the value from only the meaningful PII tokens as they appear in ocr_text, skipping noise. Example: ocr_text "First Name: Jason Last Name: Chow" → value "Jason Chow"; ocr_text "987 Main ST do do do Boston WA box12 12d 214122" → value "987 Main ST Boston WA 214122".
2. Do NOT leave any name/address/phone/SSN/email/CC/DOB visible in ocr_text un-tagged. If you write it, tag it.
3. Do NOT use real public figures' names or real organizations. Invent names; companies/hospitals/banks may be plausible-sounding inventions.
4. Vary document types across the batch.
5. Vary formatting heavily: mix UPPERCASE and Title Case, mix line breaks vs. spaces vs. commas, mix US and international formats (~15% international addresses/phones).
{noise_instructions}""".strip()

_NOISE_PATTERNS = """
Document-type noise patterns to use (pick patterns that match the document type in each example):
- W-2 / tax forms: box codes between PII tokens (12a 12b 12c 12d 13 14 15c 16 17 18 19 20), OMB control numbers, "VOID" / "CORRECTED" stamps, employer state ID fragments, "Wages tips other comp" label, "Federal income tax withheld" label
- Paystubs: pay period codes (PP01 PP02), cost center / dept codes (CC4421 DEPT07), YTD labels ("YTD GROSS", "YTD FED"), check number fragments, hours/rate columns bleeding into name or address lines
- Driver license / state ID: field codes interspersed (4a DOB 4b HT 5'10" 4c WT 185 5 SEX M 8 DD 09182763 9 RSTR NONE), AAMVA codes, card revision dates, audit numbers
- Medical / prescription: ICD-10 codes (Z00.00 J06.9 M54.5) near patient name or DOB, CPT codes (99213 99214), NPI fragments, DEA number fragments, NDC codes near patient address, "Sig:" / "Disp:" labels
- Bank statement: transaction codes (ACH CR DDA WD INT), branch / routing suffix, SWIFT/BIC fragments near account holder name, memo line text bleeding into address
- Shipping label: zone codes (ZONE 4), service codes (PM PRIORITY USPS FIRST-CLASS), IMb barcode digits scattered around address, "SHIP TO:" / "FROM:" labels splitting name/address, carrier facility codes (BWI NDC)
- Boarding pass: PNR / confirmation code near passenger name, flight codes (AA2847 UA0012), gate/zone/group codes (GATE B22 GROUP 3 ZONE 2) splitting name or date, seat codes (24F)
- 1099 / financial: box numbers (Box 1 Box 2a Box 3 Box 7) interspersed with payer/recipient name or address, CUSIP/ISIN fragments, "PAYER'S TIN" label before SSN, "RECIPIENT'S TIN" label
- Passport / travel doc: MRZ-line fragments (P<USA...) near name, ICAO control digits, visa foil codes near dates
- Utility bill: meter number fragments (MTR 4821093), tariff / rate codes (RS-1 TOU-D) near address, service point ID near name, territory codes
- Insurance claim / EOB: claim line numbers (Ln 01 Ln 02), revenue codes (0250 0360), modifier codes (25 59 GT) near diagnosis date or patient name, "INSURED'S NAME" vs "PATIENT'S NAME" labels splitting fields
- Hotel folio: folio number, room type codes (KNGNS DLX), rate plan codes (BAR RACK), confirmation number near guest name or dates
- Lease / legal: clause numbers (§ 4.2 ¶ 7), exhibit references (Exhibit A), parcel / APN numbers near address, notary stamp fragments near dates and names
"""

NOISE_INSTRUCTIONS: dict[str, str] = {
    "low": (
        "NOISE LEVEL: LOW. Most PII should appear cleanly and contiguously (~90%). "
        "Scattered/non-contiguous PII should be rare (~10%). "
        "Use minimal label intrusions and few junk tokens around PII."
    ),
    "medium": (
        "NOISE LEVEL: MEDIUM (default). Mix clean (~60%) and noisy (~40%) PII. "
        "Inject document-type-appropriate noise tokens between or around PII spans — "
        "box codes, field labels, control numbers, and boilerplate as described in the noise patterns below. "
        "About 40% of PII items should be non-contiguous in the text."
        + _NOISE_PATTERNS
    ),
    "high": (
        "NOISE LEVEL: HIGH. Maximize OCR realism. Most PII (~80%) should be non-contiguous — "
        "aggressively split by document-specific noise tokens, box codes, field labels, and boilerplate "
        "as described in the noise patterns below. "
        "Examples: W-2 address interrupted by '12d 13 14 15c' box codes; "
        "name split as 'LAST NAME: Chow 12b FIRST: Jason'; "
        "SSN broken as '123 Box7 -45- EIN 6789'; "
        "patient DOB preceded by 'ICD Z00.00 CPT 99213 DOB 03/15/1978'; "
        "shipping address fragmented as 'SHIP TO: 423 ZONE4 Elm St PM NDC Chicago IL 60601'; "
        "driver license address as '4a 742 Evergreen Ter 4b HT 5'09 Springfield IL 62704 DD 8812763'. "
        "Use extra whitespace, mid-value line breaks, and scanner artifacts ('|||', '---', '....') freely."
        + _NOISE_PATTERNS
    ),
}

PiiType = Literal[
    "full_name",
    "address",
    "social_security_number",
    "date",
    "email_address",
    "phone_number",
    "credit_card_number",
    "account_id",
    "government_id",
    "other_pii",
]


class PiiItem(BaseModel):
    type: PiiType
    value: str = Field(min_length=1)


class PiiExample(BaseModel):
    ocr_text: str = Field(min_length=MIN_OCR_TEXT_CHARS, max_length=MAX_OCR_TEXT_CHARS)
    pii: list[PiiItem]


class PiiBatch(BaseModel):
    examples: list[PiiExample] = Field(min_length=EXAMPLES_PER_CALL, max_length=EXAMPLES_PER_CALL)


def normalize_ocr_text(text: str) -> str:
    if text.startswith("..."):
        return text[3:].lstrip()
    return text


def build_prompt(noise: str = "medium", examples_per_call: int = EXAMPLES_PER_CALL) -> str:
    noise_instr = NOISE_INSTRUCTIONS.get(noise, NOISE_INSTRUCTIONS["medium"])
    return (
        PROMPT.format(noise_instructions=noise_instr)
        .replace("Generate exactly 10 examples.", f"Generate exactly {examples_per_call} examples.")
    )


def request_example_batch(
    client: OpenAI,
    model: str = MODEL,
    examples_per_call: int = EXAMPLES_PER_CALL,
    noise: str = "medium",
) -> PiiBatch:
    prompt = build_prompt(noise=noise, examples_per_call=examples_per_call)
    response = client.responses.parse(
        model=model,
        instructions=SYSTEM_INSTRUCTIONS,
        input=prompt,
        text_format=PiiBatch,
        max_output_tokens=12000,
    )
    batch = response.output_parsed
    if batch is None:
        raise ValueError("The model did not return a parsed structured output.")
    for example in batch.examples:
        example.ocr_text = normalize_ocr_text(example.ocr_text)
    return batch


def write_temp_jsonl(batch: PiiBatch, base_dir: Path = BASE_DIR) -> Path:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        delete=False,
        dir=base_dir,
        prefix="pii_batch_",
        suffix=".jsonl.tmp",
    ) as tmp:
        for example in batch.examples:
            tmp.write(json.dumps(example.model_dump(), ensure_ascii=False) + "\n")
        return Path(tmp.name)


def create_temp_jsonl(base_dir: Path = BASE_DIR) -> Path:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        delete=False,
        dir=base_dir,
        prefix="pii_batch_",
        suffix=".jsonl.tmp",
    ) as tmp:
        return Path(tmp.name)


def append_jsonl_rows(path: Path, rows: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def validate_verbatim(example: PiiExample) -> list[str]:
    errors: list[str] = []
    text = example.ocr_text
    for idx, pii in enumerate(example.pii, start=1):
        missing = [t for t in pii.value.split() if t not in text]
        if missing:
            errors.append(
                f"pii[{idx}] type={pii.type} has tokens not found in ocr_text: {missing!r} (value={pii.value!r})"
            )
    return errors


def validate_jsonl_file(path: Path) -> int:
    schema_error_count = 0
    verbatim_error_count = 0
    line_count = 0

    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            raw = line.rstrip("\n")
            if not raw.strip():
                continue
            line_count += 1
            try:
                example = PiiExample.model_validate_json(raw)
                example.ocr_text = normalize_ocr_text(example.ocr_text)
            except Exception as exc:
                schema_error_count += 1
                print(f"line {line_no}: invalid JSON/schema: {exc}")
                continue

            errors = validate_verbatim(example)
            if errors:
                verbatim_error_count += len(errors)
                for err in errors:
                    print(f"line {line_no}: {err}")

    total_error_count = schema_error_count + verbatim_error_count
    if total_error_count == 0:
        print(f"Validated {line_count} examples in {path} with no schema or token-presence errors.")
    else:
        print(
            f"Validated {line_count} examples in {path}; "
            f"schema errors={schema_error_count}, token-presence errors={verbatim_error_count}."
        )

    return 0 if total_error_count == 0 else 1


def clean_verbatim_errors(path: Path) -> int:
    kept_lines: list[str] = []
    removed_count = 0
    line_count = 0

    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                kept_lines.append(line)
                continue

            line_count += 1
            raw = line.rstrip("\n")
            try:
                example = PiiExample.model_validate_json(raw)
                example.ocr_text = normalize_ocr_text(example.ocr_text)
            except Exception as exc:
                kept_lines.append(line)
                print(f"line {line_no}: kept because JSON/schema could not be validated: {exc}")
                continue

            if len(example.ocr_text) < 250:
                removed_count += 1
                print(f"line {line_no}: removed because ocr_text is shorter than 250 chars ({len(example.ocr_text)})")
                continue

            errors = validate_verbatim(example)
            if errors:
                removed_count += 1
                print(f"line {line_no}: removed due to token-presence error")
                for err in errors:
                    print(f"line {line_no}: {err}")
                continue

            kept_lines.append(line)

    with path.open("w", encoding="utf-8") as f:
        f.writelines(kept_lines)

    print(f"Scanned {line_count} examples in {path}; removed {removed_count} lines with token-presence errors.")
    return 0


AUDIT_SYSTEM = """You are a PII auditor for an OCR training dataset. Given a document snippet and its current (possibly incomplete) PII list, return the COMPLETE exhaustive list of all PII present in the text.

ALLOWED PII TYPES and how to recognize them (labels are often absent — use context and value patterns):

- full_name: A person's name. Can be first+last or include a middle name/initial. When in doubt, tag it.

- address: Any location string that could identify where someone lives, works, or receives mail. Can be a full street address, a partial address fragment, city+state, zip code, or P.O. Box. Err on the side of tagging.

- social_security_number: 9 digits in any grouping — "XXX-XX-XXXX", "XXX XX XXXX", or a 9-digit run.

- date: Any calendar date in any format — MM/DD/YYYY, YYYY-MM-DD, "Jan 15 2023", "15 January 2023", etc. Includes birth dates, service dates, due dates, expiry dates — tag all dates.

- email_address: Anything with "@" and a domain.

- phone_number: Any digit sequence that looks like a phone number, with or without country code, dashes, dots, spaces, or parentheses. When in doubt, tag it.

- credit_card_number: Digit groups that look like a card number, including masked forms like "**** 1234".

- account_id: Any alphanumeric string that identifies an account — financial, billing, utility, insurance, etc. Value is the bare ID only, strip any label prefix (e.g. "123456789", not "Acct: 123456789").

- government_id: A government-issued ID number — passport, driver license, state ID, etc. Value is the bare ID only, strip any label prefix (e.g. "AB1234567", not "Passport AB1234567").

- other_pii: Any other identifier for a specific person or their record — MRN, employee ID, policy/claim/booking/confirmation/PNR/tracking/case/voter ID, EIN, TIN. Value is the bare ID only, strip any label prefix (e.g. "1Z999AA10123456784", not "Tracking 1Z999AA10123456784"). When unsure, use this type.

General rules:
- Every token in a value MUST appear somewhere in ocr_text. The value does NOT need to be a contiguous substring — OCR text often has noise or label tokens interspersed within a PII span. Build the value from only the meaningful PII tokens, skipping noise. Example: "First Name: Jason Last Name: Chow" → "Jason Chow"; "987 Main ST do do do Boston WA box12 12d 214122" → "987 Main ST Boston WA 214122".
- Strip label prefixes from values: store the bare PII tokens, not "Label: value".
- Include all PII already in the existing list plus any that are missing.
- Do NOT tag invoice/PO/order/file/reference/OMB numbers, box codes (e.g. "12a"), or dollar amounts as PII.
- If there is truly no PII, return an empty list."""


class PiiAuditResult(BaseModel):
    pii: list[PiiItem]


class PiiAuditBatch(BaseModel):
    results: list[PiiAuditResult]


AUDIT_BATCH_SIZE = 10


def audit_batch_pii(client: OpenAI, examples: list[dict], retries: int = 3) -> list[list[dict]]:
    """Audit a batch of examples, returning a corrected pii list for each."""
    prompt_entries = [
        f"Example {i + 1}:\nocr_text: {json.dumps(ex['ocr_text'])}\nexisting_pii: {json.dumps(ex['pii'])}"
        for i, ex in enumerate(examples)
    ]
    prompt = (
        "Below are " + str(len(examples)) + " OCR examples. "
        "For each, return the complete exhaustive PII list in the same order.\n\n"
        + "\n\n".join(prompt_entries)
    )

    for attempt in range(retries):
        try:
            response = client.responses.parse(
                model=MODEL,
                instructions=AUDIT_SYSTEM,
                input=prompt,
                text_format=PiiAuditBatch,
                timeout=120,
            )
            result = response.output_parsed
            if result is None or len(result.results) != len(examples):
                raise ValueError(f"Expected {len(examples)} results, got {len(result.results) if result else 0}")
            return [[item.model_dump() for item in r.pii] for r in result.results]
        except Exception as exc:
            import traceback
            traceback.print_exc()
            if attempt < retries - 1:
                print(f"  retrying after error: {exc}")
            else:
                print(f"  giving up after {retries} attempts: {exc}")
                return [ex["pii"] for ex in examples]
    return [ex["pii"] for ex in examples]


def fix_missing_pii(path: Path, batches: int | None = None, dry_run: bool = True) -> int:
    client = OpenAI()

    with path.open("r", encoding="utf-8") as f:
        lines = [l.rstrip("\n") for l in f.readlines()]

    total = len(lines)
    fixed_count = 0
    added_count = 0

    if dry_run:
        print("DRY RUN — no changes will be written to disk.")

    # collect non-empty line indices and their parsed objects
    parsed: list[tuple[int, dict]] = []
    for i, raw in enumerate(lines):
        if raw.strip():
            parsed.append((i, json.loads(raw)))

    # build list of batches, then optionally cap it
    all_batches = [
        parsed[s:s + AUDIT_BATCH_SIZE]
        for s in range(0, len(parsed), AUDIT_BATCH_SIZE)
    ]
    if batches is not None:
        all_batches = all_batches[:batches]
        print(f"Limiting to {batches} batch(es) ({batches * AUDIT_BATCH_SIZE} lines max).")

    for batch_no, batch in enumerate(all_batches, 1):
        new_piis = audit_batch_pii(client, [obj for _, obj in batch])

        for (line_idx, obj), new_pii in zip(batch, new_piis):
            existing_set = {(p["type"], p["value"]) for p in obj["pii"]}
            new_set = {(p["type"], p["value"]) for p in new_pii}

            added = new_set - existing_set
            removed = existing_set - new_set

            if added or removed:
                fixed_count += 1
                added_count += len(added)
                lineno = line_idx + 1
                print(f"line {lineno}:")
                for t, v in sorted(added):
                    print(f"  ADD    [{t}] {v!r}")
                for t, v in sorted(removed):
                    print(f"  REMOVE [{t}] {v!r}")
                if not dry_run:
                    obj["pii"] = new_pii
                    lines[line_idx] = json.dumps(obj, ensure_ascii=False)

        print(f"  batch {batch_no}/{len(all_batches)} done | fixed={fixed_count} added={added_count}")

        if not dry_run:
            with path.open("w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

    print(f"Done. Scanned {total} lines; fixed {fixed_count} lines; added {added_count} PII items.")
    return 0


def generate_examples(noise: str = "medium") -> None:
    client = OpenAI()
    print(f"Base dir: {BASE_DIR}")
    print(f"Model: {MODEL}")
    print(f"Noise level: {noise}")
    examples: list[dict] = []
    temp_path = create_temp_jsonl()
    print(f"Temporary batch file: {temp_path}")

    for _ in range(0, TOTAL_EXAMPLES, EXAMPLES_PER_CALL):
        batch = request_example_batch(client=client, noise=noise)
        batch_examples = [example.model_dump() for example in batch.examples]
        append_jsonl_rows(temp_path, batch_examples)
        examples.extend(batch_examples)
        print(f"Generated {min(len(examples), TOTAL_EXAMPLES)}/{TOTAL_EXAMPLES} examples")

    examples = examples[:TOTAL_EXAMPLES]
    print(f"Generated {len(examples)} examples")
    print(json.dumps(examples[0], ensure_ascii=False, indent=2))
    
    for e in examples[:10]:
        print(len(e['ocr_text']))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "mode",
        nargs="?",
        default="generate",
        choices=["generate", "validate", "clean", "fix"],
        help="Run generation, validate an existing .jsonl.tmp file, remove rows with verbatim errors, or fix missing PII.",
    )
    parser.add_argument(
        "input_file",
        nargs="?",
        help="Path to a .jsonl/.jsonl.tmp file when mode=validate.",
    )
    parser.add_argument(
        "--batches",
        type=int,
        default=None,
        help="Maximum number of batches to process in fix mode.",
    )
    parser.add_argument(
        "--no-dry-run",
        action="store_true",
        default=False,
        help="Actually write changes to disk (default is dry run).",
    )
    parser.add_argument(
        "--noise",
        choices=["low", "medium", "high"],
        default="medium",
        help="OCR noise level for generate mode (default: medium).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.mode == "validate":
        if not args.input_file:
            raise SystemExit("validate mode requires an input file path")
        raise SystemExit(validate_jsonl_file(Path(args.input_file)))
    if args.mode == "clean":
        if not args.input_file:
            raise SystemExit("clean mode requires an input file path")
        raise SystemExit(clean_verbatim_errors(Path(args.input_file)))
    if args.mode == "fix":
        if not args.input_file:
            raise SystemExit("fix mode requires an input file path")
        raise SystemExit(fix_missing_pii(Path(args.input_file), batches=args.batches, dry_run=not args.no_dry_run))
    generate_examples(noise=args.noise)


if __name__ == "__main__":
    main()
