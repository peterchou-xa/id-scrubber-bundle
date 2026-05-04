import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { app, net } from 'electron';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export const GLINER_REPO = 'peterchou26/gliner-pii-onnx';
export const GLINER_MODEL_FILE = 'model_fp16.onnx';

// All files that must exist locally for the python serve loop to start.
// `model_fp16.onnx` references `model_fp16.onnx_data` by relative path, so
// they MUST live in the same directory.
const REQUIRED_FILES = [
  'model_fp16.onnx',
  'model_fp16.onnx_data',
  'gliner_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

export type GlinerProgress =
  | { stage: 'checking' }
  | { stage: 'cached' }
  | { stage: 'starting'; totalBytes?: number }
  | {
      stage: 'downloading';
      file: string;
      fileIndex: number;
      fileCount: number;
      received: number;
      total: number;
      overallReceived: number;
      overallTotal: number;
      percent: number;
    }
  | { stage: 'done'; dir: string }
  | { stage: 'error'; message: string };

export type GlinerStatus = {
  cached: boolean;
  dir: string;
  repo: string;
};

export function getGlinerModelDir(): string {
  return path.join(app.getPath('userData'), 'models', 'gliner-pii-onnx');
}

function fileUrl(name: string): string {
  return `https://huggingface.co/${GLINER_REPO}/resolve/main/${name}`;
}

async function fileExistsNonEmpty(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export async function isGlinerCached(): Promise<boolean> {
  const dir = getGlinerModelDir();
  const checks = await Promise.all(
    REQUIRED_FILES.map((f) => fileExistsNonEmpty(path.join(dir, f))),
  );
  return checks.every(Boolean);
}

export async function getGlinerStatus(): Promise<GlinerStatus> {
  return {
    cached: await isGlinerCached(),
    dir: getGlinerModelDir(),
    repo: GLINER_REPO,
  };
}

// Issues a HEAD to discover the actual byte size HF will serve. The
// `x-linked-size` header reflects LFS-resolved size; fall back to
// `content-length`. Returns 0 if neither is present.
async function headSize(url: string): Promise<number> {
  const res = await net.fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HEAD ${url} failed: ${res.status} ${res.statusText}`);
  }
  const linked = res.headers.get('x-linked-size');
  if (linked && /^\d+$/.test(linked)) return Number(linked);
  const cl = res.headers.get('content-length');
  if (cl && /^\d+$/.test(cl)) return Number(cl);
  return 0;
}

async function downloadOne(
  url: string,
  destPath: string,
  onChunk: (delta: number) => void,
): Promise<void> {
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  const partial = `${destPath}.partial`;
  // Wipe any stale partial from a previous interrupted run.
  try {
    await fsp.rm(partial, { force: true });
  } catch {
    // ignore
  }

  // Tee chunks: feed bytes both to the file and to the progress callback.
  const reader = res.body.getReader();
  const out = fs.createWriteStream(partial);
  const nodeReadable = new Readable({
    async read(): Promise<void> {
      try {
        const { value, done } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        onChunk(value.byteLength);
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  try {
    await pipeline(nodeReadable, out);
  } catch (err) {
    try {
      await fsp.rm(partial, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }

  // Atomic swap: only the rename moves the file into its final name, so a
  // crash mid-download leaves only `*.partial` behind, never a half-written
  // file the cache check would think is valid.
  await fsp.rename(partial, destPath);
}

export async function ensureGlinerModel(
  onProgress: (evt: GlinerProgress) => void,
): Promise<string> {
  const dir = getGlinerModelDir();
  onProgress({ stage: 'checking' });

  if (await isGlinerCached()) {
    onProgress({ stage: 'cached' });
    onProgress({ stage: 'done', dir });
    return dir;
  }

  await fsp.mkdir(dir, { recursive: true });

  // Resolve all sizes up-front so the progress bar can show overall %.
  // For files HF doesn't size via headers (small JSONs), we fall back to 0
  // and just include them in the file count.
  const sizes = await Promise.all(REQUIRED_FILES.map((f) => headSize(fileUrl(f))));
  const overallTotal = sizes.reduce((a, b) => a + b, 0);
  onProgress({ stage: 'starting', totalBytes: overallTotal });

  let overallReceived = 0;
  for (let i = 0; i < REQUIRED_FILES.length; i++) {
    const file = REQUIRED_FILES[i];
    const total = sizes[i];
    const dest = path.join(dir, file);

    // Skip files that already passed the cache check individually — useful
    // when a partial run got most of the bytes and we're resuming.
    if (await fileExistsNonEmpty(dest)) {
      overallReceived += total;
      onProgress({
        stage: 'downloading',
        file,
        fileIndex: i + 1,
        fileCount: REQUIRED_FILES.length,
        received: total,
        total,
        overallReceived,
        overallTotal,
        percent: overallTotal > 0 ? overallReceived / overallTotal : 1,
      });
      continue;
    }

    let received = 0;
    let lastEmit = 0;
    await downloadOne(fileUrl(file), dest, (delta) => {
      received += delta;
      overallReceived += delta;
      // Throttle progress events to ~10/sec to avoid flooding the IPC
      // channel during multi-hundred-MB downloads.
      const now = Date.now();
      if (now - lastEmit < 100 && received < total) return;
      lastEmit = now;
      onProgress({
        stage: 'downloading',
        file,
        fileIndex: i + 1,
        fileCount: REQUIRED_FILES.length,
        received,
        total,
        overallReceived,
        overallTotal,
        percent: overallTotal > 0 ? overallReceived / overallTotal : 0,
      });
    });
  }

  onProgress({ stage: 'done', dir });
  return dir;
}
