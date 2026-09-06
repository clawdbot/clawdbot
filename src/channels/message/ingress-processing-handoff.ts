import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createRetainedTimeout } from "../../node-host/with-timeout.js";
import type { CommandQueueTaskDeadline } from "../../process/command-queue.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type IngressProcessingClaim = {
  live: boolean;
  start: () => boolean;
  onClose: Set<() => void>;
};

type ProcessingKind = "memory" | "compaction";
type ProcessingPhase = {
  kind: ProcessingKind;
  timeout: ReturnType<typeof createRetainedTimeout>;
  signal: AbortSignal;
};
type ProcessingScope = {
  claims: readonly IngressProcessingClaim[];
  phase?: ProcessingPhase;
  closed: boolean;
};

function processingState() {
  return resolveGlobalSingleton(Symbol.for("openclaw.ingressProcessingState"), () => ({
    claims: new WeakMap<AbortSignal, readonly IngressProcessingClaim[]>(),
    scopes: new AsyncLocalStorage<ProcessingScope | undefined>(),
  }));
}

/** Only the drain can register a live claim; retirement invalidates retained aggregates. */
export function bindIngressProcessingClaim(
  signal: AbortSignal,
  owner: { start: () => boolean },
): () => void {
  const claim: IngressProcessingClaim = { live: true, start: owner.start, onClose: new Set() };
  const { claims } = processingState();
  const binding = [claim];
  claims.set(signal, binding);
  return () => {
    claim.live = false;
    for (const onClose of claim.onClose) {
      onClose();
    }
    claim.onClose.clear();
    if (claims.get(signal) === binding) {
      claims.delete(signal);
    }
  };
}

/** Existing lifecycle composition carries claim identity without changing its public shape. */
export function inheritIngressProcessingClaims(
  target: AbortSignal,
  sources: readonly AbortSignal[],
): void {
  const { claims } = processingState();
  const inherited = [...new Set(sources.flatMap((source) => claims.get(source) ?? []))];
  if (inherited.length > 0) {
    claims.set(target, inherited);
  }
}

/** Capture only the explicit source. A nested unrelated turn must not inherit its scheduler. */
export async function withIngressProcessingScope<T>(
  source: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const state = processingState();
  const claims = source ? state.claims.get(source)?.filter((claim) => claim.live) : undefined;
  const scope: ProcessingScope | undefined = claims?.length ? { claims, closed: false } : undefined;
  const closeRetiredScope = () => {
    if (scope && !scope.claims.some((claim) => claim.live)) {
      scope.closed = true;
      scope.phase?.timeout.close();
    }
  };
  for (const claim of scope?.claims ?? []) {
    claim.onClose.add(closeRetiredScope);
  }
  return await state.scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      finishIngressProcessing();
      for (const claim of scope?.claims ?? []) {
        claim.onClose.delete(closeRetiredScope);
      }
    }
  });
}

export function finishIngressProcessing(): void {
  const scope = processingState().scopes.getStore();
  if (scope) {
    scope.closed = true;
    scope.phase?.timeout.close();
  }
}

/** A phase retains its deadline after work returns, until its successor or adoption owns it. */
export async function withIngressProcessingPhase<T>(
  params: { kind: ProcessingKind; timeoutMs: number; abortSignal?: AbortSignal },
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const scope = processingState().scopes.getStore();
  if (
    !scope ||
    scope.closed ||
    !scope.claims.some((claim) => claim.live) ||
    !Number.isFinite(params.timeoutMs) ||
    params.timeoutMs <= 0 ||
    params.timeoutMs >= MAX_TIMER_TIMEOUT_MS
  ) {
    return await run(params.abortSignal);
  }
  params.abortSignal?.throwIfAborted();
  const timeout = createRetainedTimeout(
    params.timeoutMs,
    params.kind === "memory" ? "Memory flush" : "Compaction",
  );
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeout.signal])
    : timeout.signal;
  const previous = scope.phase;
  scope.phase = { kind: params.kind, timeout, signal };
  // Arm the successor before retiring either the previous phase or ingress watchdog.
  previous?.timeout.close();
  for (const claim of scope.claims) {
    if (claim.live && !claim.start()) {
      claim.live = false;
    }
  }
  return await timeout.race(racePromiseWithAbortSignal(run(signal), params.abortSignal));
}

/** Admission still uses the last maintenance deadline after its engine has returned. */
export async function awaitIngressProcessing<T>(
  run: (abortSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const scope = processingState().scopes.getStore();
  const phase = scope?.closed ? undefined : scope?.phase;
  if (!phase) {
    return await run(undefined);
  }
  phase.signal.throwIfAborted();
  return await phase.timeout.race(racePromiseWithAbortSignal(run(phase.signal), phase.signal));
}

/** Durable admission can finish resolving its transcript after the reply wait has timed out. */
export function captureIngressProcessingCommitFence(): (() => void) | undefined {
  const scope = processingState().scopes.getStore();
  const phase = scope?.phase;
  if (!scope || scope.closed || !phase) {
    return undefined;
  }
  return () => {
    phase.signal.throwIfAborted();
    if (scope.closed || scope.phase !== phase) {
      throw new Error("Channel ingress admission is no longer active");
    }
  };
}

/** Runtime callbacks capture the phase before queueing; late callbacks cannot affect its successor. */
export function captureIngressProcessingDeadline(kind: ProcessingKind):
  | {
      reset: () => void;
      update: (deadline: CommandQueueTaskDeadline | undefined) => void;
      close: () => void;
    }
  | undefined {
  const scope = processingState().scopes.getStore();
  const phase = scope?.phase;
  if (!scope || scope.closed || phase?.kind !== kind) {
    return undefined;
  }
  let closed = false;
  const isCurrent = () =>
    !closed && !scope.closed && scope.phase === phase && !phase.signal.aborted;
  return {
    reset: () => {
      if (isCurrent()) {
        phase.timeout.reset();
      }
    },
    update: (deadline) => {
      if (isCurrent()) {
        if (deadline) {
          phase.timeout.setDeadline(deadline);
        } else {
          phase.timeout.reset();
        }
      }
    },
    close: () => {
      if (isCurrent()) {
        // Runtime completion is progress. Cleanup retains a configured, bounded window.
        phase.timeout.reset();
      }
      closed = true;
    },
  };
}
