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

  it.each([
    {
      name: "instructions",
      previous: { instructions: "Active background tasks: none." },
      current: { instructions: "Active background tasks: 1 running." },
    },
    {
      name: "tools",
      previous: { tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      current: { tools: [{ type: "function", name: "write", parameters: { type: "object" } }] },
    },
  ])("keeps current $name while continuing unchanged history", ({ previous, current }) => {
    const state = continuationState();
    state.lastRequest = { ...state.lastRequest, ...previous };
    const request = { ...nextRequest(), ...current };
    const before = structuredClone({ state, request });

    const resolved = resolveResponsesContinuationRequest(state, request);

    expect(resolved.continuationStatus).toBe("continued");
    expect(resolved.request).toMatchObject({ ...current, previous_response_id: "resp_1" });
    expect(resolved.request.input).toHaveLength(1);
    expect({ state, request }).toEqual(before);
  });

  it.each([
    [
      "unsafe integer round-trip",
      '{"n":9007199254740993}',
      '{"n":"9007199254740993"}',
      "continued",
    ],
    [
      "negative unsafe round-trip",
      '{"n":-9007199254740993}',
      '{"n":"-9007199254740993"}',
      "continued",
    ],
    [
      "provider whitespace in nested arguments",
      '{ "b": {"n":9007199254740993,"a":true},"a":[1] }',
      '{"b":{"n":"9007199254740993","a":true},"a":[1]}',
      "continued",
    ],
    [
      "reordered keys remain conservative",
      '{"b":{"n":9007199254740993,"a":true},"a":[1]}',
      '{"a":[1],"b":{"a":true,"n":"9007199254740993"}}',
      "history_changed",
    ],
    [
      "positive binary64 collision",
      '{"n":9007199254740992}',
      '{"n":9007199254740993}',
      "history_changed",
    ],
    [
      "negative binary64 collision",
      '{"n":-9007199254740992}',
      '{"n":-9007199254740993}',
      "history_changed",
    ],
    [
      "edited preserved integer",
      '{"n":9007199254740993}',
      '{"n":"9007199254740992"}',
      "history_changed",
    ],
    [
      "provider string changed to bare unsafe integer",
      '{"n":"9007199254740992"}',
      '{"n":9007199254740992}',
      "history_changed",
    ],
    [
      "admitted integer string changed to Number",
      '{"n":9007199254740992}',
      '{"n":9007199254740992}',
      "history_changed",
    ],
    ["safe integer versus string", '{"n":42}', '{"n":"42"}', "history_changed"],
    [
      "safe boundary versus string",
      '{"n":9007199254740991}',
      '{"n":"9007199254740991"}',
      "history_changed",
    ],
    [
      "quoted digits and escapes",
      '{"text":"\\\"9007199254740993\\\"","n":9007199254740993}',
      '{"text":"\\\"9007199254740993\\\"","n":"9007199254740993"}',
      "continued",
    ],
    ["unchanged incomplete JSON", '{"n":', '{"n":', "continued"],
    ["changed incomplete JSON", '{"n":', '{"n": }', "history_changed"],
    [
      "invalid leading zero",
      '{"n":09007199254740993}',
      '{"n":"9007199254740993"}',
      "history_changed",
    ],
    ["non-object array", "[42]", "[42.0]", "history_changed"],
    ["non-object null", "null", " null ", "history_changed"],
    ["safe fraction", '{"n":4.20}', '{"n":4.2}', "continued"],
    ["safe exponent", '{"n":4.2e1}', '{"n":42}', "continued"],
    ["safe exponent versus string", '{"n":4.2e1}', '{"n":"42"}', "history_changed"],
    [
      "unsafe exponent follows terminal Number serialization",
      '{"n":1e16}',
      '{"n":10000000000000000}',
      "continued",
    ],
    [
      "unsafe fraction follows terminal Number serialization",
      '{"n":10000000000000000.0}',
      '{"n":10000000000000000}',
      "continued",
    ],
  ] as const)(
    "compares admitted provider tool arguments: %s",
    (_name, rawArguments, replayedArguments, expectedStatus) => {
      const state = continuationState();
      const call = {
        type: "function_call" as const,
        id: "fc_1",
        status: "completed" as const,
        call_id: "call_1",
        name: "record_value",
        arguments: rawArguments,
      };
      state.lastResponseItems = [call];
      const output = {
        type: "function_call_output" as const,
        call_id: "call_1",
        output: "recorded",
      };
      const request = {
        ...state.lastRequest,
        input: [
          ...(state.lastRequest.input ?? []),
          { ...call, arguments: replayedArguments },
          output,
        ],
      };
      const before = structuredClone({ state, request });
      const resolved = resolveResponsesContinuationRequest(state, request);
      expect(resolved.continuationStatus).toBe(expectedStatus);
      if (expectedStatus === "continued") {
        expect(resolved.request).toMatchObject({ previous_response_id: "resp_1", input: [output] });
      } else {
        expect(resolved.request).toBe(request);
      }
      expect({ state, request }).toEqual(before);
    },
  );

  it.each([
    ['{"n":9007199254740992}', '{"n":"9007199254740992"}', "history_changed"],
    ['{"n":"9007199254740992"}', '{"n":9007199254740992}', "history_changed"],
    ['{"n":9007199254740992}', '{"n":9007199254740993}', "history_changed"],
    ['{"n":9007199254740992}', '{"n":9007199254740992}', "continued"],
  ] as const)("keeps already-sent arguments strict: %s -> %s", (sent, current, expectedStatus) => {
    const state = continuationState();
    const call = {
      type: "function_call" as const,
      call_id: "sent_call",
      name: "record_value",
      arguments: sent,
    };
    const output = {
      type: "function_call_output" as const,
      call_id: "sent_call",
      output: "recorded",
    };
    state.lastRequest.input = [...(state.lastRequest.input ?? []), call, output];
    const request = nextRequest();
    const [user, ...next] = request.input ?? [];
    if (!user) {
      throw new Error("Expected the fixture's first user message");
    }
    request.input = [user, { ...call, arguments: current }, output, ...next];
    const before = structuredClone({ state, request });
    const resolved = resolveResponsesContinuationRequest(state, request);
    expect(resolved.continuationStatus).toBe(expectedStatus);
    if (expectedStatus === "history_changed") {
      expect(resolved.request).toBe(request);
    }
    expect({ state, request }).toEqual(before);
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
