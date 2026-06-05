// Imessage plugin module implements state migrations behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import {
  IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_KEY,
  IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
  IMESSAGE_REPLY_CACHE_NAMESPACE,
  resolveIMessageReplyCacheEntryKey,
} from "./monitor-reply-cache.js";
import {
  capFailureRetriesMap,
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  resolveIMessageCatchupCursorKey,
  type IMessageCatchupCursor,
} from "./monitor/catchup.js";
import {
  IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  IMESSAGE_SENT_ECHOES_NAMESPACE,
  IMESSAGE_SENT_ECHOES_TTL_MS,
  resolveIMessageSentEchoEntryKey,
} from "./monitor/persisted-echo-cache.js";

type ReplyCacheEntry = {
  accountId: string;
  messageId: string;
  shortId: string;
  timestamp: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  isFromMe?: boolean;
};

type SentEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
};

const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function fileExists(pathValue: string): boolean {
  try {
    return !statRegularFileSync(pathValue).missing;
  } catch {
    return false;
  }
}

function resolveMigrationStateDir(params: { env: NodeJS.ProcessEnv; stateDir?: string }): string {
  return params.stateDir ?? resolveStateDir(params.env);
}

function remainingTtlMs(timestamp: number, ttlMs: number): number | undefined {
  const remaining = ttlMs - Math.max(0, Date.now() - timestamp);
  return remaining > 0 ? remaining : undefined;
}

function readJsonl(pathValue: string): unknown[] {
  try {
    return fs
      .readFileSync(pathValue, "utf8")
      .split(/\n+/)
      .flatMap((line) => {
        if (!line) {
          return [];
        }
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  } catch (err) {
    throw new Error(`Failed reading ${pathValue}: ${String(err)}`, { cause: err });
  }
}

function parseReplyCacheEntry(raw: unknown): ReplyCacheEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsed = raw as Partial<ReplyCacheEntry>;
  if (
    typeof parsed.accountId !== "string" ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.shortId !== "string" ||
    typeof parsed.timestamp !== "number"
  ) {
    return null;
  }
  return {
    accountId: parsed.accountId,
    messageId: parsed.messageId,
    shortId: parsed.shortId,
    timestamp: parsed.timestamp,
    ...(typeof parsed.chatGuid === "string" ? { chatGuid: parsed.chatGuid } : {}),
    ...(typeof parsed.chatIdentifier === "string" ? { chatIdentifier: parsed.chatIdentifier } : {}),
    ...(typeof parsed.chatId === "number" ? { chatId: parsed.chatId } : {}),
    ...(typeof parsed.isFromMe === "boolean" ? { isFromMe: parsed.isFromMe } : {}),
  };
}

function readReplyCacheMaxShortId(sourcePath: string): number {
  let max = 0;
  for (const raw of readJsonl(sourcePath)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const shortId = (raw as { shortId?: unknown }).shortId;
    if (typeof shortId !== "string") {
      continue;
    }
    const numeric = Number.parseInt(shortId, 10);
    if (Number.isFinite(numeric) && numeric > max) {
      max = numeric;
    }
  }
  return max;
}

function readReplyCounterValue(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const counter = (value as { counter?: unknown }).counter;
  return typeof counter === "number" && Number.isFinite(counter) ? counter : null;
}

function shouldReplaceReplyCounter(existingValue: unknown, incomingValue: unknown): boolean {
  const incomingCounter = readReplyCounterValue(incomingValue);
  if (incomingCounter === null) {
    return false;
  }
  const existingCounter = readReplyCounterValue(existingValue);
  return existingCounter === null || incomingCounter > existingCounter;
}

function parseSentEchoEntry(raw: unknown): SentEchoEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsed = raw as Partial<SentEchoEntry>;
  if (typeof parsed.scope !== "string" || typeof parsed.timestamp !== "number") {
    return null;
  }
  return {
    scope: parsed.scope,
    timestamp: parsed.timestamp,
    ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
    ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
  };
}

