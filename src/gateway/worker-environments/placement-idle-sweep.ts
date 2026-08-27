import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

class WorkerPlacementAutoSuspendBusyError extends Error {}

export function createWorkerPlacementIdleSweep(options: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatch: Pick<WorkerPlacementDispatchService, "reclaim">;
  getConfig: () => OpenClawConfig;
  info: (message: string) => void;
  warn: (message: string) => void;
  isPlacementOperationInFlight?: (sessionId: string) => boolean;
  getSessionWorkAdmissionCheck?: (
    identity: WorkerSessionPlacementIdentity,
  ) => Promise<() => boolean>;
  loadSessionRuntime?: () => Promise<
    Pick<typeof import("../session-utils.js"), "resolveGatewaySessionStoreTargetWithStore">
  >;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const loadSessionRuntime = options.loadSessionRuntime;
  const getSessionWorkAdmissionCheck =
    options.getSessionWorkAdmissionCheck ??
    (loadSessionRuntime &&
      (async ({ sessionId, sessionKey, agentId }: WorkerSessionPlacementIdentity) => {
        const sessionRuntime = await loadSessionRuntime();
        const target = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
          cfg: options.getConfig(),
          key: sessionKey,
          agentId,
          clone: false,
        });
        const identities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
        return () =>
          isSessionWorkAdmissionActive(target.storePath, identities) ||
          hasPendingFollowupQueueWork(identities);
      }));

  return {
    async sweep(): Promise<void> {
      const profiles = options.getConfig().cloudWorkers?.profiles;
      if (!profiles || !Object.values(profiles).some((profile) => profile.suspendAfter)) {
        return;
      }
      const pendingSessions = new Set([
        ...options.placements.listPendingWorkspaceResults().map((result) => result.sessionId),
        ...options.placements.listWorkspaceReconciliationOwners().map((owner) => owner.sessionId),
      ]);

      for (const placement of options.placements.listForReconcile()) {
        if (placement.state !== "active" || placement.turnClaim) {
          continue;
        }
        const environment = options.environments.get(placement.environmentId);
        const suspendAfter = environment && profiles[environment.profileId]?.suspendAfter;
        if (!suspendAfter) {
          continue;
        }
        // Placement activation and every turn-claim admission/release durably refresh this fact.
        if (now() - placement.updatedAtMs < parseDurationMs(suspendAfter)) {
          continue;
        }
        if (
          pendingSessions.has(placement.sessionId) ||
          options.placements.getPlacementMove(placement.sessionId) ||
          options.isPlacementOperationInFlight?.(placement.sessionId)
        ) {
          continue;
        }

        try {
          const request = {
            sessionId: placement.sessionId,
            sessionKey: placement.sessionKey,
            agentId: placement.agentId,
          };
          const hasSessionWork = await getSessionWorkAdmissionCheck?.(request);
          const current = options.placements.get(placement.sessionId);
          if (
            hasSessionWork?.() ||
            current?.state !== "active" ||
            current.generation !== placement.generation ||
            current.updatedAtMs !== placement.updatedAtMs ||
            current.turnClaim
          ) {
            continue;
          }
          const authorize = hasSessionWork
            ? () => {
                // Once drain starts, its lifecycle fence owns teardown; never abort it midway.
                if (
                  options.placements.get(placement.sessionId)?.state === "active" &&
                  hasSessionWork()
                ) {
                  throw new WorkerPlacementAutoSuspendBusyError();
                }
              }
            : undefined;
          await options.dispatch.reclaim(request, authorize);
          options.info(
            `auto-suspended ${placement.sessionKey} after ${suspendAfter} idle; wakes on next message`,
          );
        } catch (error) {
          if (error instanceof WorkerPlacementAutoSuspendBusyError) {
            continue;
          }
          options.warn(
            `Worker auto-suspend failed (${placement.sessionKey}): ${formatErrorMessage(error)}`,
          );
        }
      }
    },
  };
}
