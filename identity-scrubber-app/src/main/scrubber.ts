import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { MODEL_NAME } from './ollama';

export type ServeEvent = Record<string, unknown> & { event: string; cmd?: string };

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

  ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const bin = binaryPath();
      console.log('[scrubber] spawning:', bin);
      let child: ChildProcessWithoutNullStreams;
      const existingNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
      const bypass = ['127.0.0.1', 'localhost', '::1'];
      const mergedNoProxy = [existingNoProxy, ...bypass].filter(Boolean).join(',');

      try {
        child = spawn(bin, ['--serve', '--rapidocr', `--model=${MODEL_NAME}`, '--ocr-dpi=600'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            OLLAMA_HOST: 'http://127.0.0.1:11434',
            NO_PROXY: mergedNoProxy,
            no_proxy: mergedNoProxy,
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
        });
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
        if (evt.event === 'ready') {
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
      const listener = (evt: ServeEvent): void => {
        if (evt.cmd && evt.cmd !== targetCmd) return;
        onEvent(evt);
        if (evt.event === 'done') {
          this.off('event', listener);
          resolve(evt);
        } else if (evt.event === 'error') {
          this.off('event', listener);
          reject(new Error(String(evt.message ?? 'scrubber error')));
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
