import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';

// Fixed deterministic byte transformation. Must match the service-side
// implementation at identity-scrubber-service/src/billing/device-id.ts —
// the backend recomputes the expected device_id from machine_id when
// creating new accounts, and any divergence here would reject every user.
const SHUFFLE_PATTERN = Buffer.from([0x5a, 0x3c, 0xa7, 0xe1, 0x18, 0x9f, 0x42, 0xb6]);

export function shuffle(machineId: string): Buffer {
  const buf = Buffer.from(machineId, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ SHUFFLE_PATTERN[i % SHUFFLE_PATTERN.length];
  }
  const mid = Math.floor(out.length / 2);
  return Buffer.concat([out.subarray(mid), out.subarray(0, mid)]);
}

export function computeDeviceId(machineId: string): string {
  return crypto.createHash('sha256').update(shuffle(machineId)).digest('hex');
}

let cachedMachineId: string | null = null;

// OS-level identifier. Read fresh on first call per process; never persisted
// to disk by the app — the on-disk `device-id` file is the only persistent
// piece of the dual-ID scheme.
export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const platform = process.platform;
  let raw = '';
  try {
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      raw = m?.[1] ?? '';
    } else if (platform === 'linux') {
      raw = (fs.existsSync('/etc/machine-id')
        ? fs.readFileSync('/etc/machine-id', 'utf8')
        : fs.readFileSync('/var/lib/dbus/machine-id', 'utf8')
      ).trim();
    } else if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8' },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      raw = m?.[1] ?? '';
    }
  } catch (err) {
    throw new Error(`Failed to read machine id: ${(err as Error).message}`);
  }
  raw = raw.trim().toLowerCase();
  if (!/^[0-9a-f-]{32,64}$/.test(raw)) {
    throw new Error(`Unexpected machine_id format: ${raw}`);
  }
  cachedMachineId = raw;
  return raw;
}

export function readOrCreateDeviceIdFile(filePath: string, machineId: string): string {
  if (fs.existsSync(filePath)) {
    const v = fs.readFileSync(filePath, 'utf8').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) return v;
  }
  const value = computeDeviceId(machineId);
  fs.writeFileSync(filePath, value, { encoding: 'utf8' });
  return value;
}
