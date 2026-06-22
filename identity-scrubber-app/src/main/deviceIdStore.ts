import { computeDeviceId, getMachineId } from './deviceId';
import { KeychainUnavailableError, readSecure, writeSecure } from './secureStore';

// Persistence for the device-id (encrypted raw bytes at models/device-id.enc).
// Kept separate from deviceId.ts, which stays Electron-free (pure crypto), and
// from the callers, so the validation + storage name live in one place.
const DEVICE_ID = 'device-id';

function isValidDeviceId(v: string | null): v is string {
  return !!v && /^[0-9a-f]{64}$/.test(v.trim().toLowerCase());
}

// Read the persisted device-id. The persisted file is the source of truth, so
// it survives a machine_id change (e.g. Windows hardware/OS change) — we only
// recompute when there is genuinely nothing saved.
//
// - Valid file present  -> use it.
// - File present but unreadable (Keychain denied) -> propagate
//   KeychainUnavailableError. We must NOT recompute here: if the machine_id has
//   changed, the recomputed id would differ from what the backend has on file,
//   so we'd silently report a wrong identity. Billing turns this into
//   secure_storage_unavailable (see guardKeychain) and blocks instead.
// - File absent (fresh / deleted) -> recompute the deterministic value but do
//   NOT persist, so deleting device-id.enc still forces a model re-download
//   (the anti-abuse gate; see gliner.isGlinerCached).
//
// Never writes — auto-creating the file here would defeat that gate.
export function readDeviceId(): string {
  const v = readSecure(DEVICE_ID);
  if (isValidDeviceId(v)) return v.trim().toLowerCase();
  return computeDeviceId(getMachineId());
}

// Create the encrypted device-id if absent/invalid. Called once during model
// download (its presence is what gates re-download). Best-effort: a denied
// Keychain just means readDeviceId() keeps recomputing the deterministic value
// until secure storage works again.
export function ensureDeviceId(): void {
  try {
    if (isValidDeviceId(readSecure(DEVICE_ID))) return;
    writeSecure(DEVICE_ID, computeDeviceId(getMachineId()));
  } catch (err) {
    if (!(err instanceof KeychainUnavailableError)) throw err;
  }
}
