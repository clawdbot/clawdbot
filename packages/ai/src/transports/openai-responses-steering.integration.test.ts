import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { Context, Model, StreamOptions } from "../types.js";

type WireEvent =
  | { type: "open" }
  | { type: "message"; message: Record<string, unknown> }
  | { type: "close"; code: number };

const sockets = vi.hoisted(() => ({
  instances: [] as Array<{
    requests: Record<string, unknown>[];
    closed: boolean;
    streamCalls: number;
    iteratorReturns: number;
    emit(message: Record<string, unknown>): void;
    disconnect(): void;
  }>,
}));

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class {
    socket = { readyState: 1 };
    requests: Record<string, unknown>[] = [];
    closed = false;
    streamCalls = 0;
    iteratorReturns = 0;
    private queue: WireEvent[] = [{ type: "open" }];
    private waiting: Array<(result: IteratorResult<WireEvent>) => void> = [];
    private stopped = false;

    constructor() {
      sockets.instances.push(this);
    }

    send(request: Record<string, unknown>) {
      this.requests.push(structuredClone(request));
    }

    sendRaw(data: string) {
      this.send(JSON.parse(data) as Record<string, unknown>);
    }

    emit(message: Record<string, unknown>) {
      this.push({ type: "message", message });
    }

    disconnect() {
      this.closed = true;
      this.socket.readyState = 3;
      this.push({ type: "close", code: 1006 });
    }

    close() {
      this.closed = true;
      this.socket.readyState = 3;
    }

    on() {
      return this;
    }

    private push(event: WireEvent) {
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve({ value: event, done: false });
      } else {
        this.queue.push(event);
      }
    }

    stream(): AsyncIterableIterator<WireEvent> {
      if (this.streamCalls > 0) {
        this.queue.push({ type: "open" });
      }
      this.stopped = false;
      this.streamCalls++;
      const iterator: AsyncIterableIterator<WireEvent> = {
        next: () => {
          const event = this.queue.shift();
          if (event) {
            return Promise.resolve({ value: event, done: false });
          }
          if (this.stopped) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.waiting.push(resolve);
          });
        },
        return: () => {
          this.iteratorReturns++;
          this.stopped = true;
          for (const resolve of this.waiting.splice(0)) {
            resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]: () => iterator,
      };
      return iterator;
    }
  },
}));

import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { ResponsesContinuationRequest } from "./openai-responses-continuation.js";
import { OpenAIResponsesWebSocketPostDispatchError } from "./openai-responses-contracts.js";
import { responsesLoopbackModel } from "./openai-responses-loopback.test-support.js";
import { createOpenAIResponsesWebSocketStream } from "./openai-responses-websocket.js";

const client = {
  apiKey: "test-key",
  baseURL: "https://api.openai.com/v1",
  withOptions() {
    return this;
  },
};
const model: Model = {
  ...responsesLoopbackModel,
  id: "gpt-6-astra",
  name: "Astra",
  reasoning: true,
};
const user = (content: string) => ({ role: "user" as const, content });
const initialUser = user("original question");
const update = user("new requirement");
const output = (text: string, id = "msg_1") => ({
  type: "message" as const,
  role: "assistant" as const,
  id,
  status: "completed" as const,
  content: [{ type: "output_text" as const, text, annotations: [] }],
});
const completed = (id: string, result = [output("answer")]) => ({
  type: "response.completed",
  response: { id, status: "completed", output: result },
});
const accepted = {
  type: "response.steer.accepted",
  steer: { id: "steer_1", previous_response_id: "resp_1" },
};

function createStream(
  input: NonNullable<ResponsesContinuationRequest["input"]>,
  onActiveResponse?: StreamOptions["onActiveResponse"],
  request: Record<string, unknown> = {},
) {
  return createOpenAIResponsesWebSocketStream({
    client: client as never,
    request: { model: "gpt-6-astra", instructions: "Be helpful", tools: [], input, ...request },
    mode: "websocket-cached",
    sessionId: "steering-integration-session",
    onActiveResponse,
    steeringInput: (messages) =>
      messages.map((message) => ({ role: "user", content: message.content as string })),
  });
}

