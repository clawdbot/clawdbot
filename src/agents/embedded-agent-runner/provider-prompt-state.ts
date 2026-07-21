import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { stableStringify } from "../stable-stringify.js";

type ProviderPromptSnapshot = {
  scopeDigest: string;
  digest: string;
  byteWeight: number;
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
};

const PROVIDER_PROMPT_STATES_KEY = Symbol.for("openclaw.providerPromptStates");
const providerPromptStates = resolveGlobalSingleton(
  PROVIDER_PROMPT_STATES_KEY,
  () => new Map<string, ProviderPromptState>(),
);

class ProviderPromptRetryNoProgressError extends Error {
  constructor(payloadBytes: number) {
    super(
      "Context overflow: refusing to resend the byte-identical provider payload after a " +
        `context rejection (payloadBytes=${payloadBytes}).`,
    );
    this.name = "ProviderPromptRetryNoProgressError";
  }
}

function digest(serialized: string): string {
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function createProviderPromptState(): ProviderPromptState {
  return {};
}

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const existing = providerPromptStates.get(runId);
  if (existing) {
    return existing;
  }
  const created = createProviderPromptState();
  providerPromptStates.set(runId, created);
  return created;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Captures the final provider request identity without retaining payload content. */
function snapshotProviderPrompt(params: {
  model: Model;
  payload: unknown;
  effectiveContextTokenBudget: number;
}): ProviderPromptSnapshot {
  const scope = stableStringify({
    provider: params.model.provider,
    api: params.model.api,
    model: params.model.id,
    baseUrl: params.model.baseUrl,
    effectiveContextTokenBudget: params.effectiveContextTokenBudget,
  });
  const serialized = stableStringify(params.payload);
  return {
    scopeDigest: digest(scope),
    digest: digest(serialized),
    byteWeight: Buffer.byteLength(serialized),
  };
}

/** Rejects only an exact replay of the last provider-rejected request body. */
function assertProviderPromptRetryProgress(
  state: ProviderPromptState,
  candidate: ProviderPromptSnapshot,
): void {
  const rejected = state.lastRejected;
  if (!rejected || rejected.scopeDigest !== candidate.scopeDigest) {
    return;
  }
  if (rejected.digest === candidate.digest) {
    throw new ProviderPromptRetryNoProgressError(candidate.byteWeight);
  }
}

function beginProviderPromptAttempt(state: ProviderPromptState): void {
  // A transport that does not implement onPayload must not leave a stale body
  // eligible to be marked as the current provider rejection.
  state.lastAttempt = undefined;
}

function recordProviderPromptAttempt(
  state: ProviderPromptState,
  snapshot: ProviderPromptSnapshot,
): void {
  state.lastAttempt = snapshot;
}

export function markLastProviderPromptContextRejected(
  state: ProviderPromptState,
): ProviderPromptSnapshot | undefined {
  const attempted = state.lastAttempt;
  if (attempted) {
    state.lastRejected = attempted;
  }
  return attempted;
}

/** Observes the request body after every provider wrapper and caller payload hook. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
}): StreamFn {
  return async (model, context, options) => {
    beginProviderPromptAttempt(params.state);
    const originalOnPayload = options?.onPayload;
    const stream = await params.streamFn(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        const snapshot = snapshotProviderPrompt({
          model: payloadModel,
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        assertProviderPromptRetryProgress(params.state, snapshot);
        recordProviderPromptAttempt(params.state, snapshot);
        return finalPayload;
      },
    });
    return stream;
  };
}
