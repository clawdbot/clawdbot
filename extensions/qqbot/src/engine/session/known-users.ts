/**
 * Known user tracking — SQLite KV-backed store.
 */

import crypto from "node:crypto";
import type { ChatScope } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
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

function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  return user.type === "group" && user.groupOpenid ? `${base}:${user.groupOpenid}` : base;
}

const KNOWN_USERS_NAMESPACE = "known-users";
const MAX_KNOWN_USERS = 100_000;

function createKnownUsersStore() {
  return openQQBotSyncKeyedStore<KnownUser>({
    namespace: KNOWN_USERS_NAMESPACE,
    maxEntries: MAX_KNOWN_USERS,
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
