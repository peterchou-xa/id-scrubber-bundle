import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn, execFile, ExecFileOptions } from 'child_process';
import { net } from 'electron';

const OLLAMA_DMG_URL = 'https://ollama.com/download/Ollama.dmg';
const USER_APPS_DIR = path.join(os.homedir(), 'Applications');
export const USER_OLLAMA_APP = path.join(USER_APPS_DIR, 'Ollama.app');
const OLLAMA_HOST = 'http://127.0.0.1:11434';
export const MODEL_NAME = 'gemma3:4b';

export type InstallStatus = {
  installed: boolean;
  location: string | null;
};

export type ProgressEvent =
  | { stage: 'downloading'; percent: number; received?: number; total?: number }
  | { stage: 'installing'; step: 'mount' | 'copy' | 'quarantine' }
  | { stage: 'starting'; location?: string }
  | { stage: 'pulling'; model: string; percent: number; received?: number; total?: number; status?: string }
  | { stage: 'done'; location: string }
  | { stage: 'error'; message: string };

export type ProgressHandler = (event: ProgressEvent) => void;

function execFileP(
  cmd: string,
  args: string[],
  opts: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        e.stdout = stdout.toString();
        e.stderr = stderr.toString();
        return reject(e);
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isOllamaInstalled(): Promise<InstallStatus> {
  if (await pathExists(USER_OLLAMA_APP)) {
    return { installed: true, location: USER_OLLAMA_APP };
  }
  return { installed: false, location: null };
}

type DownloadProgress = { received: number; total: number; percent: number };

function downloadDmg(
  destPath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ received: number; total: number }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: OLLAMA_DMG_URL, redirect: 'follow' });
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let total = 0;

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }

      const lenHeader = response.headers['content-length'];
      if (lenHeader) {
        total = parseInt(Array.isArray(lenHeader) ? lenHeader[0] : lenHeader, 10);
      }

      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        file.write(chunk);
        if (onProgress) {
          onProgress({ received, total, percent: total ? received / total : 0 });
        }
      });

      response.on('end', () => {
        file.end(() => resolve({ received, total }));
      });

      response.on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });

    request.end();
  });
}

async function attachDmg(dmgPath: string): Promise<string> {
  const { stdout } = await execFileP('/usr/bin/hdiutil', [
    'attach',
    dmgPath,
    '-nobrowse',
    '-readonly',
    '-plist',
  ]);

  const mountMatch = stdout.match(/<string>(\/Volumes\/[^<]+)<\/string>/);
  if (!mountMatch) {
    throw new Error('Could not determine DMG mount point');
  }
  return mountMatch[1];
}

async function detachDmg(mountPoint: string): Promise<void> {
  try {
    await execFileP('/usr/bin/hdiutil', ['detach', mountPoint, '-force']);
  } catch (err) {
    console.warn('detach failed:', (err as Error).message);
  }
}

