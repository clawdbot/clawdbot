import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
// Discord plugin module cleans up reactions left by the retired subagent progress feature.
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { resolveDiscordAccount, resolveDiscordAccountConfig } from "./accounts.js";
import { removeReactionDiscord } from "./send.reactions.js";

// Keep beta3's namespace lifecycle so its reaction ownership remains discoverable after upgrade.
const PROGRESS_STORE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TRACKED_RUNS = 4_096;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;
const RETRY_MAX_ATTEMPTS = 12;
const HISTORICAL_RUNNING_EMOJIS = new Set([
  "1️⃣",
  "2️⃣",
  "3️⃣",
  "4️⃣",
  "5️⃣",
  "6️⃣",
  "7️⃣",
  "8️⃣",
  "9️⃣",
  "🔟",
]);

type PersistedProgressRun = {
  accountId: string;
  channelId: string;
  messageId: string;
  runningEmoji?: string;
};

type ProgressCleanupApi = {
  config: OpenClawConfig;
  logger: { debug?: (message: string) => void };
  runtime: {
    state: {
      openKeyedStore<T>(options: {
        namespace: string;
        maxEntries: number;
        overflowPolicy: "reject-new";
        defaultTtlMs: number;
      }): PluginStateKeyedStore<T>;
    };
  };
};

type RecoveryRetry = { attempts: number; timer?: ReturnType<typeof setTimeout> };

const recoveryRetries = new Map<ProgressCleanupApi, RecoveryRetry>();

function logFailure(api: ProgressCleanupApi, action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  api.logger.debug?.(`discord retired subagent progress ${action} failed: ${message}`);
}

function reservedReactionEmojis(api: ProgressCleanupApi, accountAckReaction?: string): Set<string> {
  const reserved = new Set<string>(Object.values(DEFAULT_EMOJIS));
  for (const emoji of [api.config.messages?.ackReaction, accountAckReaction]) {
    if (emoji?.trim()) {
      reserved.add(emoji.trim());
    }
  }
  for (const agentId of listAgentIds(api.config)) {
    const emoji = resolveAgentConfig(api.config, agentId)?.identity?.emoji?.trim();
    if (emoji) {
      reserved.add(emoji);
    }
  }
  return reserved;
}

function clearRecoveryRetry(api: ProgressCleanupApi) {
  const retry = recoveryRetries.get(api);
  if (retry?.timer) {
    clearTimeout(retry.timer);
  }
  recoveryRetries.delete(api);
}

function scheduleRecoveryRetry(api: ProgressCleanupApi) {
  const retry = recoveryRetries.get(api) ?? { attempts: 0 };
  if (retry.timer || retry.attempts >= RETRY_MAX_ATTEMPTS) {
    return;
  }
  // A later gateway restart starts a fresh bounded recovery window for retained rows.
  const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** retry.attempts, RETRY_MAX_DELAY_MS);
  retry.attempts += 1;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    void recoverDiscordSubagentProgress(api);
  }, delayMs);
  retry.timer.unref?.();
  recoveryRetries.set(api, retry);
}

async function cleanPersistedReaction(
  api: ProgressCleanupApi,
  store: PluginStateKeyedStore<PersistedProgressRun>,
  entry: PluginStateEntry<PersistedProgressRun>,
): Promise<boolean> {
  try {
    // Removed named accounts must not inherit today's root token and mutate another bot's reaction.
    if (
      entry.value.accountId !== DEFAULT_ACCOUNT_ID &&
      !resolveDiscordAccountConfig(api.config, entry.value.accountId)
    ) {
      return false;
    }
    const account = resolveDiscordAccount({ cfg: api.config, accountId: entry.value.accountId });
    if (!account.enabled || account.tokenStatus !== "available") {
      return false;
    }
    const emoji = entry.value.runningEmoji;
    // Persisted state can only authorize removal of glyphs the retired feature owned.
    if (
      emoji &&
      HISTORICAL_RUNNING_EMOJIS.has(emoji) &&
      !reservedReactionEmojis(api, account.config.ackReaction).has(emoji)
    ) {
      await removeReactionDiscord(entry.value.channelId, entry.value.messageId, emoji, {
        cfg: api.config,
        accountId: entry.value.accountId,
      });
    }
    // Persisted ownership must survive until the external reaction is gone.
    await store.consume(entry.key);
    return true;
  } catch (error) {
    logFailure(api, "startup cleanup", error);
    return false;
  }
}

async function recoverDiscordSubagentProgressImpl(api: ProgressCleanupApi) {
  let store: PluginStateKeyedStore<PersistedProgressRun>;
  try {
    store = api.runtime.state.openKeyedStore<PersistedProgressRun>({
      namespace: "subagent-progress",
      maxEntries: MAX_TRACKED_RUNS,
      overflowPolicy: "reject-new",
      defaultTtlMs: PROGRESS_STORE_TTL_MS,
    });
  } catch (error) {
    logFailure(api, "state store open", error);
    scheduleRecoveryRetry(api);
    return;
  }

  let entries: PluginStateEntry<PersistedProgressRun>[];
  try {
    entries = await store.entries();
  } catch (error) {
    logFailure(api, "startup recovery list", error);
    scheduleRecoveryRetry(api);
    return;
  }

  let retryNeeded = false;
  for (const entry of entries) {
    if (!(await cleanPersistedReaction(api, store, entry))) {
      retryNeeded = true;
    }
  }
  if (retryNeeded) {
    scheduleRecoveryRetry(api);
  } else {
    clearRecoveryRetry(api);
  }
}

function resetDiscordSubagentProgressForTest() {
  for (const [api, retry] of recoveryRetries) {
    if (retry.timer) {
      clearTimeout(retry.timer);
    }
    recoveryRetries.delete(api);
  }
}

export const recoverDiscordSubagentProgress = Object.assign(recoverDiscordSubagentProgressImpl, {
  resetForTest: resetDiscordSubagentProgressForTest,
});
