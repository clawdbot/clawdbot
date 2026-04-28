import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveStorePath, updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

/**
 * Marks every session entry in the store whose key contains {@link threadId}
 * as "reset" by setting `updatedAt` to 0.
 *
 * This mirrors how the daily / idle session reset works: zeroing `updatedAt`
 * makes `evaluateSessionFreshness` treat the session as stale on the next
 * inbound message, so the bot starts a fresh conversation without deleting
 * any on-disk transcript history.
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

  await updateSessionStore(storePath, (store) => {
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || !sessionKeyContainsThreadId(key)) {
        continue;
      }
      if (entry.updatedAt === 0) {
        continue;
      }
      // Setting updatedAt to 0 signals that this session is stale.
      // evaluateSessionFreshness will create a new session on the next message.
      entry.updatedAt = 0;
      resetCount += 1;
    }
    return resetCount;
  });

  return resetCount;
}
