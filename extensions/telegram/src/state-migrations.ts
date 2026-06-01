import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { resolveChannelAllowFromPath } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listTelegramAccountIds, resolveDefaultTelegramAccountId } from "./account-selection.js";
import {
  listTelegramLegacyBotInfoCacheEntries,
  resolveTelegramBotInfoCachePath,
  TELEGRAM_BOT_INFO_CACHE_MAX_ENTRIES,
  TELEGRAM_BOT_INFO_CACHE_NAMESPACE,
} from "./bot-info-cache.js";
import {
  listTelegramLegacyMessageCacheEntries,
  resolveTelegramMessageCachePath,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache.js";
import {
  listTelegramLegacyMessageDispatchDedupeEntries,
  resolveTelegramMessageDispatchLegacyPath,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
} from "./message-dispatch-dedupe.js";
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

function fileExists(pathValue: string): boolean {
  try {
    return !statRegularFileSync(pathValue).missing;
  } catch {
    return false;
  }
}

function resolveLegacySessionStorePath(params: {
  env: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return path.join(resolveMigrationStateDir(params), "sessions", "sessions.json");
}

function resolveMigrationStateDir(params: { env: NodeJS.ProcessEnv; stateDir?: string }): string {
  return (
    params.stateDir ??
    path.dirname(
      path.dirname(path.dirname(path.dirname(resolveStorePath(undefined, { env: params.env })))),
    )
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
  const storePath = resolveStorePath(params.cfg.session?.store, { env: params.env });
  const runtimePersistedPath = resolveTelegramMessageCachePath(storePath);
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const legacyPersistedPath = resolveTelegramMessageCachePath(legacyStorePath);
  const scopeKey = resolveTelegramMessageCachePersistentScopeKey(runtimePersistedPath);
  const sourcePaths = uniqueStrings([runtimePersistedPath, legacyPersistedPath]);
  return sourcePaths.flatMap((persistedPath) => {
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
      readEntries: () => {
        return listTelegramLegacyMessageCacheEntries({
          persistedPath,
          maxMessages: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
        });
      },
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
  const storePath = resolveStorePath(params.cfg.session?.store, { env: params.env });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const sources = uniqueStrings([storePath, legacyStorePath]).map((sourceStorePath) => ({
    targetStorePath: storePath,
    sourcePath: `${sourceStorePath}.telegram-sent-messages.json`,
  }));
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
      preview: `- Telegram sent-message cache: ${source.sourcePath} → plugin state (${TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE})`,
      readEntries: () =>
        listTelegramLegacySentMessageCacheEntries({
          cfg: { session: { store: source.targetStorePath } },
          persistedPath: source.sourcePath,
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
  const storePath = resolveStorePath(params.cfg.session?.store, { env: params.env });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  return listTelegramAccountIds(params.cfg).flatMap((accountId) => {
    const sources = uniqueStrings([storePath, legacyStorePath]).map((sourceStorePath) => ({
      targetStorePath: storePath,
      sourcePath: resolveTelegramMessageDispatchLegacyPath({
        storePath: sourceStorePath,
        namespace: accountId,
      }),
    }));
    return sources.flatMap((source) => {
      const sourcePath = source.sourcePath;
      if (!fileExists(sourcePath)) {
        return [];
      }
      return {
        kind: "plugin-state-import",
        label: "Telegram message dispatch dedupe",
        sourcePath,
        targetPath: `plugin state:${TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE}`,
        pluginId: "telegram",
        namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
        maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
        scopeKey: "",
        cleanupSource: "rename",
        preview: `- Telegram message dispatch dedupe: ${sourcePath} → plugin state (${TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE})`,
        readEntries: () =>
          listTelegramLegacyMessageDispatchDedupeEntries({
            storePath: source.targetStorePath,
            namespace: accountId,
            persistedPath: source.sourcePath,
          }),
      };
    });
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
  const defaultStorePath = resolveStorePath(params.cfg.session?.store, { env: params.env });
  const defaultAccountStorePath = resolveStorePath(params.cfg.session?.store, {
    env: params.env,
    agentId: resolveDefaultTelegramAccountId(params.cfg),
  });
  const legacyStorePath = resolveLegacySessionStorePath(params);
  const sourcesByKey = new Map(
    [
      ...accountSources,
      topicNameCacheImportSource({ sourceStorePath: defaultStorePath }),
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
  const legacyPath = resolveChannelAllowFromPath("telegram", params.env);
  if (fileExists(legacyPath)) {
    const accountId = resolveDefaultTelegramAccountId(params.cfg);
    const targetPath = resolveChannelAllowFromPath("telegram", params.env, accountId);
    if (!fileExists(targetPath)) {
      plans.push({
        kind: "copy",
        label: "Telegram pairing allowFrom",
        sourcePath: legacyPath,
        targetPath,
      });
    }
  }
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
