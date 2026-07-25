// Mattermost plugin module implements thread participation cache behavior.
import { createPersistentDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalMattermostRuntime } from "../runtime.js";

/**
 * Cache of Mattermost threads the bot has replied in. Lets the bot auto-respond
 * to thread follow-ups without a re-mention after its first visible reply.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 5000;
const PERSISTENT_MAX_ENTRIES = 1000;
const PERSISTENT_NAMESPACE = "mattermost.thread-participation";

type MattermostThreadParticipationRecord = {
  agentId?: string;
  repliedAt: number;
};

/**
 * Keep thread participation shared across bundled chunks so thread auto-reply
 * gating does not diverge between the inbound-gate and reply-dispatch paths.
 */
const MATTERMOST_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.mattermostThreadParticipation");
const threadParticipation = createPersistentDedupeCache<MattermostThreadParticipationRecord>({
  globalKey: MATTERMOST_THREAD_PARTICIPATION_KEY,
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
  persistent: {
    namespace: PERSISTENT_NAMESPACE,
    maxEntries: PERSISTENT_MAX_ENTRIES,
    openStore: (options) => getOptionalMattermostRuntime()?.state.openKeyedStore(options),
    logError: (error) => {
      try {
        getOptionalMattermostRuntime()
          ?.logging.getChildLogger({ plugin: "mattermost", feature: "thread-participation-state" })
          .warn("Mattermost persistent thread participation state failed", {
            error: String(error),
          });
      } catch {
        // Best effort only: persistent state must never break Mattermost message handling.
      }
    },
  },
});

function makeKey(accountId: string, channelId: string, threadRootId: string): string {
  return `${accountId}:${channelId}:${threadRootId}`;
}

export function recordMattermostThreadParticipation(
  accountId: string,
  channelId: string,
  threadRootId: string,
  opts?: { agentId?: string },
): void {
  if (!accountId || !channelId || !threadRootId) {
    return;
  }
  void threadParticipation.register(makeKey(accountId, channelId, threadRootId), {
    // Stored for future per-agent thread routing; current reads only need presence.
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    repliedAt: Date.now(),
  });
}

export async function hasMattermostThreadParticipationWithPersistence(params: {
  accountId: string;
  channelId: string;
  threadRootId: string;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.threadRootId) {
    return false;
  }
  return await threadParticipation.lookup(
    makeKey(params.accountId, params.channelId, params.threadRootId),
  );
}
