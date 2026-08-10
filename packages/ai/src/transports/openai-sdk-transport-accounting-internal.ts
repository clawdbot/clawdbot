import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AiModelFetchProvenance } from "../host.js";
import {
  createModelTransportAttemptAuthority,
  createModelTransportEventScope,
  type ModelTransportAttemptAuthority,
  type ModelTransportEventScope,
  type ModelTransportOutcome,
} from "./model-transport-accounting-internal.js";
import type { OpenAIResponsesStreamEvent } from "./openai-responses-stream-internal.js";

const OPENAI_SDK_TRANSPORT = "responses-sdk";
export const OPENAI_SDK_DEFAULT_MAX_RETRIES = 2;

type OpenAISdkTransportScope = {
  events: ModelTransportEventScope;
  callerSignal?: AbortSignal;
  maxRetries: number;
  submissionReason: "initial" | "payload_recovery";
  phaseFetchInvocationCount: number;
  phaseAwaitingSubmission: boolean;
  activeAttempt?: ModelTransportAttemptAuthority;
  pendingResponseAttempt?: ModelTransportAttemptAuthority;
  pendingResponseStatus?: number;
  currentInvocationZeroSubmissionObserved: boolean;
  currentInvocationAttemptKey?: object;
  fetchProvenance?: AiModelFetchProvenance;
};

function readHeaderValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name)?.trim() || undefined;
  }
  if (!isRecord(headers)) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first.trim() || undefined : undefined;
  }
  return undefined;
}

function readOpenAIModelHeader(headers: unknown): string | undefined {
  return readHeaderValue(headers, "openai-model") ?? readHeaderValue(headers, "x-openai-model");
}

function readEventServingModelHeader(event: OpenAIResponsesStreamEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const response = isRecord(record.response) ? record.response : undefined;
  return readOpenAIModelHeader(response?.headers) ?? readOpenAIModelHeader(record.headers);
}

function readEventResponseModel(event: OpenAIResponsesStreamEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const response = isRecord(record.response) ? record.response : undefined;
  return typeof response?.model === "string" ? response.model.trim() || undefined : undefined;
}

function shouldRetryResponse(response: Response): boolean {
  const shouldRetryHeader = response.headers.get("x-should-retry");
  if (shouldRetryHeader === "true") {
    return true;
  }
  if (shouldRetryHeader === "false") {
    return false;
  }
  return response.status === 408 || response.status === 409 || response.status === 429
    ? true
    : response.status >= 500;
}