async function collect(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectPostDispatchError(error: unknown, cause: RegExp) {
  expect(error).toBeInstanceOf(OpenAIResponsesWebSocketPostDispatchError);
  expect(error).toMatchObject({ cause: { message: expect.stringMatching(cause) } });
}

function start(
  request: Record<string, unknown> = {},
  input: NonNullable<ResponsesContinuationRequest["input"]> = [initialUser],
) {
  const ready = createDeferred<Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0]>();
  const cleanup = vi.fn();
  const first = createStream(
    input,
    (control) => {
      ready.resolve(control);
      return cleanup;
    },
    request,
  );
  const events = collect(first.stream);
  const socket = sockets.instances[0];
  assert(socket);
  socket.emit({ type: "response.created", response: { id: "resp_1" } });
  return { first, events, socket, control: ready.promise, cleanup };
}

async function startRequiredInput(historicalUpdate = false) {
  const sentUpdate = { type: "configuration_update" as const, reasoning: { effort: "medium" } };
  const harness = start(
    { reasoning: { effort: "low" } },
    historicalUpdate ? [sentUpdate, initialUser] : [initialUser],
  );
  const control = await harness.control;
  const admission = control.steer([{ ...update, timestamp: 1 }]);
  harness.socket.emit(accepted);
  await admission;
  const toolCall = {
    type: "function_call" as const,
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: "{}",
    status: "completed" as const,
  };
  harness.socket.emit({
    type: "response.completed",
    response: { id: "resp_1", status: "completed", output: [toolCall] },
  });
  harness.socket.emit({
    type: "response.steer.pending",
    steer: accepted.steer,
    reason: "waiting_for_required_input",
    required_input: [{ type: "function_call_output", call_id: "call_1", name: "lookup" }],
  });
  await harness.events;
  harness.first.finish();
  const toolResult = {
    type: "function_call_output" as const,
    call_id: "call_1",
    output: "lookup result",
  };
  return { ...harness, sentUpdate, toolCall, toolResult };
}

afterEach(() => {
  cleanupSessionResources();
  sockets.instances.length = 0;
});

