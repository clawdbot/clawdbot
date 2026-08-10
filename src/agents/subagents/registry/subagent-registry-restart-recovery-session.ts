import { patchSessionEntry } from "../../../config/sessions/session-accessor.js";

export async function settleAcceptedRecoverySession(params: {
  attempts: number;
  childSessionKey: string;
  isOwnerCurrent: () => boolean;
  sessionId: string;
  sessionLifecycleRevision?: string;
  now: number;
  runId: string;
  storePath: string;
}): Promise<boolean> {
  let settled = false;
  await patchSessionEntry(
    { storePath: params.storePath, sessionKey: params.childSessionKey },
    (current) => {
      if (
        !params.isOwnerCurrent() ||
        current.sessionId !== params.sessionId ||
        (params.sessionLifecycleRevision !== undefined &&
          current.lifecycleRevision !== params.sessionLifecycleRevision)
      ) {
        return current;
      }
      if (current.abortedLastRun !== true) {
        settled = true;
        return current;
      }
      current.abortedLastRun = false;
      current.subagentRecovery = {
        automaticAttempts: Math.max(
          current.subagentRecovery?.automaticAttempts ?? 0,
          params.attempts + 1,
        ),
        lastAttemptAt: params.now,
        lastRunId: params.runId,
      };
      current.updatedAt = params.now;
      settled = true;
      return current;
    },
    {
      assertCommitAllowed: () => {
        if (!params.isOwnerCurrent()) {
          throw new Error("subagent restart recovery lifecycle retired before session commit");
        }
      },
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
  return settled;
}
