import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";

export type TelegramErrorPolicy = "always" | "once" | "silent";

type TelegramErrorConfig =
  | TelegramAccountConfig
  | TelegramDirectConfig
  | TelegramGroupConfig
  | TelegramTopicConfig;

const errorCooldownStore = new Map<string, Map<string, number>>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

function pruneExpiredCooldowns(messageStore: Map<string, number>, now: number) {
  for (const [message, expiresAt] of messageStore) {
    if (expiresAt <= now) {
      messageStore.delete(message);
    }
  }
}

export function resolveTelegramErrorPolicy(params: {
  accountConfig?: TelegramAccountConfig;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  policy: TelegramErrorPolicy;
  cooldownMs: number;
} {
  const configs: Array<TelegramErrorConfig | undefined> = [
    params.accountConfig,
    params.groupConfig,
    params.topicConfig,
  ];
  let policy: TelegramErrorPolicy = "always";
  let cooldownMs = DEFAULT_ERROR_COOLDOWN_MS;

  for (const config of configs) {
    if (config?.errorPolicy) {
      policy = config.errorPolicy;
    }
    if (typeof config?.errorCooldownMs === "number") {
      cooldownMs = config.errorCooldownMs;
    }
  }

  return { policy, cooldownMs };
}

export function buildTelegramErrorScopeKey(params: {
  accountId: string;
  chatId: string | number;
  threadId?: string | number | null;
}): string {
  const threadId = params.threadId == null ? "main" : String(params.threadId);
  return `${params.accountId}:${String(params.chatId)}:${threadId}`;
}

export function shouldSuppressTelegramError(params: {
  scopeKey: string;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { scopeKey, cooldownMs, errorMessage } = params;
  const now = Date.now();
  const messageKey = errorMessage ?? "";
  const scopeStore = errorCooldownStore.get(scopeKey);

  if (scopeStore) {
    pruneExpiredCooldowns(scopeStore, now);
    if (scopeStore.size === 0) {
      errorCooldownStore.delete(scopeKey);
    }
  }

  if (errorCooldownStore.size > 100) {
    for (const [scope, messageStore] of errorCooldownStore) {
      pruneExpiredCooldowns(messageStore, now);
      if (messageStore.size === 0) {
        errorCooldownStore.delete(scope);
      }
    }
  }

  const expiresAt = scopeStore?.get(messageKey);
  if (typeof expiresAt === "number" && expiresAt > now) {
    return true;
  }

  const nextScopeStore = scopeStore ?? new Map<string, number>();
  nextScopeStore.set(messageKey, now + cooldownMs);
  errorCooldownStore.set(scopeKey, nextScopeStore);
  return false;
}

export function isSilentErrorPolicy(policy: TelegramErrorPolicy): boolean {
  return policy === "silent";
}

export function resetTelegramErrorPolicyStoreForTest() {
  errorCooldownStore.clear();
}
