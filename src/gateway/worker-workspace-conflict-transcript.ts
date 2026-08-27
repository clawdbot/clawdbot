import { SessionManager } from "../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../config/config.js";
import { withTranscriptWriteTransaction } from "../config/sessions/session-accessor.js";
import { boundedWorkerError } from "./worker-environments/worker-error.js";
import {
  formatWorkspaceConflictSummary,
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
  type WorkerWorkspaceRecoveryFailureReport,
} from "./worker-environments/workspace-conflicts.js";

export function createWorkerWorkspaceConflictTranscriptHandlers(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetWithStore: typeof import("./session-utils.js").resolveGatewaySessionStoreTargetWithStore;
  }>,
) {
  async function withWorkerTranscript<T>(
    identity: Pick<WorkerWorkspaceRecoveryFailureReport, "sessionId" | "sessionKey" | "agentId">,
    run: (manager: SessionManager) => T,
    missingMessage?: string,
    strictIdentity = false,
  ): Promise<T | undefined> {
    const runtime = await loadSessionRuntime();
    const target = runtime.resolveGatewaySessionStoreTargetWithStore({
      cfg: getRuntimeConfig(),
      key: identity.sessionKey,
      agentId: identity.agentId,
      clone: false,
    });
    return await withTranscriptWriteTransaction(
      {
        agentId: target.agentId,
        sessionId: identity.sessionId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      },
      (transcriptTarget) => {
        const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(
          target.store,
          target.storeKeys,
        );
        if (
          entry?.sessionId !== identity.sessionId ||
          (strictIdentity &&
            (target.canonicalKey !== identity.sessionKey || target.agentId !== identity.agentId))
        ) {
          if (missingMessage) {
            throw new Error(`${missingMessage} lost session ${identity.sessionId}`);
          }
          return undefined;
        }
        return run(SessionManager.open(transcriptTarget));
      },
    );
  }

  function latestWorkspaceReport(manager: SessionManager, ...customTypes: string[]) {
    for (const entry of manager.getBranch().toReversed()) {
      if (entry.type === "custom_message" && customTypes.includes(entry.customType)) {
        return entry;
      }
    }
    return undefined;
  }

  return {
    resolveWorkspaceResultConflict: async (identity: {
      sessionId: string;
      sessionKey: string;
      agentId: string;
    }) =>
      await withWorkerTranscript(identity, (manager) => {
        const transcriptEntry = latestWorkspaceReport(
          manager,
          WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
          WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
        );
        if (transcriptEntry?.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
          return undefined;
        }
        const details = transcriptEntry.details as
          | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
          | undefined;
        if (
          Array.isArray(details?.paths) &&
          details.paths.length > 0 &&
          details.paths.every(
            (entryPath): entryPath is string =>
              typeof entryPath === "string" && entryPath.length > 0,
          ) &&
          typeof details.stagedResultRef === "string" &&
          (details.totalCount === undefined ||
            (Number.isSafeInteger(details.totalCount) &&
              (details.totalCount as number) >= details.paths.length)) &&
          /^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef)
        ) {
          return projectWorkspaceResultConflict(
            details.paths,
            details.stagedResultRef,
            details.totalCount as number | undefined,
          );
        }
        return undefined;
      }),
    reportWorkspaceResultConflict: async (
      conflict: { sessionId: string; sessionKey: string; agentId: string } & (
        | { paths: string[]; stagedResultRef: string; totalCount: number }
        | { cleared: true }
      ),
    ) => {
      await withWorkerTranscript(
        conflict,
        (manager) => {
          const latestConflictEntry = latestWorkspaceReport(
            manager,
            WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
            WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
          );
          if ("cleared" in conflict) {
            if (latestConflictEntry?.customType !== WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE) {
              manager.appendCustomMessageEntry(
                WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
                "A later cloud workspace result superseded the previous conflict.",
                false,
              );
            }
            return;
          }
          const projectedConflict = projectWorkspaceResultConflict(
            conflict.paths,
            conflict.stagedResultRef,
            conflict.totalCount,
          );
          const details = latestConflictEntry?.details as
            | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
            | undefined;
          const alreadyReported =
            latestConflictEntry?.customType === WORKSPACE_CONFLICT_TRANSCRIPT_TYPE &&
            details?.stagedResultRef === projectedConflict.stagedResultRef &&
            details.totalCount === projectedConflict.totalCount &&
            Array.isArray(details.paths) &&
            JSON.stringify(details.paths) === JSON.stringify(projectedConflict.paths);
          if (!alreadyReported) {
            manager.appendCustomMessageEntry(
              WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
              formatWorkspaceConflictSummary(
                projectedConflict.paths,
                projectedConflict.stagedResultRef,
                projectedConflict.totalCount,
              ),
              true,
              projectedConflict,
            );
          }
        },
        "Recovered cloud workspace conflict",
      );
    },
    reportWorkspaceResultRecoveryFailure: async (
      recovery: WorkerWorkspaceRecoveryFailureReport,
    ) => {
      await withWorkerTranscript(
        recovery,
        (manager) => {
          const latestRecovery = latestWorkspaceReport(
            manager,
            WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          );
          const error = boundedWorkerError(recovery.error, 768);
          const content = `Cloud workspace recovery attempt failed: ${error}. OpenClaw preserved the result and will retry.`;
          if (latestRecovery?.content !== content) {
            manager.appendCustomMessageEntry(
              WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
              content,
              true,
              { error },
            );
          }
        },
        "Cloud workspace recovery",
        true,
      );
    },
  };
}
