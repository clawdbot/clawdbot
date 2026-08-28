// Stores the fingerprinted config snapshot used by the config change journal.
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import path from "node:path";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { resolveStateDir } from "./paths.js";

const CONFIG_SNAPSHOT_SCOPE = "config-snapshot";
const CONFIG_SNAPSHOT_KEY = "latest";
const CONFIG_JOURNAL_FINGERPRINT_KEY_FILENAME = "config-journal-fingerprint.key";
const CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES = 32;
const CONFIG_JOURNAL_REDACTION_MARKER = "***";

type ConfigSnapshotAuditRecord = {
  configPath: string;
  rawHash: string;
  fingerprintedAuthoredConfig: unknown;
};

type ConfigAuditStoreContext = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

type ResolvedConfigAuditStoreContext = {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
};

const configJournalFingerprintKeys = new Map<string, Buffer>();

function loadConfigJournalFingerprintKey(params?: ConfigAuditStoreContext): Buffer | null {
  const context = resolveConfigAuditStoreContext(params);
  const stateDir = resolveStateDir(context.env, context.homedir);
  const keyPath = path.join(stateDir, CONFIG_JOURNAL_FINGERPRINT_KEY_FILENAME);
  const cached = configJournalFingerprintKeys.get(keyPath);
  if (cached) {
    return cached;
  }
  try {
    let key: Buffer;
    try {
      key = fs.readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const created = randomBytes(CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES);
      try {
        const descriptor = fs.openSync(keyPath, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, created);
        } finally {
          fs.closeSync(descriptor);
        }
        key = created;
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw createError;
        }
        key = fs.readFileSync(keyPath);
      }
    }
    if (key.length !== CONFIG_JOURNAL_FINGERPRINT_KEY_BYTES) {
      return null;
    }
    fs.chmodSync(keyPath, 0o600);
    configJournalFingerprintKeys.set(keyPath, key);
    return key;
  } catch {
    return null;
  }
}

function fingerprintConfigSnapshotValue(value: unknown, key: Buffer | null): string {
  if (!key) {
    // Degrade to redaction when persistent key storage is unavailable; writes must still succeed.
    return CONFIG_JOURNAL_REDACTION_MARKER;
  }
  // JSON-encode every primitive (strings included) so "1" and 1 fingerprint
  // differently; a type-only edit must not read as an opaque change.
  const serialized = JSON.stringify(value);
  return `fp:${createHmac("sha256", key)
    .update(serialized ?? String(value))
    .digest("hex")
    .slice(0, 12)}`;
}

function fingerprintConfigSnapshotLeaves(value: unknown, key: Buffer | null): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => fingerprintConfigSnapshotLeaves(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([fieldKey, entry]) => [
        fieldKey,
        fingerprintConfigSnapshotLeaves(entry, key),
      ]),
    );
  }
  return fingerprintConfigSnapshotValue(value, key);
}

export function fingerprintConfigSnapshotAuthoredConfig(
  value: unknown,
  params?: ConfigAuditStoreContext,
): unknown {
  const key = loadConfigJournalFingerprintKey(params);
  // This slot is a diff baseline, not a data store; fingerprint every leaf.
  return fingerprintConfigSnapshotLeaves(structuredClone(value), key);
}

function openConfigSnapshotStore(env: NodeJS.ProcessEnv) {
  return createSqliteAuditRecordStore<ConfigSnapshotAuditRecord>({
    scope: CONFIG_SNAPSHOT_SCOPE,
    maxEntries: 1,
    env,
  });
}

function resolveConfigAuditStoreContext(
  params?: ConfigAuditStoreContext,
): ResolvedConfigAuditStoreContext {
  return {
    env: params?.env ?? process.env,
    homedir: params?.homedir ?? defaultHomedir,
  };
}

