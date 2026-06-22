import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

// Thrown when an encrypted artifact exists but can't be read/written because
// the OS secure store is locked or Keychain access was denied. Callers decide
// whether to surface it (billing) or fall back (device-id, which is
// recomputable). See billing.ts guardKeychain().
export class KeychainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainUnavailableError';
  }
}

// All encrypted artifacts live together under userData/models as raw
// safeStorage byte blobs named <name>.enc (device-id.enc, billing.enc,
// identifiers.enc). Raw bytes — no base64/JSON wrapper.
export function securePath(name: string): string {
  return path.join(app.getPath('userData'), 'models', `${name}.enc`);
}

// Returns the decrypted plaintext, or null if the file doesn't exist yet
// (a genuine "no value", distinct from a Keychain failure, which throws).
export function readSecure(name: string): string | null {
  const p = securePath(name);
  if (!fs.existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new KeychainUnavailableError('secure storage is not available');
  }
  try {
    return safeStorage.decryptString(fs.readFileSync(p));
  } catch (err) {
    throw new KeychainUnavailableError((err as Error).message);
  }
}

export function writeSecure(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new KeychainUnavailableError('secure storage is not available');
  }
  let payload: Buffer;
  try {
    payload = safeStorage.encryptString(value);
  } catch (err) {
    throw new KeychainUnavailableError((err as Error).message);
  }
  const p = securePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, payload);
}
