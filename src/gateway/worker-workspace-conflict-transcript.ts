import { SessionManager } from "../agents/sessions/session-manager.js";
import { getRuntimeConfig } from "../config/config.js";
import { withTranscriptWriteTransaction } from "../config/sessions/session-accessor.js";
import {
  formatWorkspaceConflictSummary,
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";

export function createWorkerWorkspaceConflictTranscriptHandlers(
  loadSessionRuntime: () => Promise<{
    resolveFreshestSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveFreshestSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetWithStore: typeof import("./session-utils.js").resolveGatewaySessionStoreTargetWithStore;
  }>,
) {
  return {
    resolveWorkspaceResultConflict: async (identity: {
      sessionId: string;
      sessionKey: string;
      agentId: string;
    }) => {
      const {
        resolveFreshestSessionEntryFromStoreKeys,
        resolveGatewaySessionStoreTargetWithStore,
      } = await loadSessionRuntime();
      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg: getRuntimeConfig(),
        key: identity.sessionKey,
        agentId: identity.agentId,
        clone: false,
      });
      const entry = resolveFreshestSessionEntryFromStoreKeys(target.store, target.storeKeys);
      if (entry?.sessionId !== identity.sessionId) {
        return undefined;
      }
      return await withTranscriptWriteTransaction(
        {
          agentId: target.agentId,
          sessionId: identity.sessionId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        },
        (transcriptTarget) => {
          for (const transcriptEntry of SessionManager.open(transcriptTarget)
            .getBranch()
            .toReversed()) {
            if (transcriptEntry.type !== "custom_message") {
              continue;
            }
            if (transcriptEntry.customType === WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE) {
              return undefined;
            }
            if (transcriptEntry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
              continue;
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
          }
          return undefined;
        },
      );
    },
    reportWorkspaceResultConflict: async (
      conflict: { sessionId: string; sessionKey: string; agentId: string } & (
        | { paths: string[]; stagedResultRef: string; totalCount: number }
        | { cleared: true }
      ),
    ) => {
      const {
        resolveFreshestSessionEntryFromStoreKeys,
        resolveGatewaySessionStoreTargetWithStore,
      } = await loadSessionRuntime();
      const target = resolveGatewaySessionStoreTargetWithStore({
        cfg: getRuntimeConfig(),
        key: conflict.sessionKey,
        agentId: conflict.agentId,
        clone: false,
      });
      const entry = resolveFreshestSessionEntryFromStoreKeys(target.store, target.storeKeys);
      if (entry?.sessionId !== conflict.sessionId) {
        throw new Error(`Recovered cloud workspace conflict lost session ${conflict.sessionId}`);
      }
      await withTranscriptWriteTransaction(
        {
          agentId: target.agentId,
          sessionId: conflict.sessionId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        },
        (transcriptTarget) => {
          const manager = SessionManager.open(transcriptTarget);
          const latestConflictEntry = manager
            .getBranch()
            .toReversed()
            .find(
              (transcriptEntry) =>
                transcriptEntry.type === "custom_message" &&
                (transcriptEntry.customType === WORKSPACE_CONFLICT_TRANSCRIPT_TYPE ||
                  transcriptEntry.customType === WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE),
            );
          if ("cleared" in conflict) {
            if (
              latestConflictEntry?.type !== "custom_message" ||
              latestConflictEntry.customType !== WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE
            ) {
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
          const details =
            latestConflictEntry?.type === "custom_message"
              ? (latestConflictEntry.details as
                  | { paths?: unknown; stagedResultRef?: unknown; totalCount?: unknown }
                  | undefined)
              : undefined;
          const alreadyReported =
            latestConflictEntry?.type === "custom_message" &&
            latestConflictEntry.customType === WORKSPACE_CONFLICT_TRANSCRIPT_TYPE &&
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
      );
    },
  };
}
