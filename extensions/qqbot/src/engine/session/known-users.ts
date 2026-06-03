/**
 * Known user tracking — SQLite KV-backed store.
 *
 * Legacy `known-users.json` data is imported once, then deleted after SQLite
 * has the canonical copy.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { privateFileStoreSync } from "openclaw/plugin-sdk/security-runtime";
import type { ChatScope } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import { getQQBotDataPath } from "../utils/platform.js";
import { openQQBotSyncKeyedStore } from "../utils/sqlite-state.js";

/** Persisted record for a user who has interacted with the bot. */
interface KnownUser {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
}

type KnownUsersMigrationMarker = {
  importedAt: string;
};

function getKnownUsersFile(): string {
  return path.join(getQQBotDataPath("data"), "known-users.json");
}

function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  return user.type === "group" && user.groupOpenid ? `${base}:${user.groupOpenid}` : base;
}

const KNOWN_USERS_NAMESPACE = "known-users";
const KNOWN_USERS_MIGRATIONS_NAMESPACE = "known-users-migrations";
const LEGACY_KNOWN_USERS_MIGRATION_KEY = "known-users-json-v1";
const MAX_KNOWN_USERS = 100_000;
let legacyImported = false;

function createKnownUsersStore() {
  return openQQBotSyncKeyedStore<KnownUser>({
    namespace: KNOWN_USERS_NAMESPACE,
    maxEntries: MAX_KNOWN_USERS,
  });
}

function createKnownUsersMigrationStore() {
  return openQQBotSyncKeyedStore<KnownUsersMigrationMarker>({
    namespace: KNOWN_USERS_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
  });
}

function knownUserStateKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function toStoredKnownUser(user: KnownUser): KnownUser {
  return {
    openid: user.openid,
    type: user.type,
    ...(user.nickname ? { nickname: user.nickname } : {}),
    ...(user.groupOpenid ? { groupOpenid: user.groupOpenid } : {}),
    accountId: user.accountId,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
    interactionCount: user.interactionCount,
  };
}

function ensureLegacyKnownUsersImported(): void {
  if (legacyImported) {
    return;
  }
  const migrationStore = createKnownUsersMigrationStore();
  if (migrationStore.lookup(LEGACY_KNOWN_USERS_MIGRATION_KEY)) {
    legacyImported = true;
    return;
  }
  try {
    const knownUsersFile = getKnownUsersFile();
    const users = privateFileStoreSync(path.dirname(knownUsersFile)).readJsonIfExists<KnownUser[]>(
      path.basename(knownUsersFile),
    );
    if (Array.isArray(users)) {
      const store = createKnownUsersStore();
      for (const user of users) {
        store.registerIfAbsent(knownUserStateKey(makeUserKey(user)), toStoredKnownUser(user));
      }
      debugLog(`[known-users] Migrated ${users.length} users to SQLite`);
      fs.rmSync(knownUsersFile, { force: true });
    }
    migrationStore.register(LEGACY_KNOWN_USERS_MIGRATION_KEY, {
      importedAt: new Date().toISOString(),
    });
    legacyImported = true;
  } catch (err) {
    debugError(`[known-users] Failed to import legacy users: ${formatErrorMessage(err)}`);
  }
}

/** Flush pending writes immediately, typically during shutdown. */
export function flushKnownUsers(): void {
  // SQLite writes are synchronous; no pending JSON flush remains.
}

/** Record a known user whenever a message is received. */
export function recordKnownUser(user: {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
}): void {
  try {
    ensureLegacyKnownUsersImported();
    const store = createKnownUsersStore();
    const key = makeUserKey(user);
    const stateKey = knownUserStateKey(key);
    const now = Date.now();
    const existing = store.lookup(stateKey);

    if (existing) {
      const next: KnownUser = {
        ...existing,
        lastSeenAt: now,
        interactionCount: existing.interactionCount + 1,
      };
      if (user.nickname && user.nickname !== existing.nickname) {
        next.nickname = user.nickname;
      }
      store.register(stateKey, toStoredKnownUser(next));
    } else {
      store.register(
        stateKey,
        toStoredKnownUser({
          openid: user.openid,
          type: user.type,
          nickname: user.nickname,
          groupOpenid: user.groupOpenid,
          accountId: user.accountId,
          firstSeenAt: now,
          lastSeenAt: now,
          interactionCount: 1,
        }),
      );
      debugLog(`[known-users] New user: ${user.openid} (${user.type})`);
    }
  } catch (err) {
    debugError(`[known-users] Failed to record user: ${formatErrorMessage(err)}`);
  }
}
