import { spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';

export interface ScrubberResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function binaryPath(): string {
  // In dev, resources live in the repo; in a packaged app they live under
  // `process.resourcesPath`.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'scrubber')
    : path.join(app.getAppPath(), 'resources', 'scrubber');
  return path.join(base, 'identity-scrubber');
}

export async function runScrubber(
  pdfPath: string,
  onStderr?: (chunk: string) => void,
): Promise<ScrubberResult> {
  const bin = binaryPath();
  const args = [pdfPath, '--scrub', '--rapidocr', '--ocr-dpi=600'];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf: Buffer) => {
      const s = buf.toString('utf8');
      stderr += s;
      onStderr?.(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export function defaultTestPdf(): string {
  // Using /tmp avoids macOS TCC prompts that block Electron from reading
  // ~/Downloads in dev mode. Copy the source PDF here before running.
  return '/tmp/scrubber-test.pdf';
}