export function createOpenAISdkAccountingFetch(params: {
  model: Model;
  callId?: string;
  scopeId: string;
  callerSignal?: AbortSignal;
  maxRetries?: number;
}): {
  onFetchDispatch: () => void;
  scope: OpenAISdkTransportScope;
  wrapGuardedFetch: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
} {
  const scope: OpenAISdkTransportScope = {
    events: createModelTransportEventScope(params),
    callerSignal: params.callerSignal,
    maxRetries: params.maxRetries ?? OPENAI_SDK_DEFAULT_MAX_RETRIES,
    submissionReason: "initial",
    phaseFetchInvocationCount: 0,
    phaseAwaitingSubmission: true,
    currentInvocationZeroSubmissionObserved: false,
  };
  return {
    scope,
    onFetchDispatch() {
      if (scope.fetchProvenance !== "dispatch_attested") {
        return;
      }
      const reason = scope.phaseFetchInvocationCount === 1 ? scope.submissionReason : "retry";
      scope.events.observeInvocation({
        attemptKey: (scope.currentInvocationAttemptKey ??= {}),
        transport: OPENAI_SDK_TRANSPORT,
        reason,
      });
      if (scope.activeAttempt) {
        return;
      }
      scope.phaseAwaitingSubmission = false;
      const pendingAttempt = scope.events.startAttempt({
        transport: OPENAI_SDK_TRANSPORT,
        reason,
      });
      scope.activeAttempt = createModelTransportAttemptAuthority({
        events: scope.events,
        pendingAttempt,
        requestedModel: params.model.id,
        transport: OPENAI_SDK_TRANSPORT,
      });
    },
    wrapGuardedFetch(fetch) {
      return async (input, init) => {
        scope.phaseFetchInvocationCount += 1;
        scope.currentInvocationAttemptKey = {};
        scope.phaseAwaitingSubmission = true;
        scope.currentInvocationZeroSubmissionObserved = false;
        try {
          const response = await fetch(input, init);
          const pending = scope.activeAttempt;
          if (pending) {
            const servingModel = readOpenAIModelHeader(response.headers);
            pending.observeServingModel(servingModel);
            if (response.ok) {
              scope.pendingResponseAttempt = pending;
              scope.pendingResponseStatus = response.status;
            } else {
              pending.finish("failed", response.status);
            }
          }
          scope.activeAttempt = undefined;
          scope.phaseAwaitingSubmission =
            !response.ok &&
            scope.phaseFetchInvocationCount <= scope.maxRetries &&
            shouldRetryResponse(response);
          return response;
        } catch (error) {
          const fetchInvoked = scope.activeAttempt !== undefined;
          const outcome = scope.callerSignal?.aborted ? "aborted" : "failed";
          if (
            scope.fetchProvenance === "dispatch_attested" &&
            !fetchInvoked &&
            !scope.currentInvocationZeroSubmissionObserved
          ) {
            scope.currentInvocationZeroSubmissionObserved = true;
            scope.events.observeZeroSubmission({
              transport: OPENAI_SDK_TRANSPORT,
              outcome,
            });
          }
          scope.activeAttempt?.finish(outcome);
          scope.activeAttempt = undefined;
          scope.pendingResponseAttempt?.finish(outcome, scope.pendingResponseStatus);
          scope.pendingResponseAttempt = undefined;
          scope.pendingResponseStatus = undefined;
          const retryPending =
            !scope.callerSignal?.aborted && scope.phaseFetchInvocationCount <= scope.maxRetries;
          scope.phaseAwaitingSubmission = retryPending;
          if (retryPending) {
            // The failed invocation is accounted above. A backoff abort belongs
            // to the next route phase, which has not submitted yet.
            scope.currentInvocationZeroSubmissionObserved = false;
          }
          throw error;
        }
      };
    },
  };
}

export function setOpenAISdkFetchProvenance(
  scope: OpenAISdkTransportScope,
  provenance: AiModelFetchProvenance | undefined,
): void {
  scope.fetchProvenance = provenance;
}

export function markOpenAISdkPayloadRecovery(scope: OpenAISdkTransportScope): void {
  scope.submissionReason = "payload_recovery";
  scope.phaseFetchInvocationCount = 0;
  scope.currentInvocationAttemptKey = undefined;
  scope.phaseAwaitingSubmission = true;
  scope.currentInvocationZeroSubmissionObserved = false;
}

export function finishOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
  statusCode?: number,
): void {
  const pending = scope.pendingResponseAttempt;
  if (!pending) {
    return;
  }
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  pending.finish(outcome, statusCode ?? responseStatus);
}

export function observeOpenAISdkServingModelEvent(
  scope: OpenAISdkTransportScope,
  event: OpenAIResponsesStreamEvent,
): void {
  const pending = scope.pendingResponseAttempt;
  if (!pending) {
    return;
  }
  const headerModel = readEventServingModelHeader(event);
  if (headerModel) {
    pending.observeServingModel(headerModel);
    return;
  }
  if (pending.readServingModel() === undefined) {
    pending.observeServingModel(readEventResponseModel(event));
  }
}

export function readOpenAISdkResponseModel(scope: OpenAISdkTransportScope): string | undefined {
  return scope.pendingResponseAttempt?.readServingModel();
}

export function failOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
): void {
  const pending = scope.pendingResponseAttempt;
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  if (pending) {
    pending.finish(outcome, responseStatus);
    return;
  }
  if (
    scope.fetchProvenance === "dispatch_attested" &&
    scope.phaseAwaitingSubmission &&
    !scope.currentInvocationZeroSubmissionObserved
  ) {
    scope.currentInvocationZeroSubmissionObserved = true;
    scope.events.observeZeroSubmission({
      transport: OPENAI_SDK_TRANSPORT,
      outcome: scope.callerSignal?.aborted || outcome === "aborted" ? "aborted" : "failed",
    });
  }
}
