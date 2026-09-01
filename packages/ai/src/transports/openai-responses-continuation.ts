import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import { sha256Hex } from "./transport-utils.js";

// A real chat conversation's turns are commonly minutes to hours apart, well
// past the original 5-minute TTL -- continuation only ever engaged within one
// multi-round tool-calling turn (seconds between rounds), never across
// separate incoming messages, even though sessionId and connection identity
// are both stable across turns (confirmed by tracing the full call chain).
// Unchanged since #122194 introduced it; review only ever flagged the
// in-memory/process-local design generally, never the specific value.
const HTTP_CONTINUATION_IDLE_TTL_MS = 90 * 60 * 1000;
// A ready entry retains the full request/response baseline for as long as
// HTTP_CONTINUATION_IDLE_TTL_MS, and that TTL is now 18x longer (5m -> 90m).
// Without a capacity cap, a burst of concurrent sessions/connections could
// grow this process-wide map unbounded for the entire idle window. Claimed
// entries (in-flight, no retained baseline) don't count against the cap --
// they're already bounded by the request they represent.
const MAX_HTTP_CONTINUATION_READY_ENTRIES = 1000;
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
  // Instructions are rebuilt and sent on every request; exclude them from history matching.
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

function normalizeAssistantReplayInput(input: readonly unknown[], fromResponse = false): unknown[] {
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
    if (fromResponse && item.type === "function_call") {
      // Only provider output crosses terminal admission; sent arguments must retain real type edits.
      const args = parseJsonObjectPreservingUnsafeIntegers(stableItem.arguments);
      stableItem.arguments = args ? JSON.stringify(args) : stableItem.arguments;
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
      input: currentInput.slice(baselineLength),
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
      readySequence: number;
    }
  | { kind: "claimed"; sessionId: string; generation: number };

const httpContinuationEntries = new Map<string, HttpContinuationEntry>();
let nextHttpContinuationGeneration = 1;
// Separate monotonic counter for ready-entry commit order: Date.now() is not
// a unique completion order (two commits can land in the same millisecond,
// e.g. a reclaimed session key completing alongside another), so an
// eviction based on wall-clock time can pick a newer entry over an older
// one that happens to share a timestamp. A strictly incrementing sequence
// makes "oldest" unambiguous regardless of timing.
let nextHttpContinuationReadySequence = 1;

// Deterministic capacity policy for MAX_HTTP_CONTINUATION_READY_ENTRIES:
// evict the least-recently-committed ready entry, since that's the one
// least likely to be reused before its own idle TTL would have expired it
// anyway. Scans only ready entries (bounded by the cap itself), not the
// full map, so cost stays proportional to the configured limit.
function evictOldestReadyEntryAtCapacity(): void {
  let readyCount = 0;
  let oldestKey: string | undefined;
  let oldestReadySequence = Infinity;
  for (const [key, entry] of httpContinuationEntries) {
    if (entry.kind !== "ready") {
      continue;
    }
    readyCount += 1;
    if (entry.readySequence < oldestReadySequence) {
      oldestReadySequence = entry.readySequence;
      oldestKey = key;
    }
  }
  if (readyCount < MAX_HTTP_CONTINUATION_READY_ENTRIES || !oldestKey) {
    return;
  }
  const evicted = httpContinuationEntries.get(oldestKey);
  if (evicted?.kind === "ready") {
    clearTimeout(evicted.idleTimer);
  }
  httpContinuationEntries.delete(oldestKey);
}

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
        readySequence: nextHttpContinuationReadySequence++,
      } satisfies Extract<HttpContinuationEntry, { kind: "ready" }>;
      evictOldestReadyEntryAtCapacity();
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
