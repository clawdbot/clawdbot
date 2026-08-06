// One-time migration of the retired standalone node pairing store.
// Older gateways kept approved node surfaces (and a per-node token) in
// <state>/nodes/{paired,pending}.json; the surface now lives on the paired
// device record. Runs at gateway startup: folds rows into device records,
// drops orphans that no longer map to a node-role device (they cannot pass
// the WS handshake anyway), and archives the legacy files so the migration
// never repeats. Pending rows are 5-minute transients and are not migrated;
// connecting nodes re-request their surface.
import fs from "node:fs/promises";
import { withPairedDeviceRecords, listApprovedPairedDeviceRoles } from "./device-pairing.js";
import {
  coercePairingStateRecord,
  readJsonIfExists,
  resolvePairingPaths,
} from "./pairing-files.js";

type LegacyNodePairingRow = {
  nodeId?: string;
  displayName?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  bins?: string[];
  createdAtMs?: number;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
};

type LegacyNodePairingMigrationResult = {
  migrated: number;
  orphaned: number;
};

async function archiveLegacyFile(path: string): Promise<void> {
  try {
    await fs.rename(path, `${path}.migrated`);
  } catch {
    // Missing file or a racing second gateway process; nothing left to archive.
  }
}

/**
 * Fold legacy nodes/paired.json rows into device-record node surfaces, then
 * archive the legacy files. Idempotent: after the first run the files carry a
 * `.migrated` suffix and the function returns null immediately.
 */
export async function migrateLegacyNodePairingStore(params?: {
  baseDir?: string;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<LegacyNodePairingMigrationResult | null> {
  const { pendingPath, pairedPath } = resolvePairingPaths(params?.baseDir, "nodes");
  const [pairedRaw, pendingRaw] = await Promise.all([
    readJsonIfExists<unknown>(pairedPath),
    readJsonIfExists<unknown>(pendingPath),
  ]);
  if (pairedRaw == null && pendingRaw == null) {
    return null;
  }

  const legacyRows = coercePairingStateRecord<LegacyNodePairingRow>(pairedRaw);
  let migrated = 0;
  let orphaned = 0;
  if (Object.keys(legacyRows).length > 0) {
    await withPairedDeviceRecords(params?.baseDir, (pairedByDeviceId) => {
      const now = Date.now();
      for (const [rawNodeId, row] of Object.entries(legacyRows)) {
        const device = pairedByDeviceId[rawNodeId.trim()];
        if (!device || !listApprovedPairedDeviceRoles(device).includes("node")) {
          orphaned += 1;
          continue;
        }
        if (device.nodeSurface) {
          continue;
        }
        device.nodeSurface = {
          displayName: row.displayName,
          version: row.version,
          coreVersion: row.coreVersion,
          uiVersion: row.uiVersion,
          modelIdentifier: row.modelIdentifier,
          caps: Array.isArray(row.caps) ? row.caps : undefined,
          commands: Array.isArray(row.commands) ? row.commands : undefined,
          permissions: row.permissions,
          bins: Array.isArray(row.bins) ? row.bins : undefined,
          createdAtMs: typeof row.createdAtMs === "number" ? row.createdAtMs : now,
          approvedAtMs: typeof row.approvedAtMs === "number" ? row.approvedAtMs : now,
          lastConnectedAtMs:
            typeof row.lastConnectedAtMs === "number" ? row.lastConnectedAtMs : undefined,
        };
        migrated += 1;
      }
      return { value: undefined, persist: migrated > 0 };
    });
  }

  await Promise.all([archiveLegacyFile(pairedPath), archiveLegacyFile(pendingPath)]);
  const result = { migrated, orphaned };
  params?.log?.info(
    `node pairing store migrated: folded ${migrated} node surface(s) into device records, dropped ${orphaned} orphan row(s)`,
  );
  return result;
}
