import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseInput,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { sha256Hex } from "./transport-utils.js";

const HTTP_CONTINUATION_IDLE_TTL_MS = 5 * 60 * 1000;
const TURN_HEADERS = new Set(["traceparent", "x-openclaw-turn-id", "x-openclaw-turn-attempt"]);

export type ResponsesContinuationRequest = Record<string, unknown> & {
  input?: ResponseInput;
  previous_response_id?: string;
};
export type ResponsesContinuationState = {
  lastRequest: ResponsesContinuationRequest;
  lastResponseId: string;
  lastResponseItems: ResponseOutputItem[];
};
export type ResponsesContinuationStatus =
  | "continued"
  | "explicit_previous_response_id"
  | "history_changed"
  | "history_shorter"
  | "no_previous_response"
  | "request_changed";

function jsonValuesEqual(left: object, right: object): boolean {
  // Round-trip first so stable key ordering retains JSON's omitted/undefined wire semantics.
  return (
    stableStringify(JSON.parse(JSON.stringify(left) as string)) ===
    stableStringify(JSON.parse(JSON.stringify(right) as string))
  );
}

function requestWithoutInput(request: ResponsesContinuationRequest): ResponsesContinuationRequest {
  // `instructions` (like `input`) carries the system prompt for every
  // non-Codex Responses request now, rebuilt fresh from live runtime state
  // on every attempt -- see resolveOpenAIResponsesInstructions in
  // openai-responses-params-internal.ts. It is sent on the wire on every
  // request regardless of continuation status (spread from the original
  // request below), so excluding it here loses no freshness; comparing it
  // would just move the same false-positive rejection this module already
  // guards against in `input` into `request_changed` instead.
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    instructions: _instructions,
    ...rest
  } = request;
  if (!isRecord(rest.metadata)) {
    return rest;
  }
  const metadata = Object.fromEntries(
    Object.entries(rest.metadata).filter(
      ([key]) => key !== "openclaw_turn_id" && key !== "openclaw_turn_attempt",
    ),
  );
  return { ...rest, metadata };
}

function normalizeAssistantReplayInput(input: readonly unknown[]): unknown[] {
  return input.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    if (item.type === "reasoning") {
      return { type: "reasoning" };
    }
    if (item.type !== "function_call" && !(item.type === "message" && item.role === "assistant")) {
      return item;
    }
    const { id: _id, status: _status, ...stableItem } = item;
    if (item.type === "message" && Array.isArray(stableItem.content)) {
      stableItem.content = stableItem.content.map((part) => {
        if (!isRecord(part) || part.type !== "output_text") {
          return part;
        }
        const { annotations: _annotations, logprobs: _logprobs, ...stablePart } = part;
        return stablePart;
      });
    }
    return stableItem;
  });
}

type ExplicitCacheContinuationInput = {
  input: ResponseInput;
  dynamicInput: ResponseInput;
  hasExplicitBoundary: boolean;
};

function isInstructionInputMessage(item: ResponseInputItem): item is ResponseInputItem.Message {
  return (
    item.type === "message" &&
    "role" in item &&
    (item.role === "developer" || item.role === "system") &&
    "content" in item &&
    Array.isArray(item.content)
  );
}

function isResponseInputText(
  part: ResponseInputItem.Message["content"][number],
): part is ResponseInputText {
  return part.type === "input_text";
}

// Full-history requests keep the volatile suffix after the explicit breakpoint for cache hits.
// Continuation compares only the stable message and appends the current suffix after the stored
// response, so changing runtime facts neither invalidate previous_response_id nor move before the
// cached prefix.
function splitExplicitCacheContinuationInput(input: ResponseInput): ExplicitCacheContinuationInput {
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || !isInstructionInputMessage(item)) {
      continue;
    }
    const boundaryIndex = item.content.findIndex(
      (part) => part.type === "input_text" && part.prompt_cache_breakpoint?.mode === "explicit",
    );
    if (boundaryIndex < 0) {
      continue;
    }
    const dynamicParts = item.content.slice(boundaryIndex + 1);
    if (!dynamicParts.every(isResponseInputText)) {
      return { input, dynamicInput: [], hasExplicitBoundary: false };
    }
    const stableMessage: ResponseInputItem.Message = {
      ...item,
      content: item.content.slice(0, boundaryIndex + 1),
    };
    const stableInput: ResponseInput = input.slice();
    stableInput[index] = stableMessage;
    const dynamicMessage: ResponseInputItem.Message = {
      ...item,
      content: dynamicParts,
    };
    return {
      input: stableInput,
      dynamicInput: dynamicParts.length > 0 ? [dynamicMessage] : [],
      hasExplicitBoundary: true,
    };
  }
  return { input, dynamicInput: [], hasExplicitBoundary: false };
}

