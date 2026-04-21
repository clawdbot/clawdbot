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
import { getQQBotDataDir } from "../utils/platform.js";

/** Persisted record for a user who has interacted with the bot. */
export interface KnownUser {
  openid: string;
  type: ChatScope;
  nickname?: string;
  groupOpenid?: string;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
}

const KNOWN_USERS_DIR = getQQBotDataDir("data");
const KNOWN_USERS_FILE = path.join(KNOWN_USERS_DIR, "known-users.json");

let usersCache: Map<string, KnownUser> | null = null;
const SAVE_THROTTLE_MS = 5000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

function ensureDir(): void {
  if (!fs.existsSync(KNOWN_USERS_DIR)) {
    fs.mkdirSync(KNOWN_USERS_DIR, { recursive: true });
  }
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
    if (fs.existsSync(KNOWN_USERS_FILE)) {
      const data = fs.readFileSync(KNOWN_USERS_FILE, "utf-8");
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
      KNOWN_USERS_FILE,
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

/** Look up one known user. */
export function getKnownUser(
  accountId: string,
  openid: string,
  type: ChatScope = "c2c",
  groupOpenid?: string,
): KnownUser | undefined {
  return loadUsersFromFile().get(makeUserKey({ accountId, openid, type, groupOpenid }));
}

/** List known users with optional filtering and sorting. */
export function listKnownUsers(options?: {
  accountId?: string;
  type?: ChatScope;
  activeWithin?: number;
  limit?: number;
  sortBy?: "lastSeenAt" | "firstSeenAt" | "interactionCount";
  sortOrder?: "asc" | "desc";
}): KnownUser[] {
  let users = Array.from(loadUsersFromFile().values());
  if (options?.accountId) {
    users = users.filter((u) => u.accountId === options.accountId);
  }
  if (options?.type) {
    users = users.filter((u) => u.type === options.type);
  }
  if (options?.activeWithin) {
    const cutoff = Date.now() - options.activeWithin;
    users = users.filter((u) => u.lastSeenAt >= cutoff);
  }
  const sortBy = options?.sortBy ?? "lastSeenAt";
  const sortOrder = options?.sortOrder ?? "desc";
  users.sort((a, b) => {
    const aV = a[sortBy] ?? 0;
    const bV = b[sortBy] ?? 0;
    return sortOrder === "asc" ? aV - bV : bV - aV;
  });
  if (options?.limit && options.limit > 0) {
    users = users.slice(0, options.limit);
  }
  return users;
}

/** Return summary stats for known users. */
export function getKnownUsersStats(accountId?: string): {
  totalUsers: number;
  c2cUsers: number;
  groupUsers: number;
  activeIn24h: number;
  activeIn7d: number;
} {
  const users = listKnownUsers({ accountId });
  const now = Date.now();
  const day = 86400000;
  return {
    totalUsers: users.length,
    c2cUsers: users.filter((u) => u.type === "c2c").length,
    groupUsers: users.filter((u) => u.type === "group").length,
    activeIn24h: users.filter((u) => now - u.lastSeenAt < day).length,
    activeIn7d: users.filter((u) => now - u.lastSeenAt < 7 * day).length,
  };
}

/** Remove one user record. */
export function removeKnownUser(
  accountId: string,
  openid: string,
  type: ChatScope = "c2c",
  groupOpenid?: string,
): boolean {
  const cache = loadUsersFromFile();
  const key = makeUserKey({ accountId, openid, type, groupOpenid });
  if (cache.has(key)) {
    cache.delete(key);
    isDirty = true;
    saveUsersToFile();
    debugLog(`[known-users] Removed user ${openid}`);
    return true;
  }
  return false;
}

/** Clear all user records, optionally scoped to one account. */
export function clearKnownUsers(accountId?: string): number {
  const cache = loadUsersFromFile();
  let count = 0;
  if (accountId) {
    for (const [key, user] of cache.entries()) {
      if (user.accountId === accountId) {
        cache.delete(key);
        count++;
      }
    }
  } else {
    count = cache.size;
    cache.clear();
  }
  if (count > 0) {
    isDirty = true;
    doSaveUsersToFile();
    debugLog(`[known-users] Cleared ${count} users`);
  }
  return count;
}

/** Return all groups in which a user has interacted. */
export function getUserGroups(accountId: string, openid: string): string[] {
  return listKnownUsers({ accountId, type: "group" })
    .filter((u) => u.openid === openid && u.groupOpenid)
    .map((u) => u.groupOpenid!);
}

/** Return all recorded members for one group. */
export function getGroupMembers(accountId: string, groupOpenid: string): KnownUser[] {
  return listKnownUsers({ accountId, type: "group" }).filter((u) => u.groupOpenid === groupOpenid);
}
