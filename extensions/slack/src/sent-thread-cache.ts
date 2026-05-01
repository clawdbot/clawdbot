import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "slack.thread-participation";

type SlackThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

type SlackThreadParticipationStore = {
  register(
    key: string,
    value: SlackThreadParticipationRecord,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<SlackThreadParticipationRecord | undefined>;
};

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const threadParticipation = resolveGlobalDedupeCache(SLACK_THREAD_PARTICIPATION_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

let persistentStore: SlackThreadParticipationStore | undefined;
let persistentStoreDisabled = false;

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

function reportPersistentThreadParticipationError(error: unknown): void {
  try {
    getOptionalSlackRuntime()
      ?.logging.getChildLogger({ plugin: "slack", feature: "thread-participation-state" })
      .warn("Slack persistent thread participation state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Slack message handling.
  }
}

function disablePersistentThreadParticipation(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentThreadParticipationError(error);
}

function getPersistentThreadParticipationStore(): SlackThreadParticipationStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<SlackThreadParticipationRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentThreadParticipation(error);
    return undefined;
  }
}

function rememberPersistentThreadParticipation(params: { key: string; agentId?: string }): void {
  const store = getPersistentThreadParticipationStore();
  if (!store) {
    return;
  }
  void store
    .register(params.key, {
      // Stored for future per-agent thread routing; current reads only need presence.
      ...(params.agentId ? { agentId: params.agentId } : {}),
      repliedAt: Date.now(),
    })
    .catch(disablePersistentThreadParticipation);
}

async function lookupPersistentThreadParticipation(key: string): Promise<boolean> {
  const store = getPersistentThreadParticipationStore();
  if (!store) {
    return false;
  }
  try {
    return Boolean(await store.lookup(key));
  } catch (error) {
    disablePersistentThreadParticipation(error);
    return false;
  }
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
  opts?: { agentId?: string },
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  const key = makeKey(accountId, channelId, threadTs);
  threadParticipation.check(key);
  rememberPersistentThreadParticipation({ key, agentId: opts?.agentId });
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs));
}

export async function hasSlackThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadTs) {
    return false;
  }
  const key = makeKey(params.accountId, params.channelId, params.threadTs);
  if (threadParticipation.peek(key)) {
    return true;
  }
  const found = await lookupPersistentThreadParticipation(key);
  if (found) {
    threadParticipation.check(key);
  }
  return found;
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
}
