import fs from "node:fs/promises";
import path from "node:path";
import type {
  PluginDoctorStateMigration,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor";
import { fileExists } from "openclaw/plugin-sdk/security-runtime";
import { buildQQBotStateKey } from "./engine/utils/state-keys.js";

type CredentialBackup = {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
};

type CredentialBackupCandidate = {
  sourcePath: string;
  expectedSafeAccountId?: string;
};

type LegacyCredentialBackup = {
  sourcePath: string;
  key: string;
  value: CredentialBackup;
};

const CREDENTIAL_BACKUPS_NAMESPACE = "credential-backups";
const MAX_CREDENTIAL_BACKUPS = 1000;

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readCredentialBackup(filePath: string): Promise<CredentialBackup | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<CredentialBackup>;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.appId !== "string" ||
      typeof parsed.clientSecret !== "string" ||
      !parsed.accountId ||
      !parsed.appId ||
      !parsed.clientSecret
    ) {
      return null;
    }
    return {
      accountId: parsed.accountId,
      appId: parsed.appId,
      clientSecret: parsed.clientSecret,
      savedAt:
        typeof parsed.savedAt === "string" && parsed.savedAt
          ? parsed.savedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function credentialBackupKey(accountId: string): string {
  return buildQQBotStateKey("credential-backup", accountId);
}

async function credentialBackupCandidates(stateDir: string): Promise<CredentialBackupCandidate[]> {
  const dataDir = path.join(stateDir, "qqbot", "data");
  const accountFiles: CredentialBackupCandidate[] = [];
  try {
    for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith("credential-backup-") &&
        entry.name.endsWith(".json")
      ) {
        accountFiles.push({
          sourcePath: path.join(dataDir, entry.name),
          expectedSafeAccountId: entry.name.slice("credential-backup-".length, -".json".length),
        });
      }
    }
  } catch {
    // Missing legacy directory means there is nothing to import.
  }
  accountFiles.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  const singlePath = path.join(dataDir, "credential-backup.json");
  return fileExists(singlePath) ? [...accountFiles, { sourcePath: singlePath }] : accountFiles;
}

async function readLegacyCredentialBackups(stateDir: string): Promise<LegacyCredentialBackup[]> {
  const backups: LegacyCredentialBackup[] = [];
  for (const candidate of await credentialBackupCandidates(stateDir)) {
    const value = await readCredentialBackup(candidate.sourcePath);
    if (
      !value ||
      (candidate.expectedSafeAccountId !== undefined &&
        safeName(value.accountId) !== candidate.expectedSafeAccountId)
    ) {
      continue;
    }
    backups.push({
      sourcePath: candidate.sourcePath,
      key: credentialBackupKey(value.accountId),
      value,
    });
  }
  return backups;
}

async function archiveLegacySource(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.sourcePath}.migrated`;
  if (fileExists(archivedPath)) {
    params.warnings.push(
      `Left QQBot credential backup in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.chmod(params.sourcePath, 0o600);
  } catch (err) {
    params.warnings.push(`Failed securing QQBot credential backup legacy source: ${String(err)}`);
    return;
  }
  try {
    await fs.rename(params.sourcePath, archivedPath);
    try {
      await fs.chmod(archivedPath, 0o600);
    } catch (err) {
      params.warnings.push(
        `Failed securing archived QQBot credential backup legacy source: ${String(err)}`,
      );
    }
    params.changes.push(`Archived QQBot credential backup legacy source -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving QQBot credential backup: ${String(err)}`);
  }
}

function sameCredentialBackup(
  left: CredentialBackup | undefined,
  right: CredentialBackup,
): boolean {
  return (
    left?.accountId === right.accountId &&
    left.appId === right.appId &&
    left.clientSecret === right.clientSecret &&
    left.savedAt === right.savedAt
  );
}

