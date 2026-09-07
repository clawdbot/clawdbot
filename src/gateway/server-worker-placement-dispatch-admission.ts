import { getRuntimeConfig } from "../config/config.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementSessionRuntime } from "./server-worker-placement-reclaim.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchAdmission,
} from "./worker-environments/service-contract.js";

export function createGatewayWorkerDispatchAdmission(
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>,
): WorkerPlacementDispatchAdmission {
  return async (request, run, authorize) => {
    const runtime = await loadSessionRuntime();
    const resolve = () =>
      runtime.resolveGatewaySessionStoreTargetWithStore({
        cfg: getRuntimeConfig(),
        key: request.sessionKey,
        agentId: request.agentId,
        clone: false,
        exactRead: true,
      });
    const target = resolve();
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
    const revision = entry?.lifecycleRevision ?? null;
    const controller = new AbortController();
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, target.canonicalKey, ...target.storeKeys, request.sessionId],
      onInterrupt: (reason) => controller.abort(reason),
      assertAllowed: () => {
        authorize?.();
        controller.signal.throwIfAborted();
        const current = resolve();
        const currentEntry = runtime.resolveCanonicalSessionEntryFromStoreKeys(
          current.store,
          current.storeKeys,
        );
        if (
          current.storePath !== target.storePath ||
          current.canonicalKey !== target.canonicalKey ||
          current.agentId !== target.agentId ||
          currentEntry?.sessionId !== request.sessionId ||
          (currentEntry.lifecycleRevision ?? null) !== revision ||
          currentEntry.archivedAt !== undefined
        ) {
          throw new WorkerPlacementAdmissionTargetError(
            `Session ${request.sessionKey} changed before cloud worker dispatch. Retry.`,
          );
        }
      },
    });
    try {
      // Reserve before the placement queue, and exclude this owner from its own local barrier.
      // Release only after dispatch's canonical failure cleanup has settled the provider child.
      return await admission.run(() => run(controller.signal));
    } finally {
      admission.release();
    }
  };
}
