/**
 * Known user tracking — JSON file-based store.
 *
 * Migrated from src/known-users.ts. Dependencies are only Node.js
 * built-ins + log + platform (both zero plugin-sdk).
 */

import fs from "node:fs";
import path from "node:path";
import type { ChatScope } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import { getQQBotDataDir, getQQBotDataPath } from "../utils/platform.js";

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

let usersCache: Map<string, KnownUser> | null = null;
const SAVE_THROTTLE_MS = 5000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

function ensureDir(): void {
  getQQBotDataDir("data");
}

function getKnownUsersFile(): string {
  return path.join(getQQBotDataPath("data"), "known-users.json");
}

function makeUserKey(user: Partial<KnownUser>): string {
  const base = `${user.accountId}:${user.type}:${user.openid}`;
  return user.type === "group" && user.groupOpenid ? `${base}:${user.groupOpenid}` : base;
}

function loadUsersFromFile(): Map<string, KnownUser> {
  if (usersCache !== null) {
    return usersCache;
  }
  usersCache = new Map();
  try {
    const knownUsersFile = getKnownUsersFile();
    if (fs.existsSync(knownUsersFile)) {
      const data = fs.readFileSync(knownUsersFile, "utf-8");
      const users = JSON.parse(data) as KnownUser[];
      for (const user of users) {
        usersCache.set(makeUserKey(user), user);
      }
      debugLog(`[known-users] Loaded ${usersCache.size} users`);
    }
  } catch (err) {
    debugError(`[known-users] Failed to load users: ${formatErrorMessage(err)}`);
    usersCache = new Map();
  }
  return usersCache;
}

function saveUsersToFile(): void {
  if (!isDirty || saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSaveUsersToFile();
  }, SAVE_THROTTLE_MS);
}

function doSaveUsersToFile(): void {
  if (!usersCache || !isDirty) {
    return;
  }
  try {
    ensureDir();
    fs.writeFileSync(
      getKnownUsersFile(),
      JSON.stringify(Array.from(usersCache.values()), null, 2),
      "utf-8",
    );
    isDirty = false;
  } catch (err) {
    debugError(`[known-users] Failed to save users: ${formatErrorMessage(err)}`);
  }
}

/** Flush pending writes immediately, typically during shutdown. */
export function flushKnownUsers(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  doSaveUsersToFile();
}

/** Record a known user whenever a message is received. */
export function recordKnownUser(user: {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
}): void {
  const cache = loadUsersFromFile();
  const key = makeUserKey(user);
  const now = Date.now();
  const existing = cache.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.interactionCount++;
    if (user.nickname && user.nickname !== existing.nickname) {
      existing.nickname = user.nickname;
    }
  } else {
    cache.set(key, {
      openid: user.openid,
      type: user.type,
      nickname: user.nickname,
      groupOpenid: user.groupOpenid,
      accountId: user.accountId,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    });
    debugLog(`[known-users] New user: ${user.openid} (${user.type})`);
  }
  isDirty = true;
  saveUsersToFile();
}
