import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

export function createManagedWorktreeOwnerPolicy(
  cfg: OpenClawConfig,
  now: () => number = Date.now,
): {
  shouldProtectOwner: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  shouldRemoveOwner: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
} {
  const placementChecks = new Map<string, { sessionId?: string; assertCurrent: () => void }>();
  const state = (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const target = resolveSessionEntryAccessTarget({ cfg, sessionKey: ownerId });
      const entry = target.entry;
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const identities = [target.canonicalKey, ownerId, entry?.sessionId];
      if (
        isSessionWorkAdmissionActive(scope, identities) ||
        isSessionLifecycleMutationActive(scope, identities)
      ) {
        return "active";
      }
      let placementCheck = placementChecks.get(target.canonicalKey);
      if (placementCheck && placementCheck.sessionId !== entry?.sessionId) {
        return "active";
      }
      if (!placementCheck) {
        const context = resolveSessionWorkerPlacementContext();
        const store = context.workerSessionPlacementService;
        if (!store?.listForReconcile) {
          return "active";
        }
        // Missing session metadata cannot erase a durable remote worker's ownership.
        const related = () =>
          store.listForReconcile!()
            .filter((placement) => placement.sessionKey === target.canonicalKey)
            .map((placement) => placement.sessionId)
            .toSorted();
        const initial = related();
        const checks = [
          ...new Set([...initial, ...(entry?.sessionId ? [entry.sessionId] : [])]),
        ].map((sessionId) => prepareSessionWorkerPlacementMutationCheck({ context, sessionId }));
        const assertCurrent = () => {
          if (JSON.stringify(related()) !== JSON.stringify(initial)) {
            throw new Error("worktree worker placement changed during cleanup");
          }
          for (const check of checks) {
            check();
          }
        };
        placementCheck = { sessionId: entry?.sessionId, assertCurrent };
        placementChecks.set(target.canonicalKey, placementCheck);
      }
      placementCheck.assertCurrent();
      if (!entry || entry.archivedAt !== undefined) {
        return "retired";
      }
      const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
      return activityAt > 0 && now() - activityAt <= IDLE_GC_MS ? "active" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Re-read at each mutation guard: an unarchive or new turn can invalidate an earlier cleanup decision.
  return {
    shouldProtectOwner: (kind, id) => state(kind, id) === "active",
    shouldRemoveOwner: (kind, id) => state(kind, id) === "retired",
  };
}