async function copyAppBundle(srcApp: string, destApp: string): Promise<void> {
  if (await pathExists(destApp)) {
    await fsp.rm(destApp, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(destApp), { recursive: true });
  await execFileP('/bin/cp', ['-R', srcApp, destApp]);
}

async function removeQuarantine(appPath: string): Promise<void> {
  try {
    await execFileP('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]);
  } catch (err) {
    console.warn('xattr cleanup failed (non-fatal):', (err as Error).message);
  }
}

async function findOllamaBinary(appPath: string): Promise<string | null> {
  const candidates = [
    path.join(appPath, 'Contents', 'Resources', 'ollama'),
    path.join(appPath, 'Contents', 'MacOS', 'Ollama'),
    path.join(appPath, 'Contents', 'MacOS', 'ollama'),
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pingOllama(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = net.request({ url: `${OLLAMA_HOST}/api/tags`, method: 'GET' });
    req.on('response', (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
      res.on('data', () => {});
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitForOllama(timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingOllama()) return true;
    await sleep(500);
  }
  return false;
}

export async function startOllama(appPath: string): Promise<{ alreadyRunning: boolean }> {
  if (await pingOllama()) return { alreadyRunning: true };

  const bin = await findOllamaBinary(appPath);
  if (!bin) {
    spawn('/usr/bin/open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  }

  const up = await waitForOllama(30000);
  if (!up) throw new Error('Ollama service did not start within 30s');
  return { alreadyRunning: false };
}

export function isModelInstalled(model: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = net.request({ url: `${OLLAMA_HOST}/api/tags`, method: 'GET' });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(false);
          return;
        }
        try {
          const parsed = JSON.parse(body) as { models?: { name: string }[] };
          const names = (parsed.models ?? []).map((m) => m.name);
          resolve(names.includes(model) || names.some((n) => n.startsWith(`${model.split(':')[0]}:`) && n === model));
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

type PullStatus = {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
};

export function ensureModel(
  model: string,
  onProgress?: (evt: ProgressEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url: `${OLLAMA_HOST}/api/pull`,
      method: 'POST',
    });
    req.setHeader('Content-Type', 'application/json');

    let buf = '';
    let failed: Error | null = null;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: PullStatus;
      try {
        parsed = JSON.parse(trimmed) as PullStatus;
      } catch {
        return;
      }
      if (parsed.error) {
        failed = new Error(parsed.error);
        return;
      }

      const status = parsed.status ?? '';
      const total = parsed.total;
      const completed = parsed.completed;
      const hasBytes = typeof total === 'number' && total > 0;
      const percent = hasBytes && typeof completed === 'number' ? completed / total : undefined;

      onProgress?.({
        stage: 'pulling',
        model,
        percent: percent ?? 0,
        received: completed,
        total,
        status,
      });
    };

    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Model pull failed (HTTP ${res.statusCode})`));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });
      res.on('end', () => {
        if (buf.trim()) handleLine(buf);
        if (failed) reject(failed);
        else resolve();
      });
      res.on('error', (err) => reject(err));
    });
    req.on('error', (err) => reject(err));
    req.write(JSON.stringify({ name: model, stream: true }));
    req.end();
  });
}

export type InstallResult = { location: string; reinstalled: boolean };

export async function installOllama(
  opts: { onEvent?: ProgressHandler } = {}
): Promise<InstallResult> {
  const { onEvent } = opts;
  const emit = (event: ProgressEvent): void => {
    if (onEvent) onEvent(event);
  };

  const existing = await isOllamaInstalled();
  if (existing.installed && existing.location) {
    emit({ stage: 'starting', location: existing.location });
    await startOllama(existing.location);
    if (!(await isModelInstalled(MODEL_NAME))) {
      await ensureModel(MODEL_NAME, emit);
    }
    emit({ stage: 'done', location: existing.location });
    return { location: existing.location, reinstalled: false };
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ollama-dl-'));
  const dmgPath = path.join(tmpDir, 'Ollama.dmg');

  emit({ stage: 'downloading', percent: 0 });
  await downloadDmg(dmgPath, ({ percent, received, total }) => {
    emit({ stage: 'downloading', percent, received, total });
  });

  emit({ stage: 'installing', step: 'mount' });
  const mountPoint = await attachDmg(dmgPath);

  try {
    const srcApp = path.join(mountPoint, 'Ollama.app');
    if (!(await pathExists(srcApp))) {
      throw new Error('Ollama.app not found inside DMG');
    }

    emit({ stage: 'installing', step: 'copy' });
    await fsp.mkdir(USER_APPS_DIR, { recursive: true });
    await copyAppBundle(srcApp, USER_OLLAMA_APP);
  } finally {
    await detachDmg(mountPoint);
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  emit({ stage: 'installing', step: 'quarantine' });
  await removeQuarantine(USER_OLLAMA_APP);

  emit({ stage: 'starting' });
  await startOllama(USER_OLLAMA_APP);

  if (!(await isModelInstalled(MODEL_NAME))) {
    await ensureModel(MODEL_NAME, emit);
  }

  emit({ stage: 'done', location: USER_OLLAMA_APP });
  return { location: USER_OLLAMA_APP, reinstalled: true };
}
