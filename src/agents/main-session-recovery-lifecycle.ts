import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { mergeRestartRecoveryTerminalRunIds } from "../config/sessions/restart-recovery-state.js";
import {
  buildMainSessionRecoveryClearPatch,
  type MainRecoveryStateFields,
} from "./main-session-recovery-clear.js";

const MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON =
  "main-session restart recovery is tombstoned for this session";

type MainRecoveryLifecycleEvent = {
  runId?: string;
  lifecycleGeneration?: string;
  data?: { error?: unknown; phase?: unknown; stopReason?: unknown };
};

export function inspectMainSessionRecoveryHealth(entry: SessionEntry):
  | { status: "none" }
  | { status: "active" }
  | {
      status: "tombstoned";
      reason: string;
      repair: "clear_stale_abort" | null;
    } {
  const state = entry.mainRestartRecovery;
  if (!state) {
    return { status: "none" };
  }
  if (!state.tombstone) {
    return { status: "active" };
  }
  return {
    status: "tombstoned",
    reason: state.tombstone.reason.trim() || MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON,
    repair: entry.abortedLastRun === true ? "clear_stale_abort" : null,
  };
}

function lifecyclePhase(event: MainRecoveryLifecycleEvent): "start" | "end" | "error" | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

export function isMainSessionRecoveryLifecycleEvent(params: {
  entry?: Partial<Pick<SessionEntry, "restartRecoveryRuns">> | null;
  event: MainRecoveryLifecycleEvent;
}): boolean {
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const phase = lifecyclePhase(params.event);
  const interrupted = params.event.data?.stopReason === "restart";
  const matchesFence = Boolean(
    runId &&
    lifecycleGeneration &&
    params.entry?.restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    ),
  );
  return (
    matchesFence && (phase === "start" || ((phase === "end" || phase === "error") && interrupted))
  );
}

