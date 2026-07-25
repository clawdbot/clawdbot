// Slack plugin module implements sent thread cache behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "slack.thread-participation";

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
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalSlackRuntime()?.state.openKeyedStore(options),
    logError: (error) => {
      try {
        getOptionalSlackRuntime()
          ?.logging.getChildLogger({ plugin: "slack", feature: "thread-participation-state" })
          .warn("Slack persistent thread participation state failed", { error: String(error) });
      } catch {
        // Best effort only: persistent state must never break Slack message handling.
      }
    },
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
