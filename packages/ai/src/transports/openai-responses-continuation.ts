import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { quoteUnsafeIntegerLiterals } from "./json-unsafe-integers.js";
import {
  normalizeOpenAIResponsesFunctionCallId,
  shouldNormalizeOpenAIResponsesToolCallId,
  splitOpenAIFunctionCallPairing,
} from "./openai-responses-tool-call-id-shape.js";
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

// A function_call's `arguments` is a JSON-encoded string, not a nested
// object -- jsonValuesEqual only normalizes key order at the *parsed* level,
// so two byte-different-but-semantically-identical encodings (e.g. a
// re-`JSON.stringify` picking up different whitespace) would otherwise read
// as a real content change. Round-trip through parse/stringify so only the
// actual argument values are compared; leave non-JSON strings untouched.
// quoteUnsafeIntegerLiterals runs first: plain JSON.parse silently rounds any
// integer literal past Number.MAX_SAFE_INTEGER, so two genuinely DIFFERENT
// unsafe integers could otherwise parse to the same JS number and wrongly
// compare equal, sending a stale delta instead of the real changed argument.
function normalizeFunctionCallArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.stringify(JSON.parse(quoteUnsafeIntegerLiterals(value)));
  } catch {
    return value;
  }
}

// Canonicalizes a call_id/fc_id through the exact same shaping replay applies
// (normalizeOpenAIResponsesToolCallIds in embedded-agent-helpers, mirrored
// here as normalizeOpenAIResponsesFunctionCallId since packages/ai cannot
// import from src/agents). Idempotent on an already-reshaped id -- it only
// touches ids that don't already match the provider's own call_*/fc_* shape
// -- so a raw provider id and the client's replayed reshaping of that same
// id both canonicalize to the same value. This replaces a blanket call_id
// drop: dropping it entirely would treat *any* changed function-call id as
// the same known reshape, masking a genuinely different tool call.
function canonicalizeReplayedCallId(value: unknown): unknown {
  return typeof value === "string" ? normalizeOpenAIResponsesFunctionCallId(value) : value;
}

// A cached raw provider `function_call` still carries its separate,
// un-reshaped `call_id` and item `id` fields exactly as the provider
// returned them. Replay pairs those two into one `call_id|fc_id` string
// before reshaping (normalizeOpenAIResponsesToolCallIds, mirrored by
// normalizeOpenAIResponsesFunctionCallId), then the request builder splits
// the reshaped pair back into separate wire fields -- so the replayed
// call_id already reflects a hash of the *pair*, not of call_id alone.
// Canonicalizing only the bare cached call_id (dropping id) hashes a
// different input and never matches, permanently forcing history_changed.
function canonicalizeCachedCallId(callId: unknown, itemId: unknown): unknown {
  if (typeof callId !== "string") {
    return callId;
  }
  const paired = typeof itemId === "string" && itemId ? `${callId}|${itemId}` : callId;
  // Already-valid call_*/fc_* ids (the common case once a provider itself
  // returns provider-shaped ids) never get reshaped by replay either --
  // mirror that exact idempotent short-circuit, or a validly-shaped pair
  // would be needlessly re-hashed here into a value replay never produces.
  if (!shouldNormalizeOpenAIResponsesToolCallId(paired)) {
    return callId;
  }
  return splitOpenAIFunctionCallPairing(normalizeOpenAIResponsesFunctionCallId(paired)).callId;
}

function normalizeAssistantReplayInput(input: readonly unknown[], isCachedRaw = false): unknown[] {
  return input.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    if (item.type === "reasoning") {
      return { type: "reasoning" };
    }
    if (
      item.type !== "function_call" &&
      item.type !== "function_call_output" &&
      !(item.type === "message" && item.role === "assistant")
    ) {
      return item;
    }
    const { id: rawId, status: _status, ...stableItem } = item;
    if ("call_id" in stableItem) {
      stableItem.call_id = isCachedRaw
        ? canonicalizeCachedCallId(stableItem.call_id, rawId)
        : canonicalizeReplayedCallId(stableItem.call_id);
    }
    if (item.type === "function_call" && "arguments" in stableItem) {
      stableItem.arguments = normalizeFunctionCallArguments(stableItem.arguments);
    }
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

// The wire-bound delta (sent under previous_response_id) still carries
// whatever call_id the client's own replay reshaping produced for a
// function_call_output referencing a call from continuation.lastResponseItems
// -- that's the exact id mismatch normalizeAssistantReplayInput tolerates
// for the eligibility comparison above, but the comparison result is never
// sent. Rewrite it back to the raw id the provider actually returned (and
// this module cached) before the delta goes out, so a server that
// reconstructs full history from its own cached copy of that raw response
// (e.g. a proxy virtualizing previous_response_id server-side) sees a
// function_call_output whose call_id matches the function_call it's pairing
// against, instead of an orphaned id it silently drops.
function restoreRawCallIdsInDelta(
  delta: readonly unknown[],
  cachedResponseItems: readonly unknown[],
): unknown[] {
  const rawCallIdByReshaped = new Map<string, string>();
  for (const item of cachedResponseItems) {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.call_id !== "string") {
      continue;
    }
    const rawCallId = item.call_id;
    // Mirror the eligibility comparison's pairing: the delta's call_id was
    // reshaped from the paired call_id|id, not the bare call_id alone.
    const reshaped = canonicalizeCachedCallId(rawCallId, item.id);
    if (typeof reshaped === "string" && reshaped !== rawCallId) {
      rawCallIdByReshaped.set(reshaped, rawCallId);
    }
  }
  if (rawCallIdByReshaped.size === 0) {
    return delta as unknown[];
  }
  return delta.map((item) => {
    if (!isRecord(item) || typeof item.call_id !== "string") {
      return item;
    }
    const rawCallId = rawCallIdByReshaped.get(item.call_id);
    return rawCallId ? { ...item, call_id: rawCallId } : item;
  });
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
  const currentInput = request.input ?? [];
  const previousInput = continuation.lastRequest.input ?? [];
  const baselineLength = previousInput.length + continuation.lastResponseItems.length;
  if (currentInput.length < baselineLength) {
    return { request, continuationStatus: "history_shorter" };
  }
  if (
    !jsonValuesEqual(
      normalizeAssistantReplayInput(currentInput.slice(0, previousInput.length)),
      normalizeAssistantReplayInput(previousInput),
    ) ||
    !jsonValuesEqual(
      normalizeAssistantReplayInput(currentInput.slice(previousInput.length, baselineLength)),
      normalizeAssistantReplayInput(continuation.lastResponseItems, true),
    )
  ) {
    return { request, continuationStatus: "history_changed" };
  }
  return {
    request: {
      ...request,
      previous_response_id: continuation.lastResponseId,
      input: restoreRawCallIdsInDelta(
        currentInput.slice(baselineLength),
        continuation.lastResponseItems,
      ) as ResponseInput,
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
