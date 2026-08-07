// Discord plugin module implements thread session close behavior.
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deleteSessionEntry,
  listSessionEntries,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Closes every session entry in the store whose key contains {@link threadId}.
 * The explicit lifecycle deletion archives the old transcript and guarantees
 * that a later inbound message starts a fresh session in every reset mode.
 */
export async function closeDiscordThreadSessions(params: {
  cfg: OpenClawConfig;
  threadId: string;
}): Promise<number> {
  const { cfg, threadId } = params;

  const normalizedThreadId = normalizeOptionalLowercaseString(threadId) ?? "";
  if (!normalizedThreadId) {
    return 0;
  }

  // Match when the threadId appears as a complete colon-separated segment.
  // e.g. "999" must be followed by ":" (middle) or end-of-string (final).
  // Using a regex avoids false-positives where one snowflake is a prefix of
  // another (e.g. searching for "999" must not match ":99900").
  //
  // Session key shapes:
  //   agent:<agentId>:discord:channel:<threadId>
  //   agent:<agentId>:discord:channel:<parentId>:thread:<threadId>
  const segmentRe = new RegExp(`:${normalizedThreadId}(?::|$)`, "i");

  function sessionKeyContainsThreadId(key: string): boolean {
    return segmentRe.test(key);
  }

  // Session keys are agent-scoped (agent:<agentId>:discord:...), so the store
  // must resolve per routed agent — resolving with the channel account id
  // would target a nonexistent agent's store and silently close nothing.
  let resetCount = 0;

  for (const agentId of listAgentIds(cfg)) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    // agentId selects the owner DB: with a fixed custom store every agent
    // resolves the same storePath, so storePath alone re-reads the default
    // owner. readOnly keeps this fleet-wide scan from creating or registering
    // agent databases while handling a thread archive/delete event.
    for (const { sessionKey, entry } of listSessionEntries({
      agentId,
      storePath,
      readOnly: true,
    })) {
      if (!sessionKeyContainsThreadId(sessionKey)) {
        continue;
      }
      const deleted = await deleteSessionEntry({
        archiveTranscript: true,
        expectedSessionId: entry.sessionId ?? null,
        expectedUpdatedAt: entry.updatedAt,
        sessionKey,
        storePath,
      });
      if (deleted) {
        resetCount += 1;
      }
    }
  }

  return resetCount;
}
