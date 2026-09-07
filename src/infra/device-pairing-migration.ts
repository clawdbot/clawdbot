// One-time import of the retired devices/*.json pairing store into SQLite.
// Older gateways kept paired devices, pending requests, and bootstrap tokens
// in <state>/devices/{paired,pending,bootstrap}.json; the store now lives in
// the shared state DB (device_pairing_* / device_bootstrap_tokens tables).
// Runs at gateway startup before the node-surface fold, which writes onto the
// imported device records. Pending requests (5 min TTL) and bootstrap tokens
// (10 min TTL) are transients and are not imported; devices re-request and
// setup codes are reissued.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withPairedDeviceRecords, type PairedDevice } from "./device-pairing.js";
import {
  coercePairingStateRecord,
  readJsonIfExists,
  resolvePairingPaths,
} from "./pairing-files.js";

type LegacyDevicePairingMigrationResult = {
  imported: number;
  skippedExisting: number;
};

const SQLITE_TEXT_FIELDS = [
  "displayName",
  "operatorLabel",
  "platform",
  "deviceFamily",
  "clientId",
  "clientMode",
  "browserOrigin",
  "role",
  "remoteIp",
  "approvedVia",
  "lastSeenReason",
] as const satisfies readonly (keyof PairedDevice)[];

function normalizeLegacyPairedDevice(
  record: PairedDevice,
): { device: PairedDevice; omittedFields: number } | null {
  if (!isRecord(record)) {
    return null;
  }
  if (
    typeof record.publicKey !== "string" ||
    !record.publicKey.trim() ||
    !Number.isSafeInteger(record.createdAtMs) ||
    !Number.isSafeInteger(record.approvedAtMs)
  ) {
    return null;
  }

  const device = { ...record };
  let omittedFields = 0;
  if (device.lastSeenAtMs !== undefined && !Number.isSafeInteger(device.lastSeenAtMs)) {
    delete device.lastSeenAtMs;
    omittedFields += 1;
  }
  for (const field of SQLITE_TEXT_FIELDS) {
    if (device[field] !== undefined && typeof device[field] !== "string") {
      delete device[field];
      omittedFields += 1;
    }
  }
  return { device, omittedFields };
}

async function archiveLegacyFile(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, `${filePath}.migrated`);
  } catch {
    // Missing file or a racing second gateway process; nothing left to archive.
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(
    () => true,
    () => false,
  );
}

/** List legacy devices/*.json files the startup import has not archived yet. */
export async function listLegacyDevicePairingStoreFiles(baseDir?: string): Promise<string[]> {
  const { dir, pendingPath, pairedPath } = resolvePairingPaths(baseDir, "devices");
  const candidates = [pairedPath, pendingPath, path.join(dir, "bootstrap.json")];
  const present = await Promise.all(candidates.map(fileExists));
  return candidates.filter((_, index) => present[index]);
}

/**
 * Import legacy devices/paired.json records into the SQLite pairing store,
 * then archive the legacy files. Existing SQLite records win over legacy rows
 * for the same device id. Idempotent: after the first run the files carry a
 * `.migrated` suffix and the function returns null immediately. Throws on an
 * unreadable paired.json so a failed import leaves the files for a retry
 * instead of silently dropping approved pairings.
 */
export async function migrateLegacyDevicePairingStore(params?: {
  baseDir?: string;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<LegacyDevicePairingMigrationResult | null> {
  const { dir, pendingPath, pairedPath } = resolvePairingPaths(params?.baseDir, "devices");
  const bootstrapPath = path.join(dir, "bootstrap.json");
  const pairedRaw = await readJsonIfExists<unknown>(pairedPath);
  const hasTransientFiles = (await fileExists(pendingPath)) || (await fileExists(bootstrapPath));
  if (pairedRaw == null && !hasTransientFiles) {
    return null;
  }

  const legacyPaired = coercePairingStateRecord<PairedDevice>(pairedRaw);
  let imported = 0;
  let skippedExisting = 0;
  let skippedInvalid = 0;
  let omittedInvalidFields = 0;
  if (Object.keys(legacyPaired).length > 0) {
    await withPairedDeviceRecords(params?.baseDir, (pairedByDeviceId) => {
      for (const [rawDeviceId, record] of Object.entries(legacyPaired)) {
        const deviceId = rawDeviceId.trim();
        if (!deviceId) {
          skippedInvalid += 1;
          continue;
        }
        if (pairedByDeviceId[deviceId]) {
          skippedExisting += 1;
          continue;
        }
        const normalized = normalizeLegacyPairedDevice(record);
        if (!normalized) {
          skippedInvalid += 1;
          continue;
        }
        omittedInvalidFields += normalized.omittedFields;
        pairedByDeviceId[deviceId] = { ...normalized.device, deviceId };
        imported += 1;
      }
      return { value: undefined, persist: imported > 0 };
    });
  }

  if (skippedInvalid > 0) {
    params?.log?.warn(
      `device pairing store migration skipped ${skippedInvalid} invalid paired record(s)`,
    );
  }
  if (omittedInvalidFields > 0) {
    params?.log?.warn(
      `device pairing store migration omitted ${omittedInvalidFields} invalid optional field(s)`,
    );
  }

  await Promise.all([
    archiveLegacyFile(pairedPath),
    archiveLegacyFile(pendingPath),
    archiveLegacyFile(bootstrapPath),
  ]);
  const result = { imported, skippedExisting };
  params?.log?.info(
    `device pairing store migrated to SQLite: imported ${imported} paired device(s), kept ${skippedExisting} existing record(s)`,
  );
  return result;
}
