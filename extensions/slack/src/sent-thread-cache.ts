// Slack plugin module implements sent thread cache behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";
import { SLACK_THREAD_PARTICIPATION_STORE_OPTIONS } from "./thread-participation-state.js";

/**
 * Cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 */

const MAX_ENTRIES = 5000;

type SlackThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const threadParticipation = createPersistentDedupeCache<SlackThreadParticipationRecord>({
  globalKey: SLACK_THREAD_PARTICIPATION_KEY,
  // Participation remains valid until bounded oldest-entry eviction removes it.
  ttlMs: 0,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: SLACK_THREAD_PARTICIPATION_STORE_OPTIONS.namespace,
    maxEntries: SLACK_THREAD_PARTICIPATION_STORE_OPTIONS.maxEntries,
    openStore: (options) =>
      getOptionalSlackRuntime()?.state.openKeyedStore({
        ...options,
        // Preserve existing thread participation when upgrading its former TTL policy.
        clearExistingExpiryOnOpen:
          SLACK_THREAD_PARTICIPATION_STORE_OPTIONS.clearExistingExpiryOnOpen,
      }),
    logError: createPluginStateErrorReporter(
      getOptionalSlackRuntime,
      "slack",
      "thread-participation-state",
      "Slack persistent thread participation state failed",
    ),
  },
});

function makeKey(accountId: string, channelId: string, threadTs: string, teamId?: string): string {
  return `${accountId}:${teamId ? `${teamId}:` : ""}${channelId}:${threadTs}`;
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  opts?: { agentId?: string; teamId?: string },
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  void threadParticipation.register(makeKey(accountId, channelId, threadTs, opts?.teamId), {
    // Stored for future per-agent thread routing; current reads only need presence.
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    repliedAt: Date.now(),
  });
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  teamId?: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs, teamId));
}

export async function hasSlackThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  teamId?: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return false;
  }
  return await threadParticipation.lookup(
    makeKey(params.accountId, params.channelId, params.threadTs, params.teamId),
  );
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clearForTest();
}
