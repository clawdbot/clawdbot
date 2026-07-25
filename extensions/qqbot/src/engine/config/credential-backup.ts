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
 *   - Legacy JSON backups are imported by `openclaw doctor --fix`, not by
 *     runtime startup.
 *
 * Safety notes:
 *   - Only restore when credentials are **actually empty** — never
 *     overwrite a user's intentional config change.
 *   - Per-account key only; not keyed by appId because recovery happens
 *     precisely when appId is unknown.
 */

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

function credentialBackupKey(accountId: string): string {
  return buildQQBotStateKey("credential-backup", accountId);
}

function isUsableBackup(data: CredentialBackup | null | undefined): data is CredentialBackup {
  return Boolean(data?.accountId && data.appId && data.clientSecret);
}

/** Persist a credential snapshot (called once gateway reaches READY). */
export function saveCredentialBackup(accountId: string, appId: string, clientSecret: string): void {
  if (!appId || !clientSecret) {
    return;
  }
  try {
    const data: CredentialBackup = {
      accountId,
      appId,
      clientSecret,
      savedAt: new Date().toISOString(),
    };
    createCredentialBackupStore().register(credentialBackupKey(accountId), data);
  } catch {
    /* best-effort — ignore */
  }
}

/**
 * Load a credential snapshot for `accountId`.
 *
 * Reads SQLite only. Legacy JSON backup import is owned by doctor/setup
 * migration so runtime startup stays canonical-state-only.
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
  } catch {
    /* corrupt file — ignore */
  }
  return null;
}
