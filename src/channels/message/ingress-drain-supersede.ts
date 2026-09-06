import { activeClaimKey, type ActiveHandlerState } from "./ingress-drain-state.js";
import type { ChannelIngressQueueClaim, ChannelIngressQueueRecord } from "./ingress-queue.js";

type SupersedeActiveStatesParams<TPayload, TMetadata> = {
  candidate: ChannelIngressQueueRecord<TPayload, TMetadata>;
  laneKey: string;
  activeByClaim: Map<string, ActiveHandlerState<TPayload, TMetadata>>;
  laneOwnerByKey: Map<string, ActiveHandlerState<TPayload, TMetadata>>;
  shouldSupersedePending?: (
    candidate:
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaim<TPayload, TMetadata>,
    pending: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ) => boolean | Promise<boolean>;
  clearStallTimer: (state: ActiveHandlerState<TPayload, TMetadata>) => void;
  completeClaim: (claim: ChannelIngressQueueClaim<TPayload, TMetadata>) => Promise<void>;
  formatError: (error: unknown) => string;
  log: (message: string) => void;
};

function isPreAdoptionState<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
): boolean {
  return (
    (state.phase === "dispatching" || state.phase === "deferred") &&
    !state.guillotined &&
    !state.superseded &&
    !state.isSettling()
  );
}

export function prepareIngressClaimDiscard<TPayload, TMetadata>(
  params: Pick<
    SupersedeActiveStatesParams<TPayload, TMetadata>,
    "activeByClaim" | "laneOwnerByKey" | "clearStallTimer" | "completeClaim" | "formatError" | "log"
  >,
  state: ActiveHandlerState<TPayload, TMetadata>,
): (() => Promise<void>) | undefined {
  if (
    params.activeByClaim.get(activeClaimKey(state.claim)) !== state ||
    !isPreAdoptionState(state) ||
    (state.occupiesLane && params.laneOwnerByKey.get(state.laneKey) !== state)
  ) {
    return undefined;
  }
  state.superseded = true;
  params.clearStallTimer(state);
  return async () => {
    state.abortController.abort(new Error("ingress-superseded"));
    try {
      await state.settleOnce(() => params.completeClaim(state.claim));
    } catch (error) {
      params.log(
        `ingress drain: failed to tombstone superseded event ${state.eventId}: ${params.formatError(error)}`,
      );
    }
  };
}

/** Supersede every accepted pre-adoption claim on one lane, including released deferrals. */
export async function supersedeActiveStatesIfNeeded<TPayload, TMetadata>(
  params: SupersedeActiveStatesParams<TPayload, TMetadata>,
): Promise<boolean> {
  const states = new Set(
    [...params.activeByClaim.values()].filter(
      (state) => state.laneKey === params.laneKey && isPreAdoptionState(state),
    ),
  );
  const laneOwner = params.laneOwnerByKey.get(params.laneKey);
  if (laneOwner && isPreAdoptionState(laneOwner)) {
    states.add(laneOwner);
  }

  let supersededAny = false;
  for (const pending of states) {
    if (!(await params.shouldSupersedePending?.(params.candidate, pending.claim))) {
      continue;
    }
    // Revalidate after the async predicate so a late true cannot kill adopted or replaced work.
    const discard = prepareIngressClaimDiscard(params, pending);
    if (!discard) {
      continue;
    }
    await discard();
    supersededAny = true;
  }
  return supersededAny && !params.laneOwnerByKey.has(params.laneKey);
}
