import { createHash } from 'crypto';

// Fixed deterministic byte transformation. Must match the implementation in
// identity-scrubber-app/src/main/deviceId.ts byte-for-byte — both sides
// derive the same device_id from the same machine_id, and divergence here
// would treat every account as forged.
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
  return createHash('sha256').update(shuffle(machineId)).digest('hex');
}