async function rollbackCredentialImports(
  store: PluginStateKeyedStore<CredentialBackup>,
  inserted: ReadonlyMap<string, CredentialBackup>,
  existing: ReadonlyMap<string, CredentialBackup>,
): Promise<void> {
  // Doctor can overlap gateway writes. Remove only unchanged rows from this
  // attempt, then restore only snapshot rows that capacity eviction removed.
  for (const [key, value] of [...inserted].toReversed()) {
    if (sameCredentialBackup(await store.lookup(key), value)) {
      await store.delete(key);
    }
  }
  for (const [key, value] of existing) {
    if ((await store.lookup(key)) === undefined) {
      await store.registerIfAbsent(key, value);
    }
  }
}

function findMissingKey(expected: ReadonlySet<string>, actual: ReadonlySet<string>): string | null {
  for (const key of expected) {
    if (!actual.has(key)) {
      return key;
    }
  }
  return null;
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "qqbot-credential-backups-json-to-plugin-state",
    label: "QQBot credential backups",
    async detectLegacyState(params) {
      const backups = await readLegacyCredentialBackups(params.stateDir);
      if (backups.length === 0) {
        return null;
      }
      return {
        preview: [
          `- QQBot credential backups: ${backups.length} ${backups.length === 1 ? "file" : "files"} -> plugin state (${CREDENTIAL_BACKUPS_NAMESPACE})`,
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const backups = await readLegacyCredentialBackups(params.stateDir);
      if (backups.length === 0) {
        return { changes, warnings };
      }

      // Per-account files are ordered before the old singleton, so the newer
      // account-scoped snapshot wins if both exist for the same account.
      const selectedByKey = new Map<string, LegacyCredentialBackup>();
      for (const backup of backups) {
        if (!selectedByKey.has(backup.key)) {
          selectedByKey.set(backup.key, backup);
        }
      }

      const store = params.context.openPluginStateKeyedStore<CredentialBackup>({
        namespace: CREDENTIAL_BACKUPS_NAMESPACE,
        maxEntries: MAX_CREDENTIAL_BACKUPS,
      });
      const existingEntries = await store.entries();
      const existingValues = new Map(existingEntries.map((entry) => [entry.key, entry.value]));
      const existingKeys = new Set(existingValues.keys());
      const missing = [...selectedByKey.values()].filter((backup) => !existingKeys.has(backup.key));
      const available = MAX_CREDENTIAL_BACKUPS - existingKeys.size;
      if (missing.length > available) {
        warnings.push(
          `Skipped QQBot credential backup migration because plugin state has room for ${available} of ${missing.length} missing entries; left legacy sources in place`,
        );
        return { changes, warnings };
      }

      const expectedKeys = new Set(existingKeys);
      const inserted = new Map<string, CredentialBackup>();
      for (const backup of missing) {
        try {
          if (await store.registerIfAbsent(backup.key, backup.value)) {
            inserted.set(backup.key, backup.value);
          }
          const nextExpectedKeys = new Set(expectedKeys).add(backup.key);
          const liveKeys = new Set((await store.entries()).map((entry) => entry.key));
          const missingKey = findMissingKey(nextExpectedKeys, liveKeys);
          if (missingKey) {
            await rollbackCredentialImports(store, inserted, existingValues);
            warnings.push(
              `Stopped QQBot credential backup migration because plugin state capacity evicted ${missingKey}; restored credential state and left legacy sources in place`,
            );
            return { changes, warnings };
          }
          expectedKeys.add(backup.key);
        } catch (err) {
          try {
            await rollbackCredentialImports(store, inserted, existingValues);
          } catch (rollbackErr) {
            warnings.push(
              `Failed restoring QQBot credential state after migration error: ${String(rollbackErr)}`,
            );
          }
          warnings.push(
            `Failed migrating QQBot credential backup: ${String(err)}; left legacy sources in place`,
          );
          return { changes, warnings };
        }
      }
      if (inserted.size > 0) {
        changes.push(
          `Migrated ${inserted.size} QQBot credential ${inserted.size === 1 ? "backup" : "backups"} -> plugin state`,
        );
      }
      for (const backup of backups) {
        await archiveLegacySource({ sourcePath: backup.sourcePath, changes, warnings });
      }
      return { changes, warnings };
    },
  },
];
