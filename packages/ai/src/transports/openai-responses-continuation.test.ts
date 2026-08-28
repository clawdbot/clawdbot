import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";

const firstUser = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "first" }],
};
const assistantOutput = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [
    {
      type: "output_text",
      text: "answer",
      annotations: [
        {
          type: "url_citation",
          url: "https://example.test/source",
          title: "source",
          start_index: 0,
          end_index: 6,
        },
      ],
      logprobs: [{ token: "answer", logprob: -0.1, bytes: [], top_logprobs: [] }],
    },
  ],
};

function continuationState(): ResponsesContinuationState {
  return {
    lastRequest: {
      model: "gpt-5.6-luna",
      store: true,
      max_output_tokens: undefined,
      metadata: { stable: "yes", openclaw_turn_id: "turn-1", openclaw_turn_attempt: "1" },
      input: [firstUser] as never,
    },
    lastResponseId: "resp_1",
    lastResponseItems: [assistantOutput] as never,
  };
}

function nextRequest(phase = "final_answer"): ResponsesContinuationRequest {
  return {
    input: [
      firstUser,
      {
        type: "message",
        role: "assistant",
        phase,
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
    ] as never,
    metadata: { openclaw_turn_attempt: "2", openclaw_turn_id: "turn-2", stable: "yes" },
    store: true,
    model: "gpt-5.6-luna",
  };
}

function claim(params: {
  sessionId?: string;
  authorization?: string;
  turn?: string;
  request?: ResponsesContinuationRequest;
}) {
  return claimOpenAIResponsesHttpContinuation({
    sessionId: params.sessionId ?? "session-1",
    apiKey: "api-key",
    baseUrl: "https://api.openai.com/v1",
    headers: {
      Authorization: params.authorization ?? "Bearer tenant-a",
      traceparent: `trace-${params.turn ?? "1"}`,
      "x-openclaw-turn-id": `turn-${params.turn ?? "1"}`,
      "x-openclaw-turn-attempt": params.turn ?? "1",
      "x-stable-route": "route-a",
    },
    request: params.request ?? continuationState().lastRequest,
  });
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("OpenAI Responses continuation", () => {
  it("matches JSON wire semantics and provider-only assistant replay metadata", () => {
    const continued = resolveResponsesContinuationRequest(continuationState(), nextRequest());
    expect(continued).toMatchObject({
      continuationStatus: "continued",
      request: {
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second" }],
          },
        ],
      },
    });

    expect(
      resolveResponsesContinuationRequest(continuationState(), nextRequest("commentary"))
        .continuationStatus,
    ).toBe("history_changed");
    const explicit = { ...nextRequest(), previous_response_id: "resp_explicit" };
    expect(resolveResponsesContinuationRequest(continuationState(), explicit)).toEqual({
      request: explicit,
      continuationStatus: "explicit_previous_response_id",
    });
  });

  it("still continues when instructions changed between turns, and keeps the current turn's instructions on the wire", () => {
    const priorState: ResponsesContinuationState = {
      ...continuationState(),
      lastRequest: {
        ...continuationState().lastRequest,
        instructions: "You are a helpful assistant. Active background tasks: none.",
      },
    };
    const currentRequest: ResponsesContinuationRequest = {
      ...nextRequest(),
      // Rebuilt fresh this turn from live runtime state (per
      // resolveOpenAIResponsesInstructions) -- deliberately different text
      // from priorState, same as a real second turn would produce.
      instructions: "You are a helpful assistant. Active background tasks: 1 running.",
    };

    const resolved = resolveResponsesContinuationRequest(priorState, currentRequest);

    expect(resolved.continuationStatus).toBe("continued");
    expect(resolved.request.previous_response_id).toBe("resp_1");
    expect(resolved.request.instructions).toBe(
      "You are a helpful assistant. Active background tasks: 1 running.",
    );
  });

  it("continues a tool-calling round despite replay re-sanitizing call_id and re-serializing arguments, and restores the raw call_id on the wire delta", () => {
    // Real shape: the cached lastResponseItems is the raw provider response
    // (bare call_id, compact JSON string), but replaying history for the
    // next round runs it through normalizeOpenAIResponsesToolCallIds
    // (embedded-agent-helpers) for provider-format compatibility -- a real,
    // necessary id reshape, not a change to what the model actually said.
    // Before this fixed, that reshape made every multi-round tool-calling
    // turn permanently ineligible for continuation (history_changed on
    // every attempt, confirmed live against a real gateway).
    const rawCallId = "chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb";
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      status: "completed",
      call_id: rawCallId,
      name: "exec",
      arguments: '{"command":"echo hi"}',
    };
    const state: ResponsesContinuationState = {
      lastRequest: { model: "gpt-5.6-luna", store: true, input: [firstUser] as never },
      lastResponseId: "resp_1",
      lastResponseItems: [{ type: "reasoning" }, toolCall] as never,
    };
    // The exact reshape normalizeOpenAIResponsesToolCallIds would have
    // produced for the paired "rawCallId|fc_1" (verified against
    // normalizeOpenAIResponsesFunctionCallId directly, then split back to
    // just the call_id half the way the request builder splits it onto the
    // wire) -- not a hand-approximated shape, so the restore-to-raw path
    // under test actually has to recognize it via the real transform, not a
    // lucky string match.
    const reshapedCallId = "call_chatcmpl-tool-20cf1f2fabdd434da069764b4dca72eb_f_3b92d47627";
    const replayedToolCall = {
      ...toolCall,
      id: "fc_1",
      call_id: reshapedCallId,
      arguments: '{"command": "echo hi"}',
    };
    const toolResult = {
      type: "function_call_output",
      call_id: reshapedCallId,
      output: "hi\n",
    };
    const nextRoundRequest: ResponsesContinuationRequest = {
      model: "gpt-5.6-luna",
      store: true,
      input: [firstUser, { type: "reasoning" }, replayedToolCall, toolResult] as never,
    };

    const result = resolveResponsesContinuationRequest(state, nextRoundRequest);

    // The wire delta must carry the RAW call_id the provider actually
    // returned, not the client's replay-local reshape of it -- a server
    // that reconstructs full history from its own cached copy of the raw
    // response (e.g. a proxy virtualizing previous_response_id
    // server-side) has no way to know about the client's reshape, and
    // pairs function_call_output.call_id against the function_call it
    // cached verbatim.
    expect(result).toMatchObject({
      continuationStatus: "continued",
      request: {
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: rawCallId, output: "hi\n" }],
      },
    });
  });

  it("does not tolerate an unrelated function-call id change as the known replay reshape", () => {
    // A changed call_id that ISN'T the client's own reshape of the cached raw
    // id (e.g. the model made a genuinely different tool call, or a
    // corrupted replay) must still be treated as real history drift --
    // canonicalizeReplayedCallId only forgives ids that reshape TO the same
    // value as the cached raw one, never an arbitrary difference.
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      status: "completed",
      call_id: "call_original_abc",
      name: "exec",
      arguments: '{"command":"echo hi"}',
    };
    const state: ResponsesContinuationState = {
      lastRequest: { model: "gpt-5.6-luna", store: true, input: [firstUser] as never },
      lastResponseId: "resp_1",
      lastResponseItems: [toolCall] as never,
    };
    const replayedToolCall = { ...toolCall, call_id: "call_unrelated_xyz" };
    const toolResult = {
      type: "function_call_output",
      call_id: "call_unrelated_xyz",
      output: "hi\n",
    };
    const nextRoundRequest: ResponsesContinuationRequest = {
      model: "gpt-5.6-luna",
      store: true,
      input: [firstUser, replayedToolCall, toolResult] as never,
    };

    expect(resolveResponsesContinuationRequest(state, nextRoundRequest).continuationStatus).toBe(
      "history_changed",
    );
  });

  it("does not treat two different unsafe-integer arguments as equal (lossless comparison)", () => {
    // Number.MAX_SAFE_INTEGER + 1 and + 2 both round to the same double
    // under plain JSON.parse; a lossless comparator must still tell them
    // apart so a genuinely changed argument is never mistaken for a
    // re-serialization whitespace difference.
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      status: "completed",
      call_id: "call_original_abc",
      name: "exec",
      arguments: '{"n":9007199254740993}',
    };
    const state: ResponsesContinuationState = {
      lastRequest: { model: "gpt-5.6-luna", store: true, input: [firstUser] as never },
      lastResponseId: "resp_1",
      lastResponseItems: [toolCall] as never,
    };
    const replayedToolCall = { ...toolCall, arguments: '{"n": 9007199254740994}' };
    const toolResult = {
      type: "function_call_output",
      call_id: "call_original_abc",
      output: "hi\n",
    };
    const nextRoundRequest: ResponsesContinuationRequest = {
      model: "gpt-5.6-luna",
      store: true,
      input: [firstUser, replayedToolCall, toolResult] as never,
    };

    expect(resolveResponsesContinuationRequest(state, nextRoundRequest).continuationStatus).toBe(
      "history_changed",
    );
  });

  it("ignores turn correlation headers but isolates explicit authorization", () => {
    const first = claim({ turn: "1" });
    first?.commit(continuationState().lastRequest, {
      id: "resp_1",
      output: continuationState().lastResponseItems,
    });

    const sameTenant = claim({ turn: "2", request: nextRequest() });
    expect(sameTenant?.request.previous_response_id).toBe("resp_1");
    sameTenant?.commit(nextRequest(), { id: "resp_2", output: [] });

    const rotated = claim({
      turn: "3",
      authorization: "Bearer tenant-b",
      request: nextRequest(),
    });
    expect(rotated?.request.previous_response_id).toBeUndefined();
    rotated?.release();
  });

  it("grants one claim and prevents a concurrent non-owner from overwriting it", () => {
    const owner = claim({});
    expect(claim({})).toBeUndefined();

    owner?.commit(continuationState().lastRequest, {
      id: "resp_owner",
      output: continuationState().lastResponseItems,
    });
    expect(claim({ request: nextRequest() })?.request.previous_response_id).toBe("resp_owner");
  });

  it("prevents cleanup-time claims from resurrecting session state", () => {
    const stale = claim({});
    cleanupSessionResources("session-1");
    stale?.commit(continuationState().lastRequest, {
      id: "resp_stale",
      output: continuationState().lastResponseItems,
    });

    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBeUndefined();
    next?.release();
  });

  it("expires completed continuation state after the bounded idle TTL", () => {
    vi.useFakeTimers();
    const first = claim({});
    first?.commit(continuationState().lastRequest, {
      id: "resp_expiring",
      output: continuationState().lastResponseItems,
    });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const next = claim({ request: nextRequest() });
    expect(next?.request.previous_response_id).toBeUndefined();
    next?.release();
  });
});
