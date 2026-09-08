// Slack plugin module implements sent thread cache behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * Cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 */

const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const MAX_FAILURE_NOTICES = 1000;
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
const SLACK_THREAD_FAILURE_NOTICES_KEY = Symbol.for("openclaw.slackThreadFailureNotices");
const threadParticipation = createPersistentDedupeCache<SlackThreadParticipationRecord>({
  globalKey: SLACK_THREAD_PARTICIPATION_KEY,
  // Participation remains valid until bounded oldest-entry eviction removes it.
  ttlMs: 0,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalSlackRuntime()?.state.openKeyedStore(options),
    logError: createPluginStateErrorReporter(
      getOptionalSlackRuntime,
      "slack",
      "thread-participation-state",
      "Slack persistent thread participation state failed",
    ),
  },
});
const threadFailureNotices = resolveGlobalSingleton(
  SLACK_THREAD_FAILURE_NOTICES_KEY,
  () => new Map<string, string>(),
  (notices) => notices.clear(),
);

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

type SlackFailureNotice = {
  accountId: string;
  channelId: string;
  threadTs?: string;
  failureText: string;
  teamId?: string;
};

function makeFailureNoticeKey(params: Omit<SlackFailureNotice, "failureText">): string {
  const scope = params.threadTs ? `thread:${params.threadTs}` : "channel";
  return makeKey(params.accountId, params.channelId, scope, params.teamId);
}

/** Returns whether this failure was already delivered in the thread or channel. */
export function hasSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  return threadFailureNotices.get(makeFailureNoticeKey(params)) === fingerprint;
}

/** Records a failure after it was delivered in the thread or channel. */
export function recordSlackThreadFailureNotice(params: SlackFailureNotice): boolean {
  const { accountId, channelId, failureText } = params;
  const fingerprint = failureText.trim().replace(/\s+/gu, " ");
  if (!accountId || !channelId || !fingerprint) {
    return false;
  }
  const key = makeFailureNoticeKey(params);
  if (threadFailureNotices.get(key) === fingerprint) {
    return false;
  }
  threadFailureNotices.delete(key);
  threadFailureNotices.set(key, fingerprint);
  if (threadFailureNotices.size > MAX_FAILURE_NOTICES) {
    const oldestKey = threadFailureNotices.keys().next().value;
    if (oldestKey !== undefined) {
      threadFailureNotices.delete(oldestKey);
    }
  }
  return true;
}

/** Clears a thread or channel outage notice after a healthy model turn completes. */
export function clearSlackThreadFailureNotice(params: {
  accountId: string;
  channelId: string;
  threadTs?: string;
  teamId?: string;
}): void {
  const { accountId, channelId } = params;
  if (!accountId || !channelId) {
    return;
  }
  threadFailureNotices.delete(makeFailureNoticeKey(params));
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clearForTest();
  threadFailureNotices.clear();
}
