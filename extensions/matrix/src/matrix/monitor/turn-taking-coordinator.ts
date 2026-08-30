import { createMatrixTurnTakingFreshness } from "./turn-taking-coordinator-freshness.js";
import { createMatrixTurnTakingParticipation } from "./turn-taking-coordinator-participation.js";
import { createMatrixPreviewCore } from "./turn-taking-coordinator-preview-core.js";
import { createMatrixPreviewIngress } from "./turn-taking-coordinator-preview-ingress.js";
import { createMatrixPreviewOutbound } from "./turn-taking-coordinator-preview-outbound.js";
import { createMatrixTurnTakingState } from "./turn-taking-coordinator-state.js";
import type { RegisteredMonitor } from "./turn-taking-coordinator-types.js";
export {
  MATRIX_ACTIVE_PREVIEW_TTL_MS,
  MATRIX_TERMINAL_REPLAY_TTL_MS,
  resolveMatrixTurnTakingConfig,
} from "./turn-taking-coordinator-types.js";

export function createMatrixTurnTakingCoordinator(options?: {
  now?: () => number;
  maxEarlyPreviewRedactions?: number;
}) {
  const state = createMatrixTurnTakingState(options);
  const freshness = createMatrixTurnTakingFreshness(state);
  const participation = createMatrixTurnTakingParticipation(state, freshness);
  const previewCore = createMatrixPreviewCore(state);
  const previewIngress = createMatrixPreviewIngress({
    state,
    core: previewCore,
    freshness,
    participation,
  });
  const previewOutbound = createMatrixPreviewOutbound({
    state,
    core: previewCore,
    freshness,
  });

  return {
    configureMonitorAccess(
      accountId: string,
      prepareAccess: NonNullable<RegisteredMonitor["prepareAccess"]>,
    ): void {
      const monitor = state.monitors.get(accountId);
      if (monitor && monitor.prepareAccess !== prepareAccess) {
        state.decisions.clear();
        monitor.prepareAccess = prepareAccess;
      }
    },
    registerMonitor(registration: RegisteredMonitor): () => void {
      // Decisions belong to the current set of receiver policies and routes.
      state.decisions.clear();
      state.monitors.set(registration.accountId, registration);
      return () => {
        if (state.monitors.get(registration.accountId) !== registration) {
          return;
        }
        state.monitors.delete(registration.accountId);
        state.decisions.clear();
        if (state.monitors.size === 0) {
          state.clear();
        }
      };
    },

    invalidateMembership(roomId: string): void {
      const suffix = `\u0000${roomId}`;
      for (const key of state.roomMembership.keys()) {
        if (key === roomId || key.endsWith(suffix)) {
          state.roomMembership.delete(key);
        }
      }
    },

    beginIngressObservation: freshness.beginIngressObservation,
    observeMessage: freshness.observeMessage,
    currentSequence: state.currentSequence,
    readFreshness: freshness.readFreshness,
    observeOutboundPreview: previewOutbound.observeOutboundPreview,
    observeOutboundStandaloneFinalPart: previewOutbound.observeOutboundStandaloneFinalPart,
    abandonOutboundStandaloneFinal: previewOutbound.abandonOutboundStandaloneFinal,
    observePreviewRedaction: previewOutbound.observePreviewRedaction,
    interceptPreviewEvent: previewIngress.interceptPreviewEvent,
    authorizePreviewObservation: previewIngress.authorizePreviewObservation,
    createFreshnessGate: freshness.createFreshnessGate,
    resolveEligibility: participation.resolveEligibility,
    decideParticipation: participation.decideParticipation,
  };
}

export const matrixTurnTakingCoordinator = createMatrixTurnTakingCoordinator();

export type MatrixTurnTakingCoordinator = ReturnType<typeof createMatrixTurnTakingCoordinator>;
