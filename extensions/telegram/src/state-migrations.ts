// Telegram plugin module implements state migrations behavior.
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type PersistentDedupeLegacyJsonImportEntry,
  createPersistentDedupeImportEntry,
  listPersistentDedupeLegacyJsonFileEntries,
  resolvePersistentDedupePluginStateNamespace,
  shouldReplacePersistentDedupeEntry,
} from "openclaw/plugin-sdk/persistent-dedupe";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import { fileExists } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listTelegramAccountIds, resolveDefaultTelegramAccountId } from "./account-selection.js";
import {
  listTelegramLegacyBotInfoCacheEntries,
  resolveTelegramBotInfoCachePath,
  TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES,
  TELEGRAM_BOT_INFO_CACHE_NAMESPACE,
} from "./bot-info-cache.js";
import {
  isTelegramMessageCacheSourceMessage,
  resolveTelegramMessageCachePath,
  resolveTelegramMessageCachePersistentScopeKey,
  type PersistedTelegramMessageCacheValue,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
} from "./message-cache.js";
import {
  buildTelegramMessageDispatchAccountReplayKey,
  resolveTelegramMessageDispatchLegacyPath,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
} from "./message-dispatch-dedupe.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  listTelegramLegacySentMessageCacheEntries,
  TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
} from "./sent-message-cache.js";
import {
  listTelegramLegacyStickerCacheEntries,
  TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  TELEGRAM_STICKER_CACHE_NAMESPACE,
} from "./sticker-cache-store.js";
import {
  listTelegramLegacyThreadBindingEntries,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  testing as telegramThreadBindingTesting,
} from "./thread-bindings.js";
import { resolveTelegramToken } from "./token.js";
import {
  listTelegramLegacyTopicNameCacheEntries,
  resolveTopicNameCacheNamespace,
  resolveTopicNameCachePath,
  resolveTopicNameCacheScope,
  TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
} from "./topic-name-cache.js";
import {
  listTelegramLegacyUpdateOffsetEntries,
  normalizeTelegramUpdateOffsetAccountId,
  shouldReplaceTelegramUpdateOffsetEntry,
  TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
  TELEGRAM_UPDATE_OFFSET_NAMESPACE,
} from "./update-offset-store.js";

const TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_NAMESPACE = "telegram.message-dispatch-dedupe";
const TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_MAX_ENTRIES = 4_096;

type TelegramLegacyMessageDispatchDedupeRecord = {
  namespace: string;
  entries: Record<string, number>;
};

function resolveLegacySessionStorePath(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return path.join(resolveMigrationStateDir(params), "sessions", "sessions.json");
}

function resolveAgentSessionStorePath(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
}): string {
  return resolveStorePath(params.cfg.session?.store, {
    env: params.env,
    agentId: params.agentId,
  });
}

function resolveMigrationStateDir(params: { env: NodeJS.ProcessEnv; stateDir?: string }): string {
  return (
    params.stateDir ??
    path.dirname(
      path.dirname(
        path.dirname(
          path.dirname(resolveStorePath(undefined, { env: params.env, agentId: "main" })),
        ),
      ),
    )
  );
}

function parseLegacyMessageCacheJson(text: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return undefined;
  }
}

function readLegacyMessageCacheValues(raw: string): unknown[] {
  const text = raw.trim();
  const whole = parseLegacyMessageCacheJson(text);
  if (whole) {
    return whole;
  }
  const values: unknown[] = [];
  let jsonl = text;
  if (text.startsWith("[")) {
    for (const match of text.matchAll(/\](?=\s*\{\s*"key"\s*:)/g)) {
      const arrayEnd = (match.index ?? -1) + 1;
      const initial = parseLegacyMessageCacheJson(text.slice(0, arrayEnd));
      if (initial) {
        values.push(...initial);
        jsonl = text.slice(arrayEnd);
        break;
      }
    }
  }
  for (const line of jsonl.split("\n")) {
    // Legacy append logs may end in a torn row; doctor imports valid rows.
    values.push(...(parseLegacyMessageCacheJson(line) ?? []));
  }
  return values;
}