describe("Responses WebSocket steering handoff", () => {
  it("keeps runtime context with its user through steering and the automatic successor", async () => {
    const context: Context = {
      messages: [
        { role: "user", content: "original", timestamp: 0 },
        {
          role: "user",
          content: "runtime context",
          timestamp: 0,
          runtimeContextCarrier: true,
        },
      ],
    };
    const ready = createDeferred<Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0]>();
    const stream = createOpenAIResponsesTransportStreamFn();
    const options = {
      apiKey: "test-key",
      sessionId: "runtime-context-steering",
      transport: "websocket-cached" as const,
    };
    const first = (
      await stream(model, context, {
        ...options,
        onActiveResponse: (control) => {
          ready.resolve(control);
        },
      })
    ).result();
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
    const socket = sockets.instances[0];
    assert(socket);
    socket.emit({ type: "response.created", response: { id: "resp_1" } });
    const steeringUser = { role: "user" as const, content: "new requirement", timestamp: 1 };
    const admission = (await ready.promise).steer([steeringUser]);
    try {
      await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
      expect(socket.requests[1]).toMatchObject({
        type: "response.steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "new requirement" }] }],
      });
      socket.emit(accepted);
      expect(await admission).toBe(true);
    } finally {
      socket.emit(completed("resp_1", [output("original answer")]));
      await first;
    }
    context.messages.push(await first, steeringUser);
    socket.emit({ type: "response.created", response: { id: "resp_2" } });
    socket.emit(completed("resp_2", [output("steered answer", "msg_2")]));
    const second = await (await stream(model, context, options)).result();
    expect(second.stopReason).not.toBe("error");
    expect(second.content).toMatchObject([{ type: "text", text: "steered answer" }]);
    expect(socket.requests.filter((request) => request.type === "response.create")).toHaveLength(1);
    expect(socket.streamCalls).toBe(1);
  });

  it.each(["prune", "prepend"])(
    "handles %s payload projection against the active prefix",
    async (mode) => {
      const ready = createDeferred<Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0]>();
      const result = (
        await createOpenAIResponsesTransportStreamFn()(
          model,
          {
            messages: [{ role: "user", content: "original", timestamp: 0 }],
          },
          {
            apiKey: "test-key",
            sessionId: "payload-projection",
            transport: "websocket-cached",
            onActiveResponse: (control) => {
              ready.resolve(control);
            },
            onPayload: (payload) => {
              const request = payload as { input: unknown[] };
              return {
                ...request,
                input:
                  mode === "prune" && request.input.length > 1
                    ? request.input.slice(-1)
                    : [user("hook context"), ...request.input],
              };
            },
          },
        )
      ).result();
      await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
      const socket = sockets.instances[0];
      assert(socket);
      socket.emit({ type: "response.created", response: { id: "resp_1" } });
      let outcome: boolean | undefined;
      const admission = (await ready.promise).steer([
        { role: "user", content: "update", timestamp: 1 },
      ]);
      void admission.then((value) => {
        outcome = value;
      });
      try {
        await vi.waitFor(() =>
          expect(outcome !== undefined || socket.requests.length > 1).toBe(true),
        );
        if (outcome === undefined) {
          socket.emit(accepted);
        }
        expect(await admission).toBe(mode === "prepend");
        expect(socket.requests).toHaveLength(mode === "prepend" ? 2 : 1);
      } finally {
        socket.emit(completed("resp_1"));
        await result;
      }
    },
  );

  it("reconnects from saved client output with the original input delivery order", async () => {
    const context: Context = { messages: [{ role: "user", content: "original", timestamp: 0 }] };
    const ready = createDeferred<Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0]>();
    const options = {
      apiKey: "test-key",
      sessionId: "input-replay-client",
      transport: "websocket-cached" as const,
      asyncToolExecution: true,
      onPayload: (payload: unknown): unknown => {
        const serialized = JSON.stringify(payload);
        return JSON.parse(
          serialized
            .replaceAll('"new requirement"', '"projected requirement"')
            .replaceAll('"found"', '"projected found"'),
        );
      },
    };
    const stream = createOpenAIResponsesTransportStreamFn();
    const first = (
      await stream(model, context, {
        ...options,
        onActiveResponse: (control) => {
          ready.resolve(control);
        },
      })
    ).result();
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
    const socket = sockets.instances[0];
    assert(socket);
    socket.emit({ type: "response.created", response: { id: "resp_1" } });
    const steeringUser = { role: "user" as const, content: "new requirement", timestamp: 2 };
    const admission = (await ready.promise).steer([steeringUser]);
    await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
    socket.emit(accepted);
    await admission;
    expect(JSON.stringify(socket.requests[1])).toContain("projected requirement");
    const toolCall = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
      status: "completed",
      async: true,
    };
    socket.emit({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [toolCall, output("independent answer")],
      },
    });
    const firstAnswer = await first;
    expect(firstAnswer.stopReason).not.toBe("error");
    context.messages.push(
      firstAnswer,
      {
        role: "toolResult",
        toolCallId: "call_1|fc_1",
        toolName: "lookup",
        content: [{ type: "text", text: "found" }],
        isError: false,
        timestamp: 1,
      },
      steeringUser,
    );
    socket.emit({ type: "response.created", response: { id: "resp_2" } });
    socket.emit(completed("resp_2", [output("automatic answer", "msg_2")]));
    const second = await (
      await stream(model, context, {
        ...options,
        onActiveResponse: () => undefined,
      })
    ).result();
    expect(second.stopReason).not.toBe("error");
    context.messages.push(second);
    cleanupSessionResources(options.sessionId);
    const serialized = JSON.stringify(context);
    const recovered: Context = JSON.parse(serialized);
    const third = (await stream(model, recovered, options)).result();
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));
    const connection = sockets.instances[1];
    assert(connection);
    await vi.waitFor(() => expect(connection.requests).toHaveLength(1));
    const request = connection.requests[0];
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request?.input).toMatchObject([
      { role: "user" },
      { type: "function_call" },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant" },
      { type: "function_call_output", output: "projected found" },
    ]);
    connection.emit({ type: "response.created", response: { id: "resp_3" } });
    connection.emit(completed("resp_3"));
    expect((await third).stopReason).not.toBe("error");
  });
  it.each([false, true])(
    "keeps inherited effort for automatic steering (historical update: %s)",
    async (historicalUpdate) => {
      const sentUpdate = { type: "configuration_update" as const, reasoning: { effort: "medium" } };
      const request = { reasoning: { effort: "low" } };
      const harness = start(request, historicalUpdate ? [sentUpdate, initialUser] : [initialUser]);
      const control = await harness.control;
      const admission = control.steer([{ ...update, timestamp: 1 }]);
      harness.socket.emit(accepted);
      await admission;
      const firstAnswer = output("original fragment");
      harness.socket.emit(completed("resp_1", [firstAnswer]));
      const toolCall = {
        type: "function_call" as const,
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
        status: "completed" as const,
      };
      harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
      harness.socket.emit({
        type: "response.completed",
        response: { id: "resp_2", status: "completed", output: [toolCall] },
      });
      await harness.events;
      harness.first.finish();

      let continuationNeeded: (() => boolean) | undefined;
      const nextInput = [initialUser, firstAnswer, update];
      const second = createStream(
        nextInput,
        (nextControl) => {
          continuationNeeded = nextControl.needsContinuation;
        },
        { reasoning: { effort: "high" } },
      );
      await collect(second.stream);
      second.finish();
      expect(second.request.reasoning).toEqual({ effort: "low" });
      expect(continuationNeeded?.()).toBe(false);
      expect(
        harness.socket.requests.filter((entry) => entry.type === "response.create"),
      ).toHaveLength(1);

      const toolResult = {
        type: "function_call_output" as const,
        call_id: "call_1",
        output: "lookup result",
      };
      const third = createStream([...nextInput, toolCall, toolResult], undefined, {
        reasoning: { effort: "high" },
      });
      const thirdEvents = collect(third.stream);
      harness.socket.emit({ type: "response.created", response: { id: "resp_3" } });
      harness.socket.emit(completed("resp_3"));
      await thirdEvents;
      third.finish();
      // No fresh user exists to anchor an update; use the selected request effort and a fresh prefix.
      expect(third.request).toMatchObject({
        reasoning: { effort: "high" },
        input: [...nextInput, toolCall, toolResult],
      });
      expect(third.request.previous_response_id).toBeUndefined();
    },
  );

  it("adds a changed effort only before a fresh user after automatic steering", async () => {
    const sentUpdate = { type: "configuration_update" as const, reasoning: { effort: "medium" } };
    const harness = start({ reasoning: { effort: "low" } }, [sentUpdate, initialUser]);
    const control = await harness.control;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    harness.socket.emit(accepted);
    await admission;
    const firstAnswer = output("original fragment");
    const automaticAnswer = output("automatic answer", "msg_2");
    harness.socket.emit(completed("resp_1", [firstAnswer]));
    harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
    harness.socket.emit(completed("resp_2", [automaticAnswer]));
    await harness.events;
    harness.first.finish();
    const secondInput = [initialUser, firstAnswer, update];
    const second = createStream(secondInput, undefined, { reasoning: { effort: "high" } });
    await collect(second.stream);
    second.finish();
    const freshUser = user("fresh question");
    const third = createStream([...secondInput, automaticAnswer, freshUser], undefined, {
      reasoning: { effort: "high" },
    });
    const thirdEvents = collect(third.stream);
    harness.socket.emit({ type: "response.created", response: { id: "resp_3" } });
    harness.socket.emit(completed("resp_3"));
    await thirdEvents;
    third.finish();
    expect(third.request).toMatchObject({
      previous_response_id: "resp_2",
      reasoning: { effort: "low" },
      input: [{ type: "configuration_update", reasoning: { effort: "high" } }, freshUser],
    });
  });

  it("steers during generation and consumes the automatic continuation without creating another response", async () => {
    const harness = start();
    const control = await harness.control;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    expect(harness.socket.requests).toHaveLength(2);
    expect(harness.socket.requests[1]).toEqual({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: [update],
    });
    harness.socket.emit(accepted);
    expect(await admission).toBe(true);
    const firstAnswer = output("original fragment");
    harness.socket.emit({
      type: "response.incomplete",
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "steered" },
        output: [firstAnswer],
      },
    });
    // The server starts immediately, before the agent can open its next stream.
    harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
    harness.socket.emit(completed("resp_2", [output("updated answer", "msg_2")]));
    expect(await harness.events).toContainEqual({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        incomplete_details: null,
        output: [firstAnswer],
      },
    });
    harness.first.finish();
    expect(harness.socket.iteratorReturns).toBe(0);
    const second = createStream([initialUser, firstAnswer, update]);
    expect(await collect(second.stream)).toContainEqual(
      completed("resp_2", [output("updated answer", "msg_2")]),
    );
    second.finish();
    expect(
      harness.socket.requests.filter((request) => request.type === "response.create"),
    ).toHaveLength(1);
    expect(harness.socket.streamCalls).toBe(1);
    expect(harness.cleanup).toHaveBeenCalledOnce();
    expect(await control.steer([{ ...update, timestamp: 2 }])).toBe(false);
  });

  it("delivers async tool results once after the automatic steering response finishes", async () => {
    const harness = start();
    const control = await harness.control;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    harness.socket.emit(accepted);
    await admission;
    const toolCall = {
      type: "function_call" as const,
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
      status: "completed" as const,
      async: true,
    };
    const firstAnswer = output("working independently");
    harness.socket.emit({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [toolCall, firstAnswer] },
    });
    const automaticAnswer = output("handling the new requirement", "msg_2");
    harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
    harness.socket.emit(completed("resp_2", [automaticAnswer]));
    await harness.events;
    harness.first.finish();

    const toolResult = {
      type: "function_call_output" as const,
      call_id: "call_1",
      output: "lookup result",
    };
    const secondInput = [initialUser, toolCall, firstAnswer, toolResult, update];
    let continuationNeeded: (() => boolean) | undefined;
    const second = createStream(secondInput, (nextControl) => {
      continuationNeeded = nextControl.needsContinuation;
    });
    await collect(second.stream);
    second.finish();
    expect(continuationNeeded?.()).toBe(true);
    expect(
      harness.socket.requests.filter((request) => request.type === "response.create"),
    ).toHaveLength(1);

    // Replay must match delivery: the automatic response never saw the tool result.
    const third = createStream([
      initialUser,
      toolCall,
      firstAnswer,
      update,
      automaticAnswer,
      toolResult,
    ]);
    const thirdEvents = collect(third.stream);
    harness.socket.emit({ type: "response.created", response: { id: "resp_3" } });
    harness.socket.emit(completed("resp_3", [output("answer using lookup result", "msg_3")]));
    await thirdEvents;
    third.finish();
    const creates = harness.socket.requests.filter((request) => request.type === "response.create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({ previous_response_id: "resp_2", input: [toolResult] });
    expect(creates.flatMap((request) => request.input)).toEqual([initialUser, toolResult]);
  });

  it.each(
    [
      {
        name: "instructions and tools",
        settings: {
          instructions: "Summarize the lookup result",
          tools: [{ type: "function", name: "summarize", parameters: { type: "object" } }],
        },
      },
      { name: "output limit", settings: { max_output_tokens: 512 } },
      { name: "reasoning effort", settings: { reasoning: { effort: "high" } } },
      {
        name: "reasoning summary",
        settings: { reasoning: { effort: "low", summary: "detailed" } },
      },
    ].flatMap((entry) =>
      [false, true].map((historicalUpdate) => Object.assign({}, entry, { historicalUpdate })),
    ),
  )(
    "returns required input with current $name (historical update: $historicalUpdate)",
    async ({ settings, historicalUpdate }) => {
      const harness = await startRequiredInput(historicalUpdate);
      const { toolCall, toolResult } = harness;
      const currentSettings = { reasoning: { effort: "low" }, ...settings };
      const second = createStream(
        [initialUser, toolCall, toolResult, update],
        undefined,
        currentSettings,
      );
      const secondEvents = collect(second.stream);
      harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
      harness.socket.emit(completed("resp_2"));
      expect(await secondEvents).toContainEqual(completed("resp_2"));
      second.finish();
      expect(harness.socket.requests.at(-1)).toMatchObject({
        type: "response.create",
        previous_response_id: "resp_1",
        input: [toolResult],
        ...currentSettings,
      });
      expect(harness.socket.streamCalls).toBe(1);

      // The next request must match the actual delivery prefix, including old controls.
      const followUp = user("Continue from that result");
      const third = createStream(
        [initialUser, toolCall, update, toolResult, output("answer"), followUp],
        undefined,
        currentSettings,
      );
      const thirdEvents = collect(third.stream);
      harness.socket.emit(completed("resp_3"));
      await thirdEvents;
      third.finish();
      expect(third.request.previous_response_id).toBe("resp_2");
      expect(third.request.input?.at(-1)).toEqual(followUp);
    },
  );

  it("returns required input with inherited controls when request reasoning is omitted", async () => {
    const harness = await startRequiredInput(true);
    const second = createStream([initialUser, harness.toolCall, harness.toolResult, update]);
    const events = collect(second.stream);
    harness.socket.emit({ type: "response.created", response: { id: "resp_2" } });
    harness.socket.emit(completed("resp_2"));
    expect(await events).toContainEqual(completed("resp_2"));
    second.finish();
    expect(harness.socket.requests.at(-1)).toMatchObject({
      type: "response.create",
      previous_response_id: "resp_1",
      input: [harness.toolResult],
    });
    expect(harness.socket.requests.at(-1)).not.toHaveProperty("reasoning");
  });

  it.each(
    [
      { name: "another model", settings: { model: "gpt-5.6-luna" } },
      { name: "pro mode", settings: { reasoning: { mode: "pro", effort: "high" } } },
      { name: "multi-agent mode", settings: { multi_agent: { enabled: true } } },
      { name: "automatic truncation", settings: { truncation: "auto" } },
      {
        name: "automatic compaction",
        settings: { context_management: [{ type: "compaction", compact_threshold: 1000 }] },
      },
    ].flatMap((entry) =>
      [false, true].map((includeControl) => Object.assign({}, entry, { includeControl })),
    ),
  )(
    "rejects required-input history with configuration updates in $name (control present: $includeControl)",
    async ({ settings, includeControl }) => {
      const harness = await startRequiredInput(true);
      const input = [initialUser, harness.toolCall, harness.toolResult, update];
      let failure: unknown;
      try {
        createStream(includeControl ? [harness.sentUpdate, ...input] : input, undefined, {
          reasoning: { effort: "high" },
          ...settings,
        });
      } catch (error) {
        failure = error;
      }
      expectPostDispatchError(failure, /steering continuation changed its request or history/);
      expect(harness.socket.closed).toBe(true);
      expect(
        harness.socket.requests.filter((request) => request.type === "response.create"),
      ).toHaveLength(1);
    },
  );

  it("rejects unresolved steering on disconnect and closes retained control", async () => {
    const harness = start();
    const failure = harness.events.catch((error: unknown) => error);
    const control = await harness.control;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    const admissionFailure = expect(admission).rejects.toThrow(/closed before completion/);
    harness.socket.disconnect();
    const [error] = await Promise.all([failure, admissionFailure]);
    expectPostDispatchError(error, /closed before completion/);
    expect(harness.socket.closed).toBe(true);
    expect(await control.steer([{ ...update, timestamp: 2 }])).toBe(false);
    expect(harness.cleanup).toHaveBeenCalledOnce();
  });

  it("closes unresolved admission when the stream consumer returns early", async () => {
    const ready = createDeferred<Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0]>();
    const first = createStream([initialUser], (control) => {
      ready.resolve(control);
    });
    const socket = sockets.instances[0];
    assert(socket);
    const iterator = first.stream[Symbol.asyncIterator]();
    const initial = iterator.next();
    socket.emit({ type: "response.created", response: { id: "resp_1" } });
    await initial;
    const control = await ready.promise;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    const admissionFailure = expect(admission).rejects.toThrow();
    await iterator.return?.();
    await admissionFailure;
    expect(socket.closed).toBe(true);
    expect(await control.steer([{ ...update, timestamp: 2 }])).toBe(false);
  });

  it("routes a late accepted-steer failure to the original response owner", async () => {
    const harness = start();
    const control = await harness.control;
    const admission = control.steer([{ ...update, timestamp: 1 }]);
    harness.socket.emit(accepted);
    await admission;
    const firstAnswer = output("original fragment");
    harness.socket.emit(completed("resp_1", [firstAnswer]));
    harness.socket.emit({
      type: "response.steer.failed",
      steer: { ...accepted.steer, input: [update] },
      error: { code: "response_not_found" },
    });
    await harness.events;
    harness.first.finish();
    const second = createStream([initialUser, firstAnswer, update]);
    const failure = await collect(second.stream).catch((error: unknown) => error);
    expectPostDispatchError(failure, /could not apply accepted steering/);
    expect(harness.socket.closed).toBe(true);
    expect(
      harness.socket.requests.filter((request) => request.type === "response.create"),
    ).toHaveLength(1);
  });

  it.each([
    { instructions: "Changed instructions" },
    { tools: [{ type: "function", name: "new_tool", parameters: { type: "object" } }] },
  ])(
    "rejects request changes that an automatic continuation would silently ignore",
    async (request) => {
      const harness = start();
      const control = await harness.control;
      const admission = control.steer([{ ...update, timestamp: 1 }]);
      harness.socket.emit(accepted);
      await admission;
      const firstAnswer = output("original fragment");
      harness.socket.emit(completed("resp_1", [firstAnswer]));
      await harness.events;
      harness.first.finish();
      let failure: unknown;
      try {
        createStream([initialUser, firstAnswer, update], undefined, request);
      } catch (error) {
        failure = error;
      }
      expectPostDispatchError(failure, /steering continuation|inherited request/);
      expect(harness.socket.closed).toBe(true);
    },
  );
});
