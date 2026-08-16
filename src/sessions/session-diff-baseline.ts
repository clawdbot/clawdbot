import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureSessionDiffBaseline } from "./session-diff.js";

export async function ensureSessionDiffBaseline(params: {
  cwd: string;
  entry: SessionEntry;
  force?: boolean;
  isNewSession: boolean;
  sessionKey: string;
  storePath: string;
}): Promise<SessionEntry> {
  if (
    !params.isNewSession ||
    params.entry.execNode ||
    (!params.force && params.entry.createdVia !== "operator") ||
    params.entry.sessionDiffBaseline?.sessionId === params.entry.sessionId
  ) {
    return params.entry;
  }
  const baseline = await captureSessionDiffBaseline({
    cwd: params.cwd,
    sessionId: params.entry.sessionId,
  });
  if (!baseline) {
    return params.entry;
  }
  const persisted = await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (current) => {
      if (
        current.sessionId !== params.entry.sessionId ||
        current.sessionDiffBaseline?.sessionId === current.sessionId
      ) {
        return null;
      }
      return { sessionDiffBaseline: baseline };
    },
    { preserveActivity: true, skipMaintenance: true },
  );
  return persisted ?? params.entry;
}
