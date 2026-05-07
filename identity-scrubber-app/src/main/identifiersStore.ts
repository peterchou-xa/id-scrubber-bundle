import { app, safeStorage } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

const FILE_NAME = 'identifiers.json';

export type IdentifierType = 'name' | 'ssn' | 'dob' | 'email' | 'address' | 'other';

export interface Identifier {
  type: IdentifierType;
  value: string;
}

const VALID_TYPES: IdentifierType[] = ['name', 'ssn', 'dob', 'email', 'address', 'other'];

type StoredFile = {
  version: 1;
  encrypted: boolean;
  // base64 of the encrypted buffer when encrypted=true; raw JSON string when false.
  payload: string;
};

function normalize(arr: unknown): Identifier[] {
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((entry): Identifier[] => {
    if (typeof entry === 'string') {
      const value = entry.trim();
      return value ? [{ type: 'other', value }] : [];
    }
    if (entry && typeof entry === 'object') {
      const e = entry as { type?: unknown; value?: unknown };
      if (typeof e.value !== 'string') return [];
      const value = e.value.trim();
      if (!value) return [];
      const type = VALID_TYPES.includes(e.type as IdentifierType)
        ? (e.type as IdentifierType)
        : 'other';
      return [{ type, value }];
    }
    return [];
  });
}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

export async function loadIdentifiers(): Promise<Identifier[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredFile;
    let json: string;
    if (parsed.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('safeStorage not available to decrypt identifiers');
      }
      json = safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'));
    } else {
      json = parsed.payload;
    }
    return normalize(JSON.parse(json));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveIdentifiers(values: Identifier[]): Promise<void> {
  const cleaned = normalize(values);
  const json = JSON.stringify(cleaned);
  const useEncryption = safeStorage.isEncryptionAvailable();
  const stored: StoredFile = useEncryption
    ? { version: 1, encrypted: true, payload: safeStorage.encryptString(json).toString('base64') }
    : { version: 1, encrypted: false, payload: json };
  await fs.mkdir(path.dirname(filePath()), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(stored), 'utf8');
}
