import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery-clear.js";
import type { SessionEntry } from "../config/sessions.js";

export function buildCheckpointSessionResetPatch(params: {
  entry: SessionEntry;
  sessionId: string;
  sessionFile: string;
}): Partial<SessionEntry> {
  // A checkpoint clone has a new transcript identity, so prior recovery ownership cannot follow it.
  return {
    ...buildMainSessionRecoveryClearPatch(params.entry),
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
  };
}
