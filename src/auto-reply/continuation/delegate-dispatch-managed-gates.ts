import {
  assertDelegateArtifactPolicyPrepared,
  MissingDelegateArtifactPolicyError,
  UnavailableDelegateArtifactPolicyError,
} from "../../agents/delegate-artifacts.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { PendingContinuationDelegate } from "./types.js";

type ManagedRuntimeGate = {
  enabled: boolean;
  crossSessionTargeting: "disabled" | "enabled";
};

type UnavailablePolicyDelegate = {
  delegate: PendingContinuationDelegate;
  reason: "inactive or expired" | "missing";
  error: Error;
};

export function partitionManagedDelegatesForRuntime(params: {
  delegates: PendingContinuationDelegate[];
  sessionKey: string;
  runtime: ManagedRuntimeGate;
  defer: (delegate: PendingContinuationDelegate, currentStep?: string) => boolean;
}): {
  dispatchableDelegates: PendingContinuationDelegate[];
  unavailablePolicyDelegates: UnavailablePolicyDelegate[];
} {
  const dispatchableDelegates: PendingContinuationDelegate[] = [];
  const unavailablePolicyDelegates: UnavailablePolicyDelegate[] = [];
  for (const delegate of params.delegates) {
    const managed =
      delegate.returnOptions?.artifacts === "optional" ||
      delegate.returnOptions?.artifacts === "required";
    if (managed && delegate.flowId) {
      try {
        assertDelegateArtifactPolicyPrepared(delegate.flowId);
      } catch (error) {
        if (
          error instanceof MissingDelegateArtifactPolicyError ||
          error instanceof UnavailableDelegateArtifactPolicyError
        ) {
          unavailablePolicyDelegates.push({
            delegate,
            reason:
              error instanceof UnavailableDelegateArtifactPolicyError
                ? "inactive or expired"
                : "missing",
            error,
          });
          continue;
        }
        throw error;
      }
    }
    if (managed && !params.runtime.enabled) {
      params.defer(delegate);
      continue;
    }
    if (
      managed &&
      params.runtime.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, params.sessionKey)
    ) {
      params.defer(delegate, "Deferred until cross-session continuation targeting is re-enabled");
      continue;
    }
    dispatchableDelegates.push(delegate);
  }
  return { dispatchableDelegates, unavailablePolicyDelegates };
}
