import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import { stableStringify } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  readProviderPromptAccountingContext,
  type ProviderPromptAccountingContext,
  withoutProviderPromptAccountingContext,
} from "../../llm/providers/stream-wrappers/provider-prompt-accounting.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { estimateProviderPayloadTokenPressure } from "./provider-payload-pressure.js";

type ProviderPromptSnapshot = {
  scopeDigest: string;
  digest: string;
  byteWeight: number;
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
  contextAdmission?: (
    model: Model,
    context: Context,
    accountingContext?: ProviderPromptAccountingContext,
  ) => Context;
  /** Runs once the final payload passed every pre-dispatch check, right before transport send. */
  promptDispatch?: () => void;
  /** Set when the current attempt's transport invoked its payload hook at least once. */
  attemptPayloadObserved?: boolean;
  /** Observation result of the previous attempt; lets admission settle silent transports. */
  previousAttemptPayloadObserved?: boolean;
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

class ProviderPromptFinalPayloadOverflowError extends Error {
  constructor(estimatedTokens: number, contextTokenBudget: number) {
    super(
      "Context overflow: final provider payload exceeds the model context window after outbound " +
        `transforms (estimatedTokens=${estimatedTokens} contextTokenBudget=${contextTokenBudget}).`,
    );
    this.name = "ProviderPromptFinalPayloadOverflowError";
  }
}

const digest = (serialized: string) => crypto.createHash("sha256").update(serialized).digest("hex");

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const state = providerPromptStates.get(runId) ?? {};
  providerPromptStates.set(runId, state);
  return state;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Installs run-scoped admission and dispatch hooks at the innermost provider boundary. */
export function installProviderPromptContextAdmission(
  state: ProviderPromptState,
  admission: NonNullable<ProviderPromptState["contextAdmission"]>,
  dispatch?: ProviderPromptState["promptDispatch"],
): () => void {
  const previousAdmission = state.contextAdmission;
  const previousDispatch = state.promptDispatch;
  state.contextAdmission = admission;
  state.promptDispatch = dispatch;
  return () => {
    if (state.contextAdmission === admission) {
      state.contextAdmission = previousAdmission;
    }
    if (state.promptDispatch === dispatch) {
      state.promptDispatch = previousDispatch;
    }
  };
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
  if (rejected?.scopeDigest === candidate.scopeDigest && rejected.digest === candidate.digest) {
    throw new ProviderPromptRetryNoProgressError(candidate.byteWeight);
  }
}

/**
 * Rejects a final request body that post-admission transforms grew past the full context window.
 * Admission budgets with reserve and a safety margin, so an unmargined estimate beyond the entire
 * window is unreachable from any admitted context and always means outbound payload drift.
 */
function assertFinalProviderPromptWithinBudget(params: {
  payload: unknown;
  effectiveContextTokenBudget: number;
}): void {
  const estimatedTokens = estimateProviderPayloadTokenPressure(params.payload);
  if (estimatedTokens > params.effectiveContextTokenBudget) {
    throw new ProviderPromptFinalPayloadOverflowError(
      estimatedTokens,
      params.effectiveContextTokenBudget,
    );
  }
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

/** Hashes the post-onPayload body for context-retry admission. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
}): StreamFn {
  return async (model, context, options) => {
    params.state.lastAttempt = undefined; // Custom transports must not leave a stale candidate.
    params.state.previousAttemptPayloadObserved = params.state.attemptPayloadObserved;
    params.state.attemptPayloadObserved = false;
    const accountingContext = readProviderPromptAccountingContext(options);
    const admittedContext =
      context && typeof context === "object" && params.state.contextAdmission
        ? params.state.contextAdmission(model, context, accountingContext)
        : context;
    const originalOnPayload = options?.onPayload;
    const observedOptions = withoutProviderPromptAccountingContext({
      ...options,
      onPayload: async (payload, payloadModel) => {
        params.state.attemptPayloadObserved = true;
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        const snapshot = snapshotProviderPrompt({
          model: payloadModel,
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        assertProviderPromptRetryProgress(params.state, snapshot);
        params.state.lastAttempt = snapshot;
        assertFinalProviderPromptWithinBudget({
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        // Every pre-dispatch check passed and the transport sends next; admitted
        // candidates may only be adopted from this point on.
        params.state.promptDispatch?.();
        return finalPayload;
      },
    });
    if (params.recordEvent) {
      responsesPromptObserver.set(observedOptions, (observation) =>
        params.recordEvent?.("provider.prompt.observed", { ...observation }),
      );
    }
    return params.streamFn(model, admittedContext, observedOptions);
  };
}
