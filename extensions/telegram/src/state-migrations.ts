// Telegram plugin module implements state migrations behavior.
import fs from "node:fs";
import path from "node:path";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fileExists } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
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
} from "./message-cache-persistence.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  listTelegramLegacySentMessageCacheEntries,
  TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
} from "./sent-message-cache.legacy-state.js";
import {
  listTelegramLegacyStickerCacheEntries,
  TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  TELEGRAM_STICKER_CACHE_NAMESPACE,
} from "./sticker-cache-store.legacy-state.js";
import {
  listTelegramLegacyThreadBindingEntries,
  resolveTelegramThreadBindingsPath,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
} from "./thread-bindings-store.js";
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

function listLegacyAgentSessionStoreSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  resolveSourcePath: (storePath: string) => string;
  preserveLegacyAccountScope?: boolean;
}): Array<{ sourcePath: string; targetStorePath: string }> {
  const asSource = (targetStorePath: string) => ({
    sourcePath: params.resolveSourcePath(targetStorePath),
    targetStorePath,
  });
  const sources = uniqueStrings(
    [...listAgentIds(params.cfg), "main"].map((agentId) =>
      resolveAgentSessionStorePath({ ...params, agentId }),
    ),
  )
    .map(asSource)
    .filter(({ sourcePath }) => fileExists(sourcePath));
  const legacySourcePath = params.resolveSourcePath(resolveLegacySessionStorePath(params));
  if (
    !fileExists(legacySourcePath) ||
    sources.some(({ sourcePath }) => sourcePath === legacySourcePath)
  ) {
    return sources;
  }
  // Only the global sidecar needs a selected owner; agent-local sidecars retain theirs.
  const targetAgentId =
    params.preserveLegacyAccountScope &&
    params.cfg.agents?.entries === undefined &&
    params.cfg.agents?.list === undefined
      ? resolveDefaultTelegramAccountId(params.cfg)
      : resolveTelegramLegacyStateOwnerAgentId(params.cfg);
  return [
    ...sources,
    {
      sourcePath: legacySourcePath,
      targetStorePath: resolveAgentSessionStorePath({ ...params, agentId: targetAgentId }),
    },
  ];
}

function resolveTelegramLegacyStateOwnerAgentId(cfg: OpenClawConfig): string {
  const configuredAccountIds = listTelegramAccountIds(cfg);
  const accountIds =
    configuredAccountIds.length > 0 ? configuredAccountIds : [resolveDefaultTelegramAccountId(cfg)];
  const ownerAgentIds = uniqueStrings(
    accountIds.map((accountId) => resolveTelegramAccountOwnerAgentId({ cfg, accountId })),
  );
  if (ownerAgentIds.length === 1) {
    return ownerAgentIds[0]!;
  }
  throw new Error(
    `Legacy Telegram state has multiple routed owners (${ownerAgentIds.join(", ")}); preserve it until one migration owner is configured.`,
  );
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

type TelegramStateImportPlan = Extract<
  ChannelLegacyStateMigrationPlan,
  { kind: "plugin-state-import" }
>;

function telegramStateImport(
  params: Omit<
    TelegramStateImportPlan,
    "kind" | "targetPath" | "pluginId" | "scopeKey" | "cleanupSource" | "preview"
  > & { scopeKey?: string },
): TelegramStateImportPlan {
  return {
    ...params,
    kind: "plugin-state-import",
    targetPath: `plugin state:${params.namespace}`,
    pluginId: "telegram",
    scopeKey: params.scopeKey ?? "",
    cleanupSource: "rename",
    preview: `- ${params.label}: ${params.sourcePath} → plugin state (${params.namespace})`,
  };
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
  const sources = listLegacyAgentSessionStoreSources({
    ...params,
    resolveSourcePath: resolveTelegramMessageCachePath,
  });
  return sources.map(({ sourcePath, targetStorePath }) =>
    telegramStateImport({
      label: "Telegram prompt-context message cache",
      sourcePath,
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
      scopeKey: resolveTelegramMessageCachePersistentScopeKey(
        resolveTelegramMessageCachePath(targetStorePath),
      ),
      readEntries: () => listTelegramLegacyMessageCacheEntries(sourcePath),
    }),
  );
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
    return telegramStateImport({
      label: "Telegram startup bot info cache",
      sourcePath: persistedPath,
      namespace: TELEGRAM_BOT_INFO_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES,
      readEntries: () => {
        return listTelegramLegacyBotInfoCacheEntries({
          accountId,
          persistedPath,
        });
      },
    });
  });
}

async function detectTelegramUpdateOffsetLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  // token.js pulls provider-auth's config graph; keep it lazy so setup/doctor
  // closure cold-load stays light.
  const { resolveTelegramToken } = await import("./token.js");
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
    return telegramStateImport({
      label: "Telegram update offset",
      sourcePath: persistedPath,
      namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
      maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
      readEntries: () => listTelegramLegacyUpdateOffsetEntries({ accountId, persistedPath }),
      shouldReplaceExistingEntry: ({ existingValue, incomingValue }) =>
        shouldReplaceTelegramUpdateOffsetEntry({
          existingValue,
          incomingValue,
          botToken,
        }),
    });
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
    telegramStateImport({
      label: "Telegram sticker cache",
      sourcePath: persistedPath,
      namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
      readEntries: () => listTelegramLegacyStickerCacheEntries({ persistedPath }),
    }),
  ];
}

function detectTelegramSentMessageCacheLegacyStateMigration(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): ChannelLegacyStateMigrationPlan[] {
  const sources = listLegacyAgentSessionStoreSources({
    ...params,
    resolveSourcePath: (storePath) => `${storePath}.telegram-sent-messages.json`,
  });
  return sources.map(({ sourcePath, targetStorePath }) =>
    telegramStateImport({
      label: "Telegram sent-message cache",
      sourcePath,
      namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
      cleanupWhenEmpty: true,
      readEntries: () =>
        listTelegramLegacySentMessageCacheEntries({
          persistedPath: sourcePath,
          targetStorePath,
        }),
    }),
  );
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
    const persistedPath = resolveTelegramThreadBindingsPath(accountId, params.env);
    if (!fileExists(persistedPath)) {
      return [];
    }
    return telegramStateImport({
      label: "Telegram thread bindings",
      sourcePath: persistedPath,
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
      readEntries: () => listTelegramLegacyThreadBindingEntries({ accountId, persistedPath }),
    });
  });
}

function topicNameCacheImportSource(sourcePath: string, targetStorePath: string) {
  return {
    sourcePath,
    namespace: resolveTopicNameCacheNamespace(resolveTopicNameCacheScope(targetStorePath)),
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
    return topicNameCacheImportSource(resolveTopicNameCachePath(storePath), storePath);
  });
  const sessionSources = listLegacyAgentSessionStoreSources({
    ...params,
    resolveSourcePath: resolveTopicNameCachePath,
    // Pre-roster topic caches used the account id as their session-store scope.
    preserveLegacyAccountScope: true,
  }).map(({ sourcePath, targetStorePath }) =>
    topicNameCacheImportSource(sourcePath, targetStorePath),
  );
  const sourcesByKey = new Map(
    [...accountSources.filter((source) => fileExists(source.sourcePath)), ...sessionSources].map(
      (source) => [`${source.sourcePath}\0${source.namespace}`, source] as const,
    ),
  );
  return [...sourcesByKey.values()].map((source) =>
    telegramStateImport({
      label: "Telegram forum topic-name cache",
      sourcePath: source.sourcePath,
      namespace: source.namespace,
      maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
      readEntries: () => {
        return listTelegramLegacyTopicNameCacheEntries({
          persistedPath: source.sourcePath,
          maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
        });
      },
    }),
  );
}

export async function detectTelegramLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  plans.push(...(await detectTelegramUpdateOffsetLegacyStateMigration(params)));
  plans.push(...detectTelegramBotInfoCacheLegacyStateMigration(params));
  plans.push(...detectTelegramStickerCacheLegacyStateMigration(params));
  plans.push(...detectTelegramMessageCacheLegacyStateMigration(params));
  plans.push(...detectTelegramSentMessageCacheLegacyStateMigration(params));
  plans.push(...detectTelegramTopicNameCacheLegacyStateMigration(params));
  plans.push(...detectTelegramThreadBindingLegacyStateMigration(params));
  return plans;
}
