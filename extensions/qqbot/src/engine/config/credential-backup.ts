/**
 * Credential backup & recovery.
 * 凭证暂存与恢复。
 *
 * Solves the "hot-upgrade interrupted, appId/secret vanished from
 * openclaw.json" failure mode.
 *
 * Mechanics:
 *   - After each successful gateway start we snapshot the currently
 *     resolved `appId` / `clientSecret` to a per-account SQLite KV entry.
 *   - During plugin startup, if the live config has an empty appId or
 *     secret, the gateway consults the backup and restores the values
 *     via the config mutation API.
 *   - Legacy JSON backups are imported on first read, then removed after
 *     SQLite has the canonical copy.
 *
 * Safety notes:
 *   - Only restore when credentials are **actually empty** — never
 *     overwrite a user's intentional config change.
 *   - Per-account key only; not keyed by appId because recovery happens
 *     precisely when appId is unknown.
 */

import fs from "node:fs";
import path from "node:path";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import { getCredentialBackupFile, getLegacyCredentialBackupFile } from "../utils/data-paths.js";
import { getQQBotDataPath } from "../utils/platform.js";
import { buildQQBotStateKey, openQQBotSyncKeyedStore } from "../utils/sqlite-state.js";

interface CredentialBackup {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
}

const CREDENTIAL_BACKUPS_NAMESPACE = "credential-backups";
const MAX_CREDENTIAL_BACKUPS = 1000;

function createCredentialBackupStore() {
  return openQQBotSyncKeyedStore<CredentialBackup>({
    namespace: CREDENTIAL_BACKUPS_NAMESPACE,
    maxEntries: MAX_CREDENTIAL_BACKUPS,
  });
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getLegacyOsHomeCredentialBackupFile(accountId: string): string {
  return path.join(getQQBotDataPath("data"), `credential-backup-${safeName(accountId)}.json`);
}

function getLegacyOsHomeCredentialBackupFileWithoutAccount(): string {
  return path.join(getQQBotDataPath("data"), "credential-backup.json");
}

function credentialBackupKey(accountId: string): string {
  return buildQQBotStateKey("credential-backup", accountId);
}

function isUsableBackup(data: CredentialBackup | null | undefined): data is CredentialBackup {
  return Boolean(data?.accountId && data.appId && data.clientSecret);
}

function loadUsableBackupFromFile(filePath: string): CredentialBackup | null {
  const data = loadJsonFile<CredentialBackup>(filePath);
  return isUsableBackup(data) ? data : null;
}

function removeFileQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore cleanup errors */
  }
}

function findLegacyBackup(accountId?: string): { data: CredentialBackup; filePath: string } | null {
  const candidates = accountId
    ? [
        getCredentialBackupFile(accountId),
        getLegacyCredentialBackupFile(),
        getLegacyOsHomeCredentialBackupFile(accountId),
        getLegacyOsHomeCredentialBackupFileWithoutAccount(),
      ]
    : [getLegacyCredentialBackupFile(), getLegacyOsHomeCredentialBackupFileWithoutAccount()];

  for (const filePath of candidates) {
    const data = loadUsableBackupFromFile(filePath);
    if (!data) {
      continue;
    }
    if (accountId && data.accountId !== accountId) {
      continue;
    }
    return { data, filePath };
  }
  return null;
}

/** Persist a credential snapshot (called once gateway reaches READY). */
export function saveCredentialBackup(accountId: string, appId: string, clientSecret: string): void {
  if (!appId || !clientSecret) {
    return;
  }
  try {
    const backupPath = getCredentialBackupFile(accountId);
    const data: CredentialBackup = {
      accountId,
      appId,
      clientSecret,
      savedAt: new Date().toISOString(),
    };
    createCredentialBackupStore().register(credentialBackupKey(accountId), data);
    removeFileQuietly(backupPath);
  } catch {
    /* best-effort — ignore */
  }
}

/**
 * Load a credential snapshot for `accountId`.
 *
 * Consults SQLite first; falls back to shipped JSON backups and imports
 * them when the embedded `accountId` matches the request.
 */
export function loadCredentialBackup(accountId?: string): CredentialBackup | null {
  try {
    if (accountId) {
      const store = createCredentialBackupStore();
      const data = store.lookup(credentialBackupKey(accountId));
      if (isUsableBackup(data)) {
        return data;
      }
    }

    const legacy = findLegacyBackup(accountId);
    if (legacy) {
      createCredentialBackupStore().register(
        credentialBackupKey(legacy.data.accountId),
        legacy.data,
      );
      removeFileQuietly(legacy.filePath);
      return legacy.data;
    }
  } catch {
    /* corrupt file — ignore */
  }
  return null;
}
