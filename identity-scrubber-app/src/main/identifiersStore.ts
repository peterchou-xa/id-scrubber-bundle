import { readSecure, writeSecure } from './secureStore';

export type IdentifierType = 'name' | 'ssn' | 'dob' | 'email' | 'address' | 'other';

export interface Identifier {
  type: IdentifierType;
  value: string;
}

const VALID_TYPES: IdentifierType[] = ['name', 'ssn', 'dob', 'email', 'address', 'other'];

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

// Stored as raw safeStorage bytes at models/identifiers.enc. readSecure throws
// KeychainUnavailableError if the Keychain is denied (surfaced by the IPC
// handler); a null return means there's simply nothing saved yet.
export async function loadIdentifiers(): Promise<Identifier[]> {
  const json = readSecure('identifiers');
  if (json === null) return [];
  try {
    return normalize(JSON.parse(json));
  } catch {
    return [];
  }
}

export async function saveIdentifiers(values: Identifier[]): Promise<void> {
  const cleaned = normalize(values);
  writeSecure('identifiers', JSON.stringify(cleaned));
}
