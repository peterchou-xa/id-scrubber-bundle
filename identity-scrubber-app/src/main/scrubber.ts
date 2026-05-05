import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { EventEmitter } from 'events';
import {
  ensureGlinerModel,
  getGlinerModelDir,
  GLINER_MODEL_FILE,
  GlinerProgress,
} from './gliner';

export type ServeEvent = Record<string, unknown> & {
  cmd?: string;
  phase?: string;
  status?: string;
  kind?: string;
};

// The phase whose status:"done" event marks the *end* of each cmd.
const TERMINAL_PHASE: Record<string, string> = {
  detect: 'analyze',
  scrub: 'redact',
};

export const GLINER_MODEL_NAME = 'nvidia/gliner-pii';

function binaryPath(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'scrubber')
    : path.join(app.getAppPath(), 'resources', 'scrubber');
  return path.join(base, 'identity-scrubber');
}

class ScrubberService extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private readyPromise: Promise<void> | null = null;

  ensureStarted(onGlinerProgress?: (evt: GlinerProgress) => void): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      // Make sure the ONNX model is on disk before we ask the python serve
      // loop to mmap it. ensureGlinerModel is idempotent and a no-op if the
      // cache check passes.
      const modelDir = await ensureGlinerModel(onGlinerProgress ?? (() => {}));

      await new Promise<void>((resolve, reject) => {
        const bin = binaryPath();
        console.log('[scrubber] spawning:', bin, 'modelDir:', modelDir);
        let child: ChildProcessWithoutNullStreams;

        try {
          child = spawn(
            bin,
            [
              '--serve',
              `--model=${GLINER_MODEL_NAME}`,
              `--gliner-onnx-dir=${modelDir}`,
              `--gliner-onnx-file=${GLINER_MODEL_FILE}`,
              '--chunk-size=1000',
              '--ocr-dpi=300',
            ],
            {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: {
                ...process.env,
                PATH: [
                  process.env.PATH ?? '',
                  '/usr/local/bin',
                  '/opt/homebrew/bin',
                  '/usr/bin',
                  '/bin',
                  '/usr/sbin',
                  '/sbin',
                ]
                  .filter(Boolean)
                  .join(':'),
              },
            },
          );
        } catch (err) {
          this.readyPromise = null;
          reject(err);
          return;
        }
        this.child = child;

        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        const onReady = (evt: ServeEvent): void => {
          if (evt.status === 'ready' && !evt.cmd) {
            this.off('event', onReady);
            console.log('[scrubber] ready');
            finish(resolve);
          }
        };
        this.on('event', onReady);

        const logPath = path.join(app.getPath('logs'), 'scrubber.log');
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true });
        } catch {
          // ignore
        }
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        logStream.write(`\n--- scrubber spawn ${new Date().toISOString()} bin=${bin} ---\n`);
        console.log('[scrubber] log file:', logPath);

        child.stdout.on('data', (buf: Buffer) => this.consumeStdout(buf.toString('utf8')));
        child.stderr.on('data', (buf: Buffer) => {
          const s = buf.toString('utf8');
          console.log('[scrubber stderr]', s.trimEnd());
          logStream.write(s);
          this.emit('stderr', s);
        });
        child.on('error', (err) => {
          console.error('[scrubber] spawn error:', err);
          this.readyPromise = null;
          this.child = null;
          finish(() => reject(err));
        });
        child.on('close', (code) => {
          console.log('[scrubber] exited with code', code);
          this.emit('exit', code);
          this.readyPromise = null;
          this.child = null;
          finish(() => reject(new Error(`scrubber exited before ready (code ${code})`)));
        });
      });
    })().catch((err) => {
      this.readyPromise = null;
      throw err;
    });

    return this.readyPromise;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as ServeEvent;
        this.emit('event', evt);
      } catch {
        this.emit('stderr', `[non-JSON stdout] ${line}\n`);
      }
    }
  }

  private send(req: Record<string, unknown>): void {
    if (!this.child) throw new Error('scrubber process not started');
    this.child.stdin.write(JSON.stringify(req) + '\n');
  }

  async runCommand(
    req: Record<string, unknown>,
    onEvent: (evt: ServeEvent) => void,
  ): Promise<ServeEvent> {
    await this.ensureStarted();
    return new Promise((resolve, reject) => {
      const targetCmd = req.cmd as string;
      const terminalPhase = TERMINAL_PHASE[targetCmd];
      const listener = (evt: ServeEvent): void => {
        if (evt.cmd && evt.cmd !== targetCmd) return;
        onEvent(evt);
        if (evt.status === 'error') {
          this.off('event', listener);
          reject(new Error(String(evt.message ?? 'scrubber error')));
        } else if (evt.status === 'done' && evt.phase === terminalPhase) {
          this.off('event', listener);
          resolve(evt);
        }
      };
      this.on('event', listener);
      try {
        this.send(req);
      } catch (err) {
        this.off('event', listener);
        reject(err);
      }
    });
  }

  shutdown(): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
    } catch {
      // ignore
    }
    this.child.kill();
    this.child = null;
    this.readyPromise = null;
  }
}

export const scrubberService = new ScrubberService();

// Re-export so callers can also access the model directory if needed.
export { getGlinerModelDir };
