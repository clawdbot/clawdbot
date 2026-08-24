import {
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";

const CONTINUATION_RESET_ABORT_REASON = "session-reset";

type ActiveContinuationDispatchClaim = {
  controller: AbortController;
  flowId?: string;
  lifecycleGeneration: string;
};

const activeDispatchClaims = new Map<string, Set<ActiveContinuationDispatchClaim>>();

export function registerContinuationDispatchClaim(params: {
  sessionKey: string;
  flowId?: string;
}): {
  controller: AbortController;
  isActive: () => boolean;
  release: () => void;
} {
  const claim: ActiveContinuationDispatchClaim = {
    controller: new AbortController(),
    ...(params.flowId ? { flowId: params.flowId } : {}),
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
  };
  const claims =
    activeDispatchClaims.get(params.sessionKey) ?? new Set<ActiveContinuationDispatchClaim>();
  claims.add(claim);
  activeDispatchClaims.set(params.sessionKey, claims);
  return {
    controller: claim.controller,
    isActive: () => activeDispatchClaims.get(params.sessionKey)?.has(claim) === true,
    release: () => {
      claims.delete(claim);
      if (claims.size === 0 && activeDispatchClaims.get(params.sessionKey) === claims) {
        activeDispatchClaims.delete(params.sessionKey);
      }
    },
  };
}

export function abortContinuationDispatchClaims(sessionKey: string): void {
  const claims = activeDispatchClaims.get(sessionKey);
  activeDispatchClaims.delete(sessionKey);
  for (const claim of claims ?? []) {
    claim.controller.abort(CONTINUATION_RESET_ABORT_REASON);
  }
}

function evictPriorLifecycleDispatchClaims(lifecycleGeneration: string): void {
  for (const [sessionKey, claims] of activeDispatchClaims) {
    for (const claim of claims) {
      if (claim.lifecycleGeneration !== lifecycleGeneration) {
        claim.controller.abort("gateway-lifecycle-rotated");
        claims.delete(claim);
      }
    }
    if (claims.size === 0) {
      activeDispatchClaims.delete(sessionKey);
    }
  }
}

registerAgentEventLifecycleRotationHandler(
  "continuation-dispatch-claims",
  evictPriorLifecycleDispatchClaims,
);

export function resetContinuationDispatchClaimsForTests(): void {
  for (const sessionKey of activeDispatchClaims.keys()) {
    abortContinuationDispatchClaims(sessionKey);
  }
}