export function resolveConfigAuditStoreEnv(
  params: ResolvedConfigAuditStoreContext,
): NodeJS.ProcessEnv {
  return {
    ...params.env,
    OPENCLAW_STATE_DIR: resolveStateDir(params.env, params.homedir),
  };
}

export function readConfigSnapshotAuditRecord(
  params: ConfigAuditStoreContext & { configPath: string },
): ConfigSnapshotAuditRecord | null {
  try {
    const context = resolveConfigAuditStoreContext(params);
    const entry = openConfigSnapshotStore(resolveConfigAuditStoreEnv(context))
      .entries()
      .find((candidate) => candidate.key === CONFIG_SNAPSHOT_KEY);
    const snapshot = entry?.value;
    return snapshot?.configPath === path.resolve(params.configPath) ? snapshot : null;
  } catch {
    return null;
  }
}

/** Single owner of the slot's path-identity convention (resolve-normalized). */
export function configSnapshotAuditRecordMatchesPath(
  snapshot: ConfigSnapshotAuditRecord | null,
  configPath: string,
): snapshot is ConfigSnapshotAuditRecord {
  return snapshot?.configPath === path.resolve(configPath);
}

export function readLatestConfigSnapshotAuditRecord(
  params?: ConfigAuditStoreContext,
): ConfigSnapshotAuditRecord | null {
  try {
    const context = resolveConfigAuditStoreContext(params);
    return (
      openConfigSnapshotStore(resolveConfigAuditStoreEnv(context))
        .entries()
        .find((candidate) => candidate.key === CONFIG_SNAPSHOT_KEY)?.value ?? null
    );
  } catch {
    return null;
  }
}

export function upsertConfigSnapshotAuditRecord(
  params: ConfigAuditStoreContext & {
    configPath: string;
    rawHash: string;
    authoredConfig: unknown;
    expectedSnapshot?: ConfigSnapshotAuditRecord | null;
  },
): ConfigSnapshotAuditRecord | null {
  try {
    const context = resolveConfigAuditStoreContext(params);
    const snapshot: ConfigSnapshotAuditRecord = {
      configPath: path.resolve(params.configPath),
      rawHash: params.rawHash,
      fingerprintedAuthoredConfig: fingerprintConfigSnapshotAuthoredConfig(
        params.authoredConfig,
        context,
      ),
    };
    // One bounded slot intentionally follows the latest config path in this state DB.
    // Keyed fingerprints reveal only per-install secret equality, not secret values.
    // Known limit: slot reads, record appends, and this upsert are separate steps,
    // so near-simultaneous writers/watchers across processes can journal duplicate
    // or misordered external records (hashes cited are always real). The follow-up
    // journal primitive (#110896 phase 2b) folds classification into one txn.
    const store = openConfigSnapshotStore(resolveConfigAuditStoreEnv(context));
    if (params.expectedSnapshot !== undefined) {
      return store.compareAndSet(CONFIG_SNAPSHOT_KEY, params.expectedSnapshot, snapshot)
        ? snapshot
        : null;
    }
    store.upsert(CONFIG_SNAPSHOT_KEY, snapshot);
    return snapshot;
  } catch {
    // best-effort
    return null;
  }
}

export function restoreConfigSnapshotAuditRecord(
  params: ConfigAuditStoreContext & {
    snapshot: ConfigSnapshotAuditRecord | null;
    expectedSnapshot?: ConfigSnapshotAuditRecord | null;
  },
): void {
  try {
    const context = resolveConfigAuditStoreContext(params);
    const store = openConfigSnapshotStore(resolveConfigAuditStoreEnv(context));
    if (params.expectedSnapshot !== undefined) {
      store.compareAndSet(CONFIG_SNAPSHOT_KEY, params.expectedSnapshot, params.snapshot);
      return;
    }
    if (params.snapshot) {
      store.upsert(CONFIG_SNAPSHOT_KEY, params.snapshot);
    } else {
      store.delete(CONFIG_SNAPSHOT_KEY);
    }
  } catch {
    // best-effort
  }
}
