import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  parseWorkspaceInspectionResult,
  WORKSPACE_INSPECTION_COMMAND,
  type WorkspaceInspectionInput,
  type WorkspaceInspectionResult,
} from "../../worker/workspace-inspection-protocol.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

type LoadedSession = ReturnType<typeof loadGatewaySessionEntryReadOnly>;
type Operation = WorkspaceInspectionInput["operation"];

/** Repository identity never resolves through the Gateway's local workspace defaults. */
export function resolveRepositoryWorkspaceAccess(
  loaded: LoadedSession,
  context?: GatewayRequestContext,
) {
  const entry = loaded.entry;
  const workspaceId = entry?.repositoryWorkspaceId;
  if (!workspaceId) {
    return undefined;
  }
  const store = getSessionRepositoryWorkspaceStore();
  const repository = store.get(workspaceId);
  if (
    !repository ||
    repository.agentId !== loaded.agentId ||
    repository.sessionKey !== loaded.canonicalKey
  ) {
    throw new Error("The cloud repository workspace is unavailable for this session.");
  }
  if (!entry?.sessionId) {
    throw new Error("The cloud repository session is unavailable.");
  }
  const sessionId = entry.sessionId;
  const assertSession = (expectedRevision?: number) => {
    const current = loadGatewaySessionEntryReadOnly(loaded.canonicalKey, {
      agentId: repository.agentId,
    });
    const source = store.get(workspaceId);
    if (
      current.entry?.sessionId !== sessionId ||
      current.entry?.repositoryWorkspaceId !== workspaceId ||
      (current.entry.lifecycleRevision ?? null) !== (entry.lifecycleRevision ?? null) ||
      current.entry.archivedAt !== entry.archivedAt ||
      source?.agentId !== repository.agentId ||
      source.sessionKey !== repository.sessionKey ||
      (expectedRevision !== undefined && source.revision !== expectedRevision)
    ) {
      throw new Error("The cloud repository workspace owner changed; refresh this session.");
    }
  };
  const placements = context?.workerSessionPlacementService;
  const environments = context?.workerEnvironmentService;
  const placement = placements?.getMany([sessionId]).get(sessionId);
  if (placement?.state !== "active" || !environments) {
    return {
      kind: "stored" as const,
      repository,
      store,
      assertCurrent: () => assertSession(repository.revision),
    };
  }
  const assertCurrent = (expectedRevision?: number) => {
    assertSession(expectedRevision);
    const current = placements?.getMany([sessionId]).get(sessionId);
    const environment = environments.get(placement.environmentId);
    if (
      current?.state !== "active" ||
      current.agentId !== repository.agentId ||
      current.sessionKey !== repository.sessionKey ||
      current.generation !== placement.generation ||
      current.environmentId !== placement.environmentId ||
      current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
      current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
      environment?.state !== "attached" ||
      environment.ownerEpoch !== placement.activeOwnerEpoch ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== sessionId
    ) {
      throw new Error("The cloud workspace placement changed; refresh this session.");
    }
  };
  return {
    kind: "active" as const,
    repository,
    async inspect<T extends Operation>(
      operation: T,
      request: Omit<
        Extract<WorkspaceInspectionInput, { operation: T }>,
        "operation" | "sessionKey"
      >,
      authorize?: () => void,
    ): Promise<WorkspaceInspectionResult<T>> {
      const assertAuthorized = () => {
        assertCurrent(operation === "set" ? undefined : repository.revision);
        authorize?.();
      };
      const run = async (assertOperation = assertAuthorized) => {
        assertOperation();
        const tunnel = await environments.startTunnel({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        assertOperation();
        if (
          tunnel.environmentId !== placement.environmentId ||
          tunnel.ownerEpoch !== placement.activeOwnerEpoch
        ) {
          throw new Error("The cloud workspace tunnel owner changed.");
        }
        const result = await tunnel.runWorkspaceCommand({
          argv: [WORKSPACE_INSPECTION_COMMAND],
          input: JSON.stringify({ ...request, operation, sessionKey: repository.sessionKey }),
          transportRetry: operation === "set" ? "never" : "idempotent",
          assertCurrent: assertOperation,
          timeoutMs: 30_000,
        });
        assertOperation();
        if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
          throw new Error(
            "Cloud workspace inspection failed; reconnect the session runner and retry.",
          );
        }
        return parseWorkspaceInspectionResult(operation, result.stdout);
      };
      // Stop, sharing changes, and identity rewrites use this same lifecycle owner.
      // They must not rotate authority while an admitted editor save is in flight.
      if (operation !== "set") {
        return await run();
      }
      const mutationService = context?.workerRepositoryWorkspaceMutationService;
      if (!mutationService) {
        throw new Error("Cloud repository editing is unavailable; restart the Gateway and retry.");
      }
      return await runExclusiveSessionLifecycleMutation({
        scope: loaded.storePath,
        identities: [loaded.canonicalKey, ...loaded.storeKeys, sessionId],
        run: () =>
          mutationService.mutate({
            sessionId,
            sessionKey: repository.sessionKey,
            agentId: repository.agentId,
            assertCurrent: assertAuthorized,
            mutate: async (assertMutationCurrent) => {
              const value = await run(() => {
                assertAuthorized();
                assertMutationCurrent();
              });
              return { changed: "status" in value && value.status === "updated", value };
            },
          }),
      });
    },
  };
}