function listTelegramLegacyMessageCacheEntries(persistedPath: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(persistedPath, "utf8");
  } catch {
    return [];
  }
  const entries = new Map<string, PersistedTelegramMessageCacheValue>();
  for (const value of readLegacyMessageCacheValues(raw)) {
    if (
      !isRecord(value) ||
      typeof value.key !== "string" ||
      !value.key.trim() ||
      !value.key.includes(":") ||
      !isRecord(value.node)
    ) {
      continue;
    }
    const sourceMessage = value.node.sourceMessage;
    if (!isTelegramMessageCacheSourceMessage(sourceMessage)) {
      continue;
    }
    const { openclaw_prompt_context_projection: _projection, ...canonicalSourceMessage } =
      sourceMessage as PersistedTelegramMessageCacheValue["sourceMessage"] & {
        openclaw_prompt_context_projection?: unknown;
      };
    const parsedThreadId = parseTelegramMessageThreadId(value.node.threadId);
    const threadId = parsedThreadId === undefined ? undefined : String(parsedThreadId);
    const key = `${value.key.slice(0, value.key.lastIndexOf(":") + 1)}${sourceMessage.message_id}`;
    entries.delete(key);
    entries.set(key, {
      version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
      sourceMessage: canonicalSourceMessage as PersistedTelegramMessageCacheValue["sourceMessage"],
      ...(threadId ? { threadId } : {}),
    });
    if (entries.size > TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        entries.delete(oldest);
      }
    }
  }
  return Array.from(entries, ([key, value]) => ({ key, value }));
}

function readLegacyMessageDispatchDedupeRecord(
  value: unknown,
): TelegramLegacyMessageDispatchDedupeRecord | undefined {
  if (!isRecord(value) || typeof value.namespace !== "string") {
    return undefined;
  }
  if (!isRecord(value.entries)) {
    return undefined;
  }
  const entries: Record<string, number> = {};
  for (const [key, seenAt] of Object.entries(value.entries)) {
    if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0) {
      entries[key] = seenAt;
    }
  }
  return { namespace: value.namespace, entries };
}

function remainingMessageDispatchDedupeTtlMs(seenAt: number, now: number): number | undefined {
  const ttlMs = TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS - Math.max(0, now - seenAt);
  return ttlMs > 0 ? ttlMs : undefined;
}

function openTelegramLegacyMessageDispatchBucketStore(env: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStore<unknown>("telegram", {
    namespace: TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_NAMESPACE,
    maxEntries: TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_MAX_ENTRIES,
    env,
  });
}

function readTelegramLegacyMessageDispatchBuckets(params: {
  accountId: string;
  env: NodeJS.ProcessEnv;
  now?: number;
}): { importEntries: PersistentDedupeLegacyJsonImportEntry[]; recordKeys: string[] } {
  const store = openTelegramLegacyMessageDispatchBucketStore(params.env);
  const latestSeenAtByKey = new Map<string, number>();
  const recordKeys: string[] = [];
  for (const entry of store.entries()) {
    const record = readLegacyMessageDispatchDedupeRecord(entry.value);
    if (!record) {
      continue;
    }
    // Lock rows persist as `<accountId>:lock` buckets without dedupe entries;
    // track them as removable so cleanup empties the retired namespace.
    const ownsRecord =
      record.namespace === params.accountId || record.namespace.startsWith(`${params.accountId}:`);
    if (!ownsRecord) {
      continue;
    }
    recordKeys.push(entry.key);
    if (record.namespace !== params.accountId) {
      continue;
    }
    for (const [key, seenAt] of Object.entries(record.entries)) {
      latestSeenAtByKey.set(key, Math.max(latestSeenAtByKey.get(key) ?? 0, seenAt));
    }
  }
  const now = params.now ?? Date.now();
  const importEntries = [...latestSeenAtByKey.entries()].flatMap(([key, seenAt]) => {
    const ttlMs = remainingMessageDispatchDedupeTtlMs(seenAt, now);
    return ttlMs == null
      ? []
      : [
          createPersistentDedupeImportEntry({
            key: buildTelegramMessageDispatchAccountReplayKey({
              accountId: params.accountId,
              key,
            }),
            seenAt,
            ttlMs,
          }),
        ];
  });
  return { importEntries, recordKeys };
}

function removeTelegramLegacyMessageDispatchBuckets(params: {
  accountId: string;
  env: NodeJS.ProcessEnv;
}): void {
  const store = openTelegramLegacyMessageDispatchBucketStore(params.env);
  for (const key of readTelegramLegacyMessageDispatchBuckets(params).recordKeys) {
    store.delete(key);
  }
}

