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
  digest: string;
  byteWeight: number;
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
  contextAdmission?: (
    context: Context,
    accountingContext?: ProviderPromptAccountingContext,
  ) => Context;
  /** Commits the admitted candidate and reports whether one was pending. */
  promptAcknowledged?: () => boolean;
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
  constructor(estimatedTokens: number, promptTokenBudget: number, contextTokenBudget: number) {
    super(
      "Context overflow: final provider payload exceeds the prompt budget after outbound " +
        `transforms (estimatedTokens=${estimatedTokens} ` +
        `promptTokenBudget=${promptTokenBudget} contextTokenBudget=${contextTokenBudget}).`,
    );
    this.name = "ProviderPromptFinalPayloadOverflowError";
  }
}

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const state = providerPromptStates.get(runId) ?? {};
  providerPromptStates.set(runId, state);
  return state;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Installs run-scoped admission and acknowledgement hooks at the provider boundary. */
export function installProviderPromptContextAdmission(
  state: ProviderPromptState,
  admission: NonNullable<ProviderPromptState["contextAdmission"]>,
  acknowledged?: ProviderPromptState["promptAcknowledged"],
): () => void {
  const previousAdmission = state.contextAdmission;
  const previousAcknowledged = state.promptAcknowledged;
  state.contextAdmission = admission;
  state.promptAcknowledged = acknowledged;
  return () => {
    if (state.contextAdmission === admission) {
      state.contextAdmission = previousAdmission;
    }
    if (state.promptAcknowledged === acknowledged) {
      state.promptAcknowledged = previousAcknowledged;
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
    digest: crypto.createHash("sha256").update(scope).update("\0").update(serialized).digest("hex"),
    byteWeight: Buffer.byteLength(serialized),
  };
}

/** Rejects only an exact replay of the last provider-rejected request body. */
function assertProviderPromptRetryProgress(
  state: ProviderPromptState,
  candidate: ProviderPromptSnapshot,
): void {
  const rejected = state.lastRejected;
  if (rejected?.digest === candidate.digest) {
    throw new ProviderPromptRetryNoProgressError(candidate.byteWeight);
  }
}

/**
 * Rejects a final request body that post-admission transforms grew past the reserve-aware prompt
 * budget. Admission budgets with reserve and a safety margin, so an unmargined estimate beyond
 * the same reserve-aware budget means outbound payload drift (for example extra_body replacing
 * messages or tools), never an honestly admitted prompt.
 */
function assertFinalProviderPromptWithinBudget(params: {
  payload: unknown;
  effectiveContextTokenBudget: number;
  reserveTokens?: number;
}): void {
  const promptTokenBudget = Math.max(
    1,
    params.effectiveContextTokenBudget - Math.max(0, Math.floor(params.reserveTokens ?? 0)),
  );
  const estimatedTokens = estimateProviderPayloadTokenPressure(params.payload);
  if (estimatedTokens > promptTokenBudget) {
    throw new ProviderPromptFinalPayloadOverflowError(
      estimatedTokens,
      promptTokenBudget,
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
  reserveTokens?: number;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
}): StreamFn {
  return async (model, context, options) => {
    params.state.lastAttempt = undefined; // Custom transports must not leave a stale candidate.
    const accountingContext = readProviderPromptAccountingContext(options);
    const admittedContext =
      context && typeof context === "object" && params.state.contextAdmission
        ? params.state.contextAdmission(context, accountingContext)
        : context;
    const originalOnPayload = options?.onPayload;
    const originalOnResponse = options?.onResponse;
    const observedOptions = withoutProviderPromptAccountingContext({
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
        params.state.lastAttempt = snapshot;
        assertFinalProviderPromptWithinBudget({
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
          reserveTokens: params.reserveTokens,
        });
        return finalPayload;
      },
      onResponse: async (response, responseModel) => {
        // The provider accepted the request, so this candidate is no longer speculative.
        if (params.state.promptAcknowledged?.()) {
          params.recordEvent?.("provider.prompt.admitted", {
            byteWeight: params.state.lastAttempt?.byteWeight,
          });
        }
        await originalOnResponse?.(response, responseModel);
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
