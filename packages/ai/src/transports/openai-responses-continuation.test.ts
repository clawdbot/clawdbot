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
    const continued = resolveResponsesContinuationRequest(continuationState(), nextRequest(), {
      excludeTools: false,
    });
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
      resolveResponsesContinuationRequest(continuationState(), nextRequest("commentary"), {
        excludeTools: false,
      }).continuationStatus,
    ).toBe("history_changed");
    const explicit = { ...nextRequest(), previous_response_id: "resp_explicit" };
    expect(
      resolveResponsesContinuationRequest(continuationState(), explicit, {
        excludeTools: false,
      }),
    ).toEqual({
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

    const resolved = resolveResponsesContinuationRequest(priorState, currentRequest, {
      excludeTools: false,
    });

    expect(resolved.continuationStatus).toBe("continued");
    expect(resolved.request.previous_response_id).toBe("resp_1");
    expect(resolved.request.instructions).toBe(
      "You are a helpful assistant. Active background tasks: 1 running.",
    );
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
      const resolved = resolveResponsesContinuationRequest(state, request, { excludeTools: false });
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
    const resolved = resolveResponsesContinuationRequest(state, request, { excludeTools: false });
    expect(resolved.continuationStatus).toBe(expectedStatus);
    if (expectedStatus === "history_changed") {
      expect(resolved.request).toBe(request);
    }
    expect({ state, request }).toEqual(before);
  });

  it("HTTP: still continues when the available tool list changed between turns, and keeps the current turn's tools on the wire", () => {
    // Real shape: the agent's model-visible tool surface legitimately shifts
    // turn to turn (tool-search activation, session-scoped gating, MCP
    // servers connecting/disconnecting), independent of whether the prior
    // turn's server-side response state is still a valid continuation
    // baseline. Before this fixed, an ordinary tool-list change turned into
    // a permanent request_changed false positive, silently disabling
    // continuation for the rest of the connection's life -- reproduced live
    // against both a real OpenAI-Responses-compatible endpoint and, for this
    // specific excludeTools:true HTTP path, the official api.openai.com
    // (see openai-responses-client.continuation-tools-change.live.test.ts).
    // WebSocket does NOT get this exclusion yet (excludeTools: false at its
    // call site) -- see openai-responses-websocket.test.ts's "resets
    // continuation on tool schema change".
    const priorState: ResponsesContinuationState = {
      ...continuationState(),
      lastRequest: {
        ...continuationState().lastRequest,
        tools: [{ type: "function", name: "read", parameters: {} }],
      },
    };
    const currentRequest: ResponsesContinuationRequest = {
      ...nextRequest(),
      tools: [
        { type: "function", name: "read", parameters: {} },
        { type: "function", name: "web_fetch", parameters: {} },
      ],
    };

    const resolved = resolveResponsesContinuationRequest(priorState, currentRequest, {
      excludeTools: true,
    });

    expect(resolved.continuationStatus).toBe("continued");
    expect(resolved.request.previous_response_id).toBe("resp_1");
    expect(resolved.request.tools).toEqual([
      { type: "function", name: "read", parameters: {} },
      { type: "function", name: "web_fetch", parameters: {} },
    ]);
  });

  it("WebSocket (excludeTools: false): still resets continuation when the tool list changed between turns", () => {
    // Proves the HTTP-only scoping actually holds both ways: the WebSocket
    // call site passes excludeTools: false (openai-responses-websocket.ts),
    // matching openai-responses-websocket.test.ts's existing "resets
    // continuation on tool schema change" coverage -- this is that same
    // invariant expressed at the shared resolver level.
    const priorState: ResponsesContinuationState = {
      ...continuationState(),
      lastRequest: {
        ...continuationState().lastRequest,
        tools: [{ type: "function", name: "read", parameters: {} }],
      },
    };
    const currentRequest: ResponsesContinuationRequest = {
      ...nextRequest(),
      tools: [
        { type: "function", name: "read", parameters: {} },
        { type: "function", name: "web_fetch", parameters: {} },
      ],
    };

    const resolved = resolveResponsesContinuationRequest(priorState, currentRequest, {
      excludeTools: false,
    });

    expect(resolved.continuationStatus).toBe("request_changed");
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