function mapTelegramMessageDispatchDedupeImportEntries(params: {
  accountId: string;
  entries: PersistentDedupeLegacyJsonImportEntry[];
}): PersistentDedupeLegacyJsonImportEntry[] {
  return params.entries.map((entry) =>
    createPersistentDedupeImportEntry({
      key: buildTelegramMessageDispatchAccountReplayKey({
        accountId: params.accountId,
        key: entry.value.key,
      }),
      seenAt: entry.value.seenAt,
      ...(entry.ttlMs != null ? { ttlMs: entry.ttlMs } : {}),
    }),
  );
}

function listTelegramLegacySidecarAccountIds(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  prefix: string;
  suffix: string;
}): string[] {
  let persistedAccountIds: string[];
  try {
    persistedAccountIds = fs
      .readdirSync(path.join(params.stateDir, "telegram"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(params.prefix) &&
          entry.name.endsWith(params.suffix),
      )
      .map((entry) => entry.name.slice(params.prefix.length, -params.suffix.length))
      .filter(Boolean);
  } catch {
    persistedAccountIds = [];
  }
  return uniqueStrings([...listTelegramAccountIds(params.cfg), ...persistedAccountIds]);
}

function detectTelegramMessageCacheLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const storePath = resolveAgentSessionStorePath({
    ...params,
    agentId: resolveDefaultAgentId(params.cfg),
  });
  const legacyMainStorePath = resolveAgentSessionStorePath({ ...params, agentId: "main" });
  const runtimePersistedPath = resolveTelegramMessageCachePath(storePath);
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const legacyPersistedPath = resolveTelegramMessageCachePath(legacyStorePath);
  const scopeKey = resolveTelegramMessageCachePersistentScopeKey(runtimePersistedPath);
  return uniqueStrings([
    runtimePersistedPath,
    resolveTelegramMessageCachePath(legacyMainStorePath),
    legacyPersistedPath,
  ]).flatMap((persistedPath) => {
    if (!fileExists(persistedPath)) {
      return [];
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram prompt-context message cache",
      sourcePath: persistedPath,
      targetPath: `plugin state:${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
      scopeKey,
      cleanupSource: "rename",
      preview: `- Telegram prompt-context message cache: ${persistedPath} → plugin state (${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE})`,
      readEntries: () => listTelegramLegacyMessageCacheEntries(persistedPath),
    };
  });
}

function detectTelegramBotInfoCacheLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ChannelLegacyStateMigrationPlan[] {
  return listTelegramAccountIds(params.cfg).flatMap((accountId) => {
    const persistedPath = resolveTelegramBotInfoCachePath(accountId, params.env);
    if (!fileExists(persistedPath)) {
      return [];
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram startup bot info cache",
      sourcePath: persistedPath,
      targetPath: `plugin state:${TELEGRAM_BOT_INFO_CACHE_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_BOT_INFO_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      preview: `- Telegram startup bot info cache: ${persistedPath} → plugin state (${TELEGRAM_BOT_INFO_CACHE_NAMESPACE})`,
      readEntries: () => {
        return listTelegramLegacyBotInfoCacheEntries({
          accountId,
          persistedPath,
        });
      },
    };
  });
}

function detectTelegramUpdateOffsetLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  return listTelegramLegacySidecarAccountIds({
    cfg: params.cfg,
    stateDir,
    prefix: "update-offset-",
    suffix: ".json",
  }).flatMap((accountId) => {
    const normalized = normalizeTelegramUpdateOffsetAccountId(accountId);
    const persistedPath = path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
    if (!fileExists(persistedPath)) {
      return [];
    }
    let botToken: string | undefined;
    try {
      botToken =
        resolveTelegramToken(params.cfg, {
          accountId,
          envToken: params.env.TELEGRAM_BOT_TOKEN,
        }).token || undefined;
    } catch {
      botToken = undefined;
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram update offset",
      sourcePath: persistedPath,
      targetPath: `plugin state:${TELEGRAM_UPDATE_OFFSET_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
      maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      preview: `- Telegram update offset: ${persistedPath} → plugin state (${TELEGRAM_UPDATE_OFFSET_NAMESPACE})`,
      readEntries: () => listTelegramLegacyUpdateOffsetEntries({ accountId, persistedPath }),
      shouldReplaceExistingEntry: ({ existingValue, incomingValue }) =>
        shouldReplaceTelegramUpdateOffsetEntry({
          existingValue,
          incomingValue,
          botToken,
        }),
    };
  });
}

function detectTelegramStickerCacheLegacyStateMigration(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  const persistedPath = path.join(stateDir, "telegram", "sticker-cache.json");
  if (!fileExists(persistedPath)) {
    return [];
  }
  return [
    {
      kind: "plugin-state-import",
      label: "Telegram sticker cache",
      sourcePath: persistedPath,
      targetPath: `plugin state:${TELEGRAM_STICKER_CACHE_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      preview: `- Telegram sticker cache: ${persistedPath} → plugin state (${TELEGRAM_STICKER_CACHE_NAMESPACE})`,
      readEntries: () => listTelegramLegacyStickerCacheEntries({ persistedPath }),
    },
  ];
}

function detectTelegramSentMessageCacheLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const storePath = resolveAgentSessionStorePath({ ...params, agentId: defaultAgentId });
  const legacyMainStorePath = resolveAgentSessionStorePath({ ...params, agentId: "main" });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const sources = uniqueStrings([storePath, legacyMainStorePath, legacyStorePath]).map(
    (sourceStorePath) => ({
      targetStorePath: storePath,
      sourcePath: `${sourceStorePath}.telegram-sent-messages.json`,
    }),
  );
  return sources.flatMap((source) => {
    if (!fileExists(source.sourcePath)) {
      return [];
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram sent-message cache",
      sourcePath: source.sourcePath,
      targetPath: `plugin state:${TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      cleanupWhenEmpty: true,
      preview: `- Telegram sent-message cache: ${source.sourcePath} → plugin state (${TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE})`,
      readEntries: () =>
        listTelegramLegacySentMessageCacheEntries({
          cfg: params.cfg,
          agentId: defaultAgentId,
          persistedPath: source.sourcePath,
          targetStorePath: source.targetStorePath,
        }),
    };
  });
}

function detectTelegramThreadBindingLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const stateDir = resolveMigrationStateDir(params);
  return listTelegramLegacySidecarAccountIds({
    cfg: params.cfg,
    stateDir,
    prefix: "thread-bindings-",
    suffix: ".json",
  }).flatMap((accountId) => {
    const persistedPath = telegramThreadBindingTesting.resolveBindingsPath(accountId, params.env);
    if (!fileExists(persistedPath)) {
      return [];
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram thread bindings",
      sourcePath: persistedPath,
      targetPath: `plugin state:${TELEGRAM_THREAD_BINDINGS_NAMESPACE}`,
      pluginId: "telegram",
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      preview: `- Telegram thread bindings: ${persistedPath} → plugin state (${TELEGRAM_THREAD_BINDINGS_NAMESPACE})`,
      readEntries: () => listTelegramLegacyThreadBindingEntries({ accountId, persistedPath }),
    };
  });
}

function detectTelegramMessageDispatchLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const storePath = resolveAgentSessionStorePath({
    ...params,
    agentId: resolveDefaultAgentId(params.cfg),
  });
  const legacyMainStorePath = resolveAgentSessionStorePath({ ...params, agentId: "main" });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const env = params.stateDir ? { ...params.env, OPENCLAW_STATE_DIR: params.stateDir } : params.env;
  const namespace = resolvePersistentDedupePluginStateNamespace({
    namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
    namespacePrefix: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE_PREFIX,
  });
  return listTelegramAccountIds(params.cfg).flatMap((accountId) => {
    const sources = uniqueStrings([storePath, legacyMainStorePath, legacyStorePath]).map(
      (sourceStorePath) => ({
        sourcePath: resolveTelegramMessageDispatchLegacyPath({
          storePath: sourceStorePath,
          namespace: accountId,
        }),
      }),
    );
    const jsonPlans: ChannelLegacyStateMigrationPlan[] = sources.flatMap((source) => {
      const sourcePath = source.sourcePath;
      if (!fileExists(sourcePath)) {
        return [];
      }
      return {
        kind: "plugin-state-import",
        label: "Telegram message dispatch dedupe",
        sourcePath,
        targetPath: `plugin state:${namespace}`,
        pluginId: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
        namespace,
        maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
        defaultTtlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
        scopeKey: "",
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        preview: `- Telegram message dispatch dedupe: ${sourcePath} → plugin state (${namespace})`,
        shouldReplaceExistingEntry: ({ existingValue, incomingValue }) =>
          shouldReplacePersistentDedupeEntry({ existingValue, incomingValue }),
        readEntries: async () =>
          mapTelegramMessageDispatchDedupeImportEntries({
            accountId,
            entries: await listPersistentDedupeLegacyJsonFileEntries({
              filePath: source.sourcePath,
              ttlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
            }),
          }),
      };
    });
    let legacyRecordKeys: string[];
    try {
      legacyRecordKeys = readTelegramLegacyMessageDispatchBuckets({ accountId, env }).recordKeys;
    } catch {
      legacyRecordKeys = [];
    }
    // Emit the plan while any retired bucket rows remain (even TTL-expired ones)
    // so doctor --fix imports live entries and then deletes the legacy source.
    if (legacyRecordKeys.length === 0) {
      return jsonPlans;
    }
    const pluginStatePlan: ChannelLegacyStateMigrationPlan = {
      kind: "plugin-state-import",
      label: "Telegram message dispatch dedupe",
      sourcePath: `plugin state:${TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_NAMESPACE}:${accountId}`,
      targetPath: `plugin state:${namespace}`,
      pluginId: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_PLUGIN_ID,
      namespace,
      maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_STATE_MAX_ENTRIES,
      defaultTtlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_TTL_MS,
      scopeKey: "",
      cleanupWhenEmpty: true,
      preview: `- Telegram message dispatch dedupe: plugin state (${TELEGRAM_MESSAGE_DISPATCH_LEGACY_BUCKET_NAMESPACE}) → plugin state (${namespace})`,
      shouldReplaceExistingEntry: ({ existingValue, incomingValue }) =>
        shouldReplacePersistentDedupeEntry({ existingValue, incomingValue }),
      readEntries: () => readTelegramLegacyMessageDispatchBuckets({ accountId, env }).importEntries,
      removeSource: () => removeTelegramLegacyMessageDispatchBuckets({ accountId, env }),
    };
    return jsonPlans.concat(pluginStatePlan);
  });
}

function topicNameCacheImportSource(params: {
  sourceStorePath: string;
  targetStorePath?: string;
}): { sourcePath: string; namespace: string } {
  const targetStorePath = params.targetStorePath ?? params.sourceStorePath;
  const scope = resolveTopicNameCacheScope(targetStorePath);
  return {
    sourcePath: resolveTopicNameCachePath(params.sourceStorePath),
    namespace: resolveTopicNameCacheNamespace(scope),
  };
}

function detectTelegramTopicNameCacheLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const accountSources = listTelegramAccountIds(params.cfg).map((accountId) => {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      env: params.env,
      agentId: accountId,
    });
    return topicNameCacheImportSource({ sourceStorePath: storePath });
  });
  const defaultStorePath = resolveAgentSessionStorePath({
    ...params,
    agentId: resolveDefaultAgentId(params.cfg),
  });
  const legacyMainStorePath = resolveAgentSessionStorePath({ ...params, agentId: "main" });
  const defaultAccountStorePath = resolveStorePath(params.cfg.session?.store, {
    env: params.env,
    agentId: resolveDefaultTelegramAccountId(params.cfg),
  });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const sourcesByKey = new Map(
    [
      ...accountSources,
      topicNameCacheImportSource({ sourceStorePath: defaultStorePath }),
      topicNameCacheImportSource({ sourceStorePath: legacyMainStorePath }),
      topicNameCacheImportSource({
        sourceStorePath: legacyStorePath,
        targetStorePath: defaultAccountStorePath,
      }),
    ].map((source) => [`${source.sourcePath}\0${source.namespace}`, source] as const),
  );
  return [...sourcesByKey.values()].flatMap((source) => {
    if (!fileExists(source.sourcePath)) {
      return [];
    }
    return {
      kind: "plugin-state-import",
      label: "Telegram forum topic-name cache",
      sourcePath: source.sourcePath,
      targetPath: `plugin state:${source.namespace}`,
      pluginId: "telegram",
      namespace: source.namespace,
      maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
      scopeKey: "",
      cleanupSource: "rename",
      preview: `- Telegram forum topic-name cache: ${source.sourcePath} → plugin state (${source.namespace})`,
      readEntries: () => {
        return listTelegramLegacyTopicNameCacheEntries({
          persistedPath: source.sourcePath,
          maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
        });
      },
    };
  });
}

export async function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  plans.push(...detectTelegramUpdateOffsetLegacyStateMigration(params));
  plans.push(...detectTelegramBotInfoCacheLegacyStateMigration(params));
  plans.push(...detectTelegramStickerCacheLegacyStateMigration(params));
  plans.push(...detectTelegramMessageCacheLegacyStateMigration(params));
  plans.push(...detectTelegramSentMessageCacheLegacyStateMigration(params));
  plans.push(...detectTelegramTopicNameCacheLegacyStateMigration(params));
  plans.push(...detectTelegramThreadBindingLegacyStateMigration(params));
  plans.push(...detectTelegramMessageDispatchLegacyStateMigration(params));
  return plans;
}
