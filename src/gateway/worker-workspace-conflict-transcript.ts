import type { Result } from "@openclaw/normalization-core/result";
import { getRuntimeConfig } from "../config/config.js";
import {
  appendSessionTranscriptReport,
  readLatestSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
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
    run: (target: SessionTranscriptWriteScope) => Promise<Result<T, unknown>>,
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
    const lostSession = () => {
      if (missingMessage) {
        throw new Error(`${missingMessage} lost session ${identity.sessionId}`);
      }
      return undefined;
    };
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    if (
      entry?.sessionId !== identity.sessionId ||
      (strictIdentity &&
        (target.canonicalKey !== identity.sessionKey || target.agentId !== identity.agentId))
    ) {
      return lostSession();
    }
    const result = await run({
      agentId: target.agentId,
      sessionId: identity.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    });
    return result.ok ? result.value : lostSession();
  }

  return {
    resolveWorkspaceResultConflict: async (identity: {
      sessionId: string;
      sessionKey: string;
      agentId: string;
    }) => {
      const transcriptEntry = await withWorkerTranscript(identity, (target) =>
        readLatestSessionTranscriptReport(target, [
          WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
          WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
        ]),
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
          (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
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
    },
    reportWorkspaceResultConflict: async (
      conflict: { sessionId: string; sessionKey: string; agentId: string } & (
        | { paths: string[]; stagedResultRef: string; totalCount: number }
        | { cleared: true }
      ),
    ) => {
      await withWorkerTranscript(
        conflict,
        (target) =>
          appendSessionTranscriptReport(target, {
            kind: "custom",
            customTypes: [
              WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
              WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
            ],
            selectReport: (latestConflictEntry) => {
              if ("cleared" in conflict) {
                if (
                  latestConflictEntry?.customType !== WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE
                ) {
                  return {
                    customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
                    content: "A later cloud workspace result superseded the previous conflict.",
                    display: false,
                  };
                }
                return undefined;
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
                return {
                  customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
                  content: formatWorkspaceConflictSummary(
                    projectedConflict.paths,
                    projectedConflict.stagedResultRef,
                    projectedConflict.totalCount,
                  ),
                  display: true,
                  details: projectedConflict,
                };
              }
              return undefined;
            },
          }),
        "Recovered cloud workspace conflict",
      );
    },
    reportWorkspaceResultRecoveryFailure: async (
      recovery: WorkerWorkspaceRecoveryFailureReport,
    ) => {
      await withWorkerTranscript(
        recovery,
        (target) =>
          appendSessionTranscriptReport(target, {
            kind: "custom",
            customTypes: [WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE],
            selectReport: (latestRecovery) => {
              const error = boundedWorkerError(recovery.error, 768);
              const content = `Cloud workspace recovery attempt failed: ${error}. OpenClaw preserved the result and will retry.`;
              if (latestRecovery?.content !== content) {
                return {
                  customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
                  content,
                  display: true,
                  details: { error },
                };
              }
              return undefined;
            },
          }),
        "Cloud workspace recovery",
        true,
      );
    },
  };
}
