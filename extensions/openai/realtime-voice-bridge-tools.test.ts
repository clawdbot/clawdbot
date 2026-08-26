// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  emitServerEvent,
  emitCompletedToolCalls,
  emitFunctionOutputAdded,
  expectedFunctionOutput,
  connectReadyBridge,
  expectedResponseCreateEvent,
  hasSentEventType,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice bridge tools", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("executes tool calls only from successful response output", async () => {
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onToolCall });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      delta: '{"question":"provisional',
    });
    emitServerEvent(socket, {
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: '{"question":"still provisional"}',
    });
    emitServerEvent(socket, {
      type: "conversation.item.done",
      item: {
        id: "item_tool_1",
        type: "function_call",
        name: "openclaw_agent_consult",
        call_id: "call_1",
        arguments: '{"question":"not terminal"}',
      },
    });
    expect(onToolCall).not.toHaveBeenCalled();

    const completed = {
      type: "response.done",
      response: {
        id: "response_1",
        status: "completed",
        output: [
          {
            id: "item_tool_1",
            type: "function_call",
            status: "completed",
            name: "openclaw_agent_consult",
            call_id: "call_1",
            arguments: '{"question":"delegate this"}',
          },
        ],
      },
    };
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
  });

  it("ignores malformed and unfinished response output items", async () => {
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onToolCall });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "response.done",
      response: {
        id: "response_1",
        status: "completed",
        output: [
          null,
          "invalid",
          {
            id: "item_tool_1",
            type: "function_call",
            status: "incomplete",
            name: "openclaw_agent_consult",
            call_id: "call_1",
            arguments: '{"question":"unfinished"}',
          },
        ],
      },
    });

    expect(onToolCall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an argument object",
      finalArguments: '{"city":"Paris"}',
      expectedArguments: { city: "Paris" },
    },
    {
      name: "the shipped empty argument contract",
      finalArguments: "",
      expectedArguments: {},
    },
  ])(
    "uses terminal response arguments for $name",
    async ({ finalArguments, expectedArguments }) => {
      const onToolCall = vi.fn();
      const bridge = createNativeBridge({ onToolCall });
      const socket = await connectReadyBridge(bridge);

      emitServerEvent(socket, {
        type: "response.done",
        response: {
          id: "response_1",
          status: "completed",
          output: [
            {
              id: "item_tool_1",
              type: "function_call",
              status: "completed",
              call_id: "call_1",
              name: "lookup_weather",
              arguments: finalArguments,
            },
          ],
        },
      });

      expect(onToolCall).toHaveBeenCalledWith({
        itemId: "item_tool_1",
        callId: "call_1",
        name: "lookup_weather",
        args: expectedArguments,
      });
    },
  );

  it.each([
    { name: "malformed JSON", arguments: '{"city":', reason: "malformed-json" },
    { name: "an array", arguments: '["Paris"]', reason: "non-object-json" },
    { name: "JSON null", arguments: "null", reason: "non-object-json" },
    { name: "a number", arguments: "42", reason: "non-object-json" },
    { name: "a boolean", arguments: "true", reason: "non-object-json" },
    { name: "missing arguments", arguments: undefined, reason: "invalid-json-type" },
    { name: "non-string arguments", arguments: { city: "Paris" }, reason: "invalid-json-type" },
  ])("rejects $name per call without ending the session", async ({ arguments: args, reason }) => {
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onToolCall, onError, onEvent });
    const socket = await connectReadyBridge(bridge);
    const completed = {
      type: "response.done",
      response: {
        id: "response_1",
        status: "completed",
        output: [
          {
            id: "item_tool_1",
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            name: "lookup_weather",
            arguments: args,
          },
        ],
      },
    };

    emitServerEvent(socket, { type: "response.created", response: { id: "response_1" } });
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${reason}`,
      itemId: "item_tool_1",
    });
    expect(
      parseSent(socket).filter(
        (event) =>
          event.type === "conversation.item.create" &&
          (event.item as { call_id?: string } | undefined)?.call_id === "call_1",
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "accepts",
      encoding: "ASCII",
      argumentBytes: 256_000,
      unit: "a",
      repeat: 255_992,
      suffix: "",
      rejected: false,
    },
    {
      name: "rejects",
      encoding: "ASCII",
      argumentBytes: 256_001,
      unit: "a",
      repeat: 255_993,
      suffix: "",
      rejected: true,
    },
    {
      name: "accepts",
      encoding: "multibyte",
      argumentBytes: 256_000,
      unit: "é",
      repeat: 127_996,
      suffix: "",
      rejected: false,
    },
    {
      name: "rejects",
      encoding: "multibyte",
      argumentBytes: 256_001,
      unit: "é",
      repeat: 127_996,
      suffix: "a",
      rejected: true,
    },
  ])(
    "$name $argumentBytes-byte $encoding UTF-8 arguments",
    async ({ argumentBytes, unit, repeat, suffix, rejected }) => {
      const onToolCall = vi.fn();
      const onError = vi.fn();
      const bridge = createNativeBridge({ onToolCall, onError });
      const socket = await connectReadyBridge(bridge);
      const rawArgs = `{"x":"${unit.repeat(repeat)}${suffix}"}`;
      expect(Buffer.byteLength(rawArgs, "utf8")).toBe(argumentBytes);

      emitServerEvent(socket, {
        type: "response.done",
        response: {
          id: "response_1",
          status: "completed",
          output: [
            {
              id: "item_tool_1",
              type: "function_call",
              status: "completed",
              call_id: "call_1",
              name: "lookup_weather",
              arguments: rawArgs,
            },
          ],
        },
      });

      expect(onToolCall).toHaveBeenCalledTimes(rejected ? 0 : 1);
      expect(
        parseSent(socket).some(
          (event) =>
            event.type === "conversation.item.create" &&
            (event.item as { call_id?: string } | undefined)?.call_id === "call_1",
        ),
      ).toBe(rejected);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("ends an extreme session before terminal tool-call ids become unbounded", async () => {
    const onToolCall = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onToolCall, onError, onClose });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "response.done",
      response: {
        id: "response_1",
        status: "completed",
        output: Array.from({ length: 1_025 }, (_, index) => ({
          id: `item_${index}`,
          type: "function_call",
          status: "completed",
          call_id: `call_${index}`,
          name: "lookup_weather",
          arguments: "{}",
        })),
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(1_024);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      new Error("OpenAI realtime tool-call session limit exceeded (1024)"),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime tool-call session limit exceeded (1024)",
    );
  });

  it("stops dispatching terminal output when a tool callback closes the bridge", async () => {
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onToolCall });
    onToolCall.mockImplementation(() => bridge.close());
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "response.done",
      response: {
        id: "response_1",
        status: "completed",
        output: Array.from({ length: 2 }, (_, index) => ({
          id: `item_${index}`,
          type: "function_call",
          status: "completed",
          call_id: `call_${index}`,
          name: "lookup_weather",
          arguments: "{}",
        })),
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["undefined", (): undefined => undefined],
    ["function", () => () => undefined],
    ["symbol", () => Symbol("invalid-tool-result")],
    ["bigint", () => ({ value: 1n })],
    [
      "circular",
      () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    ],
    ["omitted custom serialization", () => ({ toJSON: () => undefined })],
  ] as const)(
    "rejects %s tool results without consuming a retryable call",
    async (_label, create) => {
      const bridge = createNativeBridge({ onToolCall: vi.fn() });
      const socket = await connectReadyBridge(bridge);
      emitCompletedToolCalls(socket);
      const previousEventCount = socket.sent.length;

      expect(() => bridge.submitToolResult("call_1", create())).toThrow();
      expect(socket.sent).toHaveLength(previousEventCount);
      expect(hasSentEventType(socket, "response.create")).toBe(false);

      await bridge.submitToolResult("call_1", { recovered: true });

      expect(parseSent(socket).find((event) => event.type === "conversation.item.create")).toEqual({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({ recovered: true }),
        },
      });
    },
  );

  it("preserves valid JSON tool results and invokes custom serialization once", async () => {
    const bridge = createNativeBridge({ onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    const values: unknown[] = [null, false, 0, "", "text", [1], { ok: true }];
    const customSerialization = vi.fn((key: string) => ({ key }));
    values.push({ toJSON: customSerialization });
    const callIds = values.map((_, index) => `call_${index}`);
    emitCompletedToolCalls(socket, callIds);

    for (const [index, result] of values.entries()) {
      await bridge.submitToolResult(callIds[index]!, result, { suppressResponse: true });
    }

    const outputs = parseSent(socket)
      .filter((event) => event.type === "conversation.item.create")
      .map((event) => (event.item as { output: string }).output);
    expect(outputs).toEqual([
      "null",
      "false",
      "0",
      '""',
      '"text"',
      "[1]",
      '{"ok":true}',
      '{"key":""}',
    ]);
    expect(customSerialization).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not request a realtime response for continuing tool results", async () => {
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onEvent, onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket);

    const working = bridge.submitToolResult(
      "call_1",
      { status: "working" },
      { willContinue: true },
    );

    expect(parseSent(socket).slice(-1)).toEqual([
      expectedFunctionOutput("call_1", { status: "working" }),
    ]);
    expect(hasSentEventType(socket, "response.create")).toBe(false);
    expect(working).toBeUndefined();

    const done = bridge.submitToolResult("call_1", { text: "done" });
    expect(done).toBeUndefined();

    expect(parseSent(socket).slice(-3)).toEqual([
      expectedFunctionOutput("call_1", { text: "done" }),
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
    emitFunctionOutputAdded(socket, "call_1");
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.added",
      detail: "itemType=function_call_output",
    });
    emitServerEvent(socket, {
      type: "conversation.item.done",
      item: { type: "function_call_output", call_id: "call_1" },
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.done",
      detail: "itemType=function_call_output",
    });
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_2" } });
    emitServerEvent(socket, { type: "response.done" });

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("does not request a realtime response for suppressed tool results", async () => {
    const bridge = createNativeBridge({ onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket);

    const submission = bridge.submitToolResult(
      "call_1",
      { status: "already_delivered" },
      { suppressResponse: true },
    );

    expect(parseSent(socket).slice(-1)).toEqual([
      expectedFunctionOutput("call_1", { status: "already_delivered" }),
    ]);
    emitFunctionOutputAdded(socket, "call_1");
    await submission;
    expect(hasSentEventType(socket, "response.create")).toBe(false);
  });

  it("waits for every parallel tool result before continuing the response", async () => {
    const bridge = createNativeBridge({ onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket, ["call_1", "call_2"]);

    const first = bridge.submitToolResult("call_1", { text: "first" });
    emitFunctionOutputAdded(socket, "call_1");
    await first;

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toEqual([]);

    const second = bridge.submitToolResult("call_2", { text: "second" });
    emitFunctionOutputAdded(socket, "call_2");
    await second;

    expect(
      parseSent(socket).filter((event) => event.type === "conversation.item.create"),
    ).toHaveLength(2);
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("releases a deferred continuation when the last parallel result is suppressed", async () => {
    const bridge = createNativeBridge({ onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);
    emitCompletedToolCalls(socket, ["call_1", "call_2"]);

    const first = bridge.submitToolResult("call_1", { text: "first" });
    const second = bridge.submitToolResult(
      "call_2",
      { status: "already_delivered" },
      { suppressResponse: true },
    );
    emitFunctionOutputAdded(socket, "call_1");
    emitFunctionOutputAdded(socket, "call_2");
    await Promise.all([first, second]);

    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
  });

  it("does not flush deferred response.create while a tool result is still continuing", async () => {
    const onError = vi.fn();
    const bridge = createNativeBridge({ onError, onToolCall: vi.fn() });
    const socket = await connectReadyBridge(bridge);

    emitCompletedToolCalls(socket);
    const working = bridge.submitToolResult(
      "call_1",
      { status: "working" },
      { willContinue: true },
    );
    emitFunctionOutputAdded(socket, "call_1");
    await working;
    bridge.sendUserMessage?.("queue after tool result");

    expect(onError).not.toHaveBeenCalled();
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(1);
    emitServerEvent(socket, {
      type: "response.created",
      response: { id: "resp_status" },
    });
    emitServerEvent(socket, {
      type: "response.done",
      response: { id: "resp_status", status: "completed", output: [] },
    });

    const done = bridge.submitToolResult("call_1", { text: "done" });
    emitFunctionOutputAdded(socket, "call_1");
    await done;

    expect(parseSent(socket).slice(-3)).toEqual([
      expectedFunctionOutput("call_1", { text: "done" }),
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
  });
});
