// Discord plugin module implements thread session close behavior.
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
  accountId: string;
  threadId: string;
}): Promise<number> {
  const { cfg, accountId, threadId } = params;

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

  // Resolve the store file. We pass `accountId` as `agentId` here to mirror
  // how other Discord subsystems resolve their per-account sessions stores.
  const storePath = resolveStorePath(cfg.session?.store, { agentId: accountId });

  let resetCount = 0;

  for (const { sessionKey, entry } of listSessionEntries({ storePath })) {
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

  return resetCount;
}