export function projectMainSessionRecoveryLifecycle(params: {
  currentLifecycleGeneration: string;
  entry?:
    | (Partial<MainRecoveryStateFields> &
        Pick<
          Partial<SessionEntry>,
          "restartRecoveryDeliveryRunId" | "restartRecoveryTerminalRunIds"
        >)
    | null;
  event: MainRecoveryLifecycleEvent;
  snapshotPatch: Partial<SessionEntry>;
}): { action: "suppress" } | { action: "apply"; patch: Partial<SessionEntry> } {
  if (params.entry?.mainRestartRecovery?.tombstone) {
    // Keep the operator boundary while allowing unrelated lifecycle status to settle.
    return isMainSessionRecoveryLifecycleEvent(params)
      ? { action: "suppress" }
      : {
          action: "apply",
          patch: {
            ...params.snapshotPatch,
            abortedLastRun: params.entry.abortedLastRun,
            restartRecoveryRuns: params.entry.restartRecoveryRuns,
            mainRestartRecovery: params.entry.mainRestartRecovery,
          },
        };
  }
  if (isMainSessionRecoveryLifecycleEvent(params)) {
    return { action: "suppress" };
  }
  const phase = lifecyclePhase(params.event);
  const settlesRecovery =
    (phase === "end" || phase === "error") && params.event.data?.stopReason !== "restart";
  const patch = { ...params.snapshotPatch };
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const runs = params.entry?.restartRecoveryRuns;
  const matchesFence = Boolean(
    runId &&
    lifecycleGeneration &&
    runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration),
  );
  const remaining = matchesFence
    ? runs?.filter((run) => run.runId !== runId || run.lifecycleGeneration !== lifecycleGeneration)
    : runs;
  if (settlesRecovery) {
    const foregroundClaims = params.entry?.mainRestartRecovery?.foregroundClaims;
    const foregroundOwnerClaimId =
      runId &&
      lifecycleGeneration &&
      lifecycleGeneration === params.currentLifecycleGeneration &&
      foregroundClaims?.lifecycleGeneration === lifecycleGeneration
        ? foregroundClaims.tokens.find(
            (claimId) => foregroundClaims.runIdsByClaimId?.[claimId] === runId,
          )
        : undefined;
    const remainingForegroundClaimIds = foregroundOwnerClaimId
      ? foregroundClaims!.tokens.filter((claimId) => claimId !== foregroundOwnerClaimId)
      : foregroundClaims?.tokens;
    const remainingForegroundRunIds = foregroundOwnerClaimId
      ? Object.fromEntries(
          Object.entries(foregroundClaims?.runIdsByClaimId ?? {}).filter(
            ([claimId]) => claimId !== foregroundOwnerClaimId,
          ),
        )
      : foregroundClaims?.runIdsByClaimId;
    const remainingForegroundClaims = remainingForegroundClaimIds?.length
      ? {
          lifecycleGeneration: foregroundClaims!.lifecycleGeneration,
          tokens: remainingForegroundClaimIds,
          ...(remainingForegroundRunIds && Object.keys(remainingForegroundRunIds).length > 0
            ? { runIdsByClaimId: remainingForegroundRunIds }
            : {}),
        }
      : undefined;
    const recoveryStateAfterForegroundSettlement = foregroundOwnerClaimId
      ? {
          ...params.entry!.mainRestartRecovery!,
          revision: params.entry!.mainRestartRecovery!.revision + 1,
          foregroundClaims: remainingForegroundClaims,
        }
      : params.entry?.mainRestartRecovery;
    const hasForegroundOwners = Boolean(
      remainingForegroundClaims?.lifecycleGeneration === params.currentLifecycleGeneration &&
      remainingForegroundClaims.tokens.length,
    );
    const reservation = params.entry?.mainRestartRecovery?.reservation;
    const hasCurrentReservation =
      reservation?.lifecycleGeneration === params.currentLifecycleGeneration;
    const hasCurrentOwner = hasForegroundOwners || hasCurrentReservation;
    if (!matchesFence) {
      // No terminal snapshot may settle a recovery row it cannot identify.
      return params.entry?.mainRestartRecovery || runs?.length
        ? { action: "suppress" }
        : { action: "apply", patch };
    }
    if (hasCurrentOwner) {
      // A terminal event may consume its own claim. Another owner still keeps
      // the aggregate live until that owner's terminal event or release.
      return {
        action: "apply",
        patch: {
          restartRecoveryRuns: remaining?.length ? remaining : undefined,
          restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
            params.entry?.restartRecoveryTerminalRunIds,
            [runId],
          ),
          ...(foregroundOwnerClaimId
            ? { mainRestartRecovery: recoveryStateAfterForegroundSettlement }
            : {}),
        },
      };
    }
    if (foregroundOwnerClaimId) {
      // This exact foreground run completed while its release lease was still
      // active. Its terminal snapshot is authoritative and consumes the cycle.
      Object.assign(patch, buildMainSessionRecoveryClearPatch(params.entry));
      return { action: "apply", patch };
    }
    if (
      !hasForegroundOwners &&
      !hasCurrentReservation &&
      params.entry?.abortedLastRun === true &&
      (remaining?.length ?? 0) > 0
    ) {
      return { action: "apply", patch: { restartRecoveryRuns: remaining } };
    }
    const recoveryDeliveryRunId =
      typeof params.entry?.restartRecoveryDeliveryRunId === "string"
        ? params.entry.restartRecoveryDeliveryRunId.trim()
        : undefined;
    if ((remaining?.length ?? 0) > 0 && recoveryDeliveryRunId !== runId) {
      // A different terminal run may consume only its own fence. Another
      // admitted recovery remains the durable owner of the aggregate.
      patch.abortedLastRun = false;
      patch.restartRecoveryRuns = remaining;
      patch.mainRestartRecovery = params.entry?.mainRestartRecovery;
      return { action: "apply", patch };
    }
    // An admitted recovery clears the interruption flag before it runs. With
    // no live owner left, that exact delivery run is the durable cleanup boundary.
    Object.assign(patch, buildMainSessionRecoveryClearPatch(params.entry));
    return { action: "apply", patch };
  }
  if (phase === "start" || !matchesFence || !remaining) {
    return { action: "apply", patch };
  }
  if (params.entry?.abortedLastRun === true && remaining.length > 0) {
    return { action: "apply", patch: { restartRecoveryRuns: remaining } };
  }
  patch.restartRecoveryRuns = remaining.length > 0 ? remaining : undefined;
  return { action: "apply", patch };
}