function listReplyCacheEntries(sourcePath: string): Array<{
  key: string;
  value: ReplyCacheEntry;
  ttlMs?: number;
}> {
  const entriesByKey = new Map<string, { value: ReplyCacheEntry; ttlMs: number }>();
  for (const entry of readJsonl(sourcePath).map(parseReplyCacheEntry)) {
    if (!entry) {
      continue;
    }
    const ttlMs = remainingTtlMs(entry.timestamp, REPLY_CACHE_TTL_MS);
    if (!ttlMs) {
      continue;
    }
    const key = resolveIMessageReplyCacheEntryKey(entry.messageId);
    entriesByKey.delete(key);
    entriesByKey.set(key, { value: entry, ttlMs });
  }
  return [...entriesByKey.entries()]
    .slice(-IMESSAGE_REPLY_CACHE_MAX_ENTRIES)
    .map(([key, entry]) => ({ key, value: entry.value, ttlMs: entry.ttlMs }));
}

function listSentEchoEntries(sourcePath: string): Array<{
  key: string;
  value: SentEchoEntry;
  ttlMs?: number;
}> {
  return readJsonl(sourcePath)
    .map(parseSentEchoEntry)
    .filter((entry): entry is SentEchoEntry => Boolean(entry))
    .slice(-IMESSAGE_SENT_ECHOES_MAX_ENTRIES)
    .flatMap((entry) => {
      const ttlMs = remainingTtlMs(entry.timestamp, IMESSAGE_SENT_ECHOES_TTL_MS);
      if (!ttlMs) {
        return [];
      }
      return [{ key: resolveIMessageSentEchoEntryKey(entry), value: entry, ttlMs }];
    });
}

function resolveLegacyCatchupCursorPath(stateDir: string, accountId: string): string {
  const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
  return path.join(stateDir, "imessage", "catchup", `${safePrefix}__${hash}.json`);
}

function listLegacyCatchupCursorPaths(stateDir: string): string[] {
  const dir = path.join(stateDir, "imessage", "catchup");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function normalizeCatchupCursor(raw: unknown): IMessageCatchupCursor | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<IMessageCatchupCursor>;
  if (
    typeof value.lastSeenMs !== "number" ||
    !Number.isFinite(value.lastSeenMs) ||
    typeof value.lastSeenRowid !== "number" ||
    !Number.isFinite(value.lastSeenRowid)
  ) {
    return null;
  }
  const failureRetries = sanitizeCatchupFailureRetries(value.failureRetries);
  const hasRetries = Object.keys(failureRetries).length > 0;
  return {
    lastSeenMs: value.lastSeenMs,
    lastSeenRowid: value.lastSeenRowid,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(hasRetries ? { failureRetries } : {}),
  };
}

