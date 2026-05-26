import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { resolveChannelAllowFromPath } from "openclaw/plugin-sdk/channel-pairing-paths";
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
  listTelegramLegacyTopicNameCacheEntries,
  resolveTopicNameCacheNamespace,
  resolveTopicNameCachePath,
  resolveTopicNameCacheScope,
  TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
} from "./topic-name-cache.js";

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
  const stateDir =
    params.stateDir ??
    path.dirname(
      path.dirname(path.dirname(path.dirname(resolveStorePath(undefined, { env: params.env })))),
    );
  return path.join(stateDir, "sessions", "sessions.json");
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
  plans.push(...detectTelegramBotInfoCacheLegacyStateMigration(params));
  plans.push(...detectTelegramMessageCacheLegacyStateMigration(params));
  plans.push(...detectTelegramTopicNameCacheLegacyStateMigration(params));
  return plans;
}