export function resolveResponsesContinuationRequest(
  continuation: ResponsesContinuationState | undefined,
  request: ResponsesContinuationRequest,
): { request: ResponsesContinuationRequest; continuationStatus: ResponsesContinuationStatus } {
  if (!continuation) {
    return { request, continuationStatus: "no_previous_response" };
  }
  if (request.previous_response_id) {
    return { request, continuationStatus: "explicit_previous_response_id" };
  }
  if (
    !jsonValuesEqual(requestWithoutInput(request), requestWithoutInput(continuation.lastRequest))
  ) {
    return { request, continuationStatus: "request_changed" };
  }
  const canExtractExplicitCacheDynamicInput =
    request.instructions === undefined && continuation.lastRequest.instructions === undefined;
  const currentInput = canExtractExplicitCacheDynamicInput
    ? splitExplicitCacheContinuationInput(request.input ?? [])
    : { input: request.input ?? [], dynamicInput: [], hasExplicitBoundary: false };
  const previousInput = canExtractExplicitCacheDynamicInput
    ? splitExplicitCacheContinuationInput(continuation.lastRequest.input ?? [])
    : {
        input: continuation.lastRequest.input ?? [],
        dynamicInput: [],
        hasExplicitBoundary: false,
      };
  if (currentInput.hasExplicitBoundary !== previousInput.hasExplicitBoundary) {
    return { request, continuationStatus: "history_changed" };
  }
  if (previousInput.dynamicInput.length > 0 && currentInput.dynamicInput.length === 0) {
    return { request, continuationStatus: "history_changed" };
  }
  const baselineLength = previousInput.input.length + continuation.lastResponseItems.length;
  if (currentInput.input.length < baselineLength) {
    return { request, continuationStatus: "history_shorter" };
  }
  if (
    !jsonValuesEqual(
      normalizeAssistantReplayInput(currentInput.input.slice(0, previousInput.input.length)),
      normalizeAssistantReplayInput(previousInput.input),
    ) ||
    !jsonValuesEqual(
      normalizeAssistantReplayInput(
        currentInput.input.slice(previousInput.input.length, baselineLength),
      ),
      normalizeAssistantReplayInput(continuation.lastResponseItems),
    )
  ) {
    return { request, continuationStatus: "history_changed" };
  }
  return {
    request: {
      ...request,
      previous_response_id: continuation.lastResponseId,
      input: [...currentInput.dynamicInput, ...currentInput.input.slice(baselineLength)],
    },
    continuationStatus: "continued",
  };
}

type HttpContinuationEntry =
  | {
      kind: "ready";
      sessionId: string;
      generation: number;
      state: ResponsesContinuationState;
      idleTimer: ReturnType<typeof setTimeout>;
    }
  | { kind: "claimed"; sessionId: string; generation: number };

const httpContinuationEntries = new Map<string, HttpContinuationEntry>();
let nextHttpContinuationGeneration = 1;

type HttpContinuationIdentity = {
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string>;
};
type ContinuationResponse = { id: string; output: ResponseOutputItem[] };

function connectionIdentity(params: HttpContinuationIdentity): string {
  const headers = Object.entries(resolveAiTransportHeaderSentinels(params.headers) ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !TURN_HEADERS.has(name))
    .toSorted(([a], [b]) => a.localeCompare(b));
  return sha256Hex(
    JSON.stringify([
      getAiTransportHost().resolveSecretSentinel(params.apiKey),
      params.baseUrl,
      headers,
    ]),
  );
}

export function claimOpenAIResponsesHttpContinuation(
  params: HttpContinuationIdentity & {
    sessionId: string;
    request: ResponsesContinuationRequest;
  },
) {
  const key = `${params.sessionId}\0${connectionIdentity(params)}`;
  const previous = httpContinuationEntries.get(key);
  if (previous?.kind === "claimed") {
    return undefined;
  }
  if (previous?.kind === "ready") {
    clearTimeout(previous.idleTimer);
  }
  const generation = nextHttpContinuationGeneration++;
  const claimed = { kind: "claimed", sessionId: params.sessionId, generation } as const;
  httpContinuationEntries.set(key, claimed);
  const wireRequest = resolveResponsesContinuationRequest(
    previous?.kind === "ready" ? previous.state : undefined,
    params.request,
  ).request;
  return {
    request: wireRequest,
    commit: (effectiveRequest: ResponsesContinuationRequest, response: ContinuationResponse) => {
      if (httpContinuationEntries.get(key) !== claimed) {
        return;
      }
      const idleTimer = setTimeout(() => {
        const current = httpContinuationEntries.get(key);
        if (current?.kind === "ready" && current.generation === generation) {
          httpContinuationEntries.delete(key);
        }
      }, HTTP_CONTINUATION_IDLE_TTL_MS);
      idleTimer.unref?.();
      const ready = {
        ...claimed,
        kind: "ready",
        state: {
          lastRequest: effectiveRequest,
          lastResponseId: response.id,
          lastResponseItems: response.output,
        },
        idleTimer,
      } satisfies Extract<HttpContinuationEntry, { kind: "ready" }>;
      httpContinuationEntries.set(key, ready);
    },
    release: () => {
      if (httpContinuationEntries.get(key) === claimed) {
        httpContinuationEntries.delete(key);
      }
    },
  };
}

registerSessionResourceCleanup((sessionId) => {
  for (const [key, entry] of httpContinuationEntries) {
    if (!sessionId || entry.sessionId === sessionId) {
      if (entry.kind === "ready") {
        clearTimeout(entry.idleTimer);
      }
      httpContinuationEntries.delete(key);
    }
  }
});