function readCatchupCursor(sourcePath: string): IMessageCatchupCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Failed reading ${sourcePath}: ${String(err)}`, { cause: err });
  }
  const cursor = normalizeCatchupCursor(parsed);
  if (!cursor) {
    throw new Error(`Invalid iMessage catchup cursor: ${sourcePath}`);
  }
  return cursor;
}

function sanitizeCatchupFailureRetries(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [guid, count] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      out[guid] = Math.floor(count);
    }
  }
  return capFailureRetriesMap(out);
}

function shouldReplaceCatchupCursor(existingValue: unknown, incomingValue: unknown): boolean {
  const incoming = normalizeCatchupCursor(incomingValue);
  if (!incoming) {
    return false;
  }
  const existing = normalizeCatchupCursor(existingValue);
  return (
    !existing ||
    incoming.lastSeenRowid > existing.lastSeenRowid ||
    (incoming.lastSeenRowid === existing.lastSeenRowid && incoming.lastSeenMs > existing.lastSeenMs)
  );
}

function detectReplyCacheMigration(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  const sourcePath = path.join(stateDir, "imessage", "reply-cache.jsonl");
  if (!fileExists(sourcePath)) {
    return [];
  }
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  plans.push({
    kind: "plugin-state-import",
    label: "iMessage reply short-id counter",
    sourcePath,
    targetPath: `plugin state:${IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE}`,
    pluginId: "imessage",
    namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
    scopeKey: "",
    stateDir,
    preview: `- iMessage reply short-id counter: ${sourcePath} → plugin state (${IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE})`,
    readEntries: () => {
      const maxShortId = readReplyCacheMaxShortId(sourcePath);
      return maxShortId > 0
        ? [{ key: IMESSAGE_REPLY_CACHE_COUNTER_KEY, value: { counter: maxShortId } }]
        : [];
    },
    shouldReplaceExistingEntry: ({ existingValue, incomingValue }) =>
      shouldReplaceReplyCounter(existingValue, incomingValue),
  });
  plans.push({
    kind: "plugin-state-import",
    label: "iMessage reply short-id cache",
    sourcePath,
    targetPath: `plugin state:${IMESSAGE_REPLY_CACHE_NAMESPACE}`,
    pluginId: "imessage",
    namespace: IMESSAGE_REPLY_CACHE_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
    scopeKey: "",
    stateDir,
    cleanupSource: "rename",
    cleanupWhenEmpty: true,
    preview: `- iMessage reply short-id cache: ${sourcePath} → plugin state (${IMESSAGE_REPLY_CACHE_NAMESPACE})`,
    readEntries: () => listReplyCacheEntries(sourcePath),
  });
  return plans;
}

function detectSentEchoMigration(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  const sourcePath = path.join(stateDir, "imessage", "sent-echoes.jsonl");
  if (!fileExists(sourcePath)) {
    return [];
  }
  return [
    {
      kind: "plugin-state-import",
      label: "iMessage sent-echo dedupe cache",
      sourcePath,
      targetPath: `plugin state:${IMESSAGE_SENT_ECHOES_NAMESPACE}`,
      pluginId: "imessage",
      namespace: IMESSAGE_SENT_ECHOES_NAMESPACE,
      maxEntries: IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
      scopeKey: "",
      stateDir,
      cleanupSource: "rename",
      cleanupWhenEmpty: true,
      preview: `- iMessage sent-echo dedupe cache: ${sourcePath} → plugin state (${IMESSAGE_SENT_ECHOES_NAMESPACE})`,
      readEntries: () => listSentEchoEntries(sourcePath),
    },
  ];
}

function detectCatchupCursorMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  const accountIds = uniqueStrings(
    [resolveDefaultIMessageAccountId(params.cfg), ...listIMessageAccountIds(params.cfg)].map(
      (accountId) => resolveIMessageAccount({ cfg: params.cfg, accountId }).accountId,
    ),
  );
  const configuredPaths = new Set(
    accountIds.map((accountId) => resolveLegacyCatchupCursorPath(stateDir, accountId)),
  );
  const configuredPlans = accountIds.flatMap((accountId) => {
    const sourcePath = resolveLegacyCatchupCursorPath(stateDir, accountId);
    if (!fileExists(sourcePath)) {
      return [];
    }
    return {
      kind: "plugin-state-import" as const,
      label: "iMessage catchup cursor",
      sourcePath,
      targetPath: `plugin state:${IMESSAGE_CATCHUP_CURSOR_NAMESPACE}`,
      pluginId: "imessage",
      namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
      scopeKey: "",
      stateDir,
      cleanupSource: "rename" as const,
      preview: `- iMessage catchup cursor: ${sourcePath} → plugin state (${IMESSAGE_CATCHUP_CURSOR_NAMESPACE})`,
      readEntries: () => {
        const cursor = readCatchupCursor(sourcePath);
        return [{ key: resolveIMessageCatchupCursorKey(accountId), value: cursor }];
      },
      shouldReplaceExistingEntry: (replaceParams: {
        existingValue: unknown;
        incomingValue: unknown;
      }) => shouldReplaceCatchupCursor(replaceParams.existingValue, replaceParams.incomingValue),
    };
  });
  const orphanPlans = listLegacyCatchupCursorPaths(stateDir)
    .filter((sourcePath) => !configuredPaths.has(sourcePath))
    .map((sourcePath) => ({
      kind: "plugin-state-import" as const,
      label: "iMessage orphan catchup cursor",
      sourcePath,
      targetPath: `plugin state:${IMESSAGE_CATCHUP_CURSOR_NAMESPACE}`,
      pluginId: "imessage",
      namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
      maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
      scopeKey: "",
      stateDir,
      cleanupSource: "rename" as const,
      cleanupWhenEmpty: true,
      preview: `- iMessage orphan catchup cursor: ${sourcePath} → archived legacy state`,
      readEntries: () => [],
    }));
  return [...configuredPlans, ...orphanPlans];
}

export async function detectIMessageLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  return [
    ...detectCatchupCursorMigrations(params),
    ...detectReplyCacheMigration(params),
    ...detectSentEchoMigration(params),
  ];
}
