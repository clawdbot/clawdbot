import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery-clear.js";
import type { SessionEntry } from "../config/sessions.js";

export function buildForkedGatewaySessionEntry(
  entry: SessionEntry,
  fork: { sessionId: string; sessionFile: string },
): SessionEntry {
  // Replacing the transcript identity also replaces the recovery episode owned by the old row.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: fork.sessionId,
    sessionFile: fork.sessionFile,
    forkedFromParent: true,
    totalTokens: undefined,
    totalTokensFresh: false,
  };
}
