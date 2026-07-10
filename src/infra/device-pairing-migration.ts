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
import { withPairedDeviceRecords, type PairedDevice } from "./device-pairing.js";
import {
  coercePairingStateRecord,
  readJsonIfExists,
  resolvePairingPaths,
} from "./pairing-files.js";

export type LegacyDevicePairingMigrationResult = {
  imported: number;
  skippedExisting: number;
};

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
  if (Object.keys(legacyPaired).length > 0) {
    await withPairedDeviceRecords(params?.baseDir, (pairedByDeviceId) => {
      for (const [rawDeviceId, record] of Object.entries(legacyPaired)) {
        const deviceId = rawDeviceId.trim();
        if (!deviceId) {
          continue;
        }
        if (pairedByDeviceId[deviceId]) {
          skippedExisting += 1;
          continue;
        }
        pairedByDeviceId[deviceId] = { ...record, deviceId };
        imported += 1;
      }
      return { value: undefined, persist: imported > 0 };
    });
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
