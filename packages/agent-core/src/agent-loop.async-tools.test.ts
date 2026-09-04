import { setImmediate } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolCall,
} from "@openclaw/llm-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  failTransportStream,
  transportAbortError,
} from "../../ai/src/transports/transport-stream-shared.js";
import { runAgentLoop } from "./agent-loop.js";
import { Agent } from "./agent.js";
import { attachInternalToolBatchLifecycle, setInternalBeforeToolBatch } from "./internal-hooks.js";
import { getAgentToolExecutionContext } from "./tool-execution-context.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "async-model",
  name: "Async Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};
const usage = {
  input: 4,
  output: 3,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 9,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    timestamp: 1,
  };
}
function tool(name: string, execute: AgentTool["execute"]): AgentTool {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}
function call(id: string, async = true): ToolCall {
  return { type: "toolCall", name: id, id, arguments: {}, ...(async ? { async: true } : {}) };
}
function recordMessage(event: AgentEvent, messages: AgentMessage[]) {
  if (event.type === "message_end") {
    messages.push(event.message);
  }
}

it.each(["replace", "remove"] as const)(
  "honors a message finalization hook that %ss an async call",
  async (change) => {
    const source = { ...call("lookup"), arguments: { text: "original" } };
    const execute = vi.fn(async () => ({ content: [], details: {}, terminate: true }));
    const response = createAssistantMessageEventStream();
    response.push({ type: "start", partial: assistant([]) });
    response.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: source,
      partial: assistant([source]),
    });
    response.push({ type: "done", reason: "stop", message: assistant([source]) });
    response.end();
    const persisted: AgentMessage[] = [];
    await runAgentLoop(
      [{ role: "user", content: "look up", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [{ ...tool("lookup", execute), parameters: Type.Object({ text: Type.String() }) }],
      },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          await setImmediate();
          event.message.content = event.message.content.flatMap(
            (block): AssistantMessage["content"] =>
              block.type !== "toolCall"
                ? [block]
                : change === "remove"
                  ? []
                  : [{ ...block, arguments: { text: "corrected" } }],
          );
        }
        recordMessage(event, persisted);
      },
      undefined,
      () => response,
    );
    if (change === "remove") {
      expect(execute).not.toHaveBeenCalled();
      expect(persisted.filter((message) => message.role === "toolResult")).toHaveLength(0);
    } else {
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        "lookup",
        { text: "corrected" },
        expect.any(AbortSignal),
        expect.any(Function),
      );
    }
  },
);

it.each([
  "default",
  "parallel",
  "mixed-parallel",
  "sequential",
  "exclusive",
  "deferred-exclusive",
] as const)("preserves %s scheduling for streamed async calls", async (mode) => {
  const response = createAssistantMessageEventStream();
  const preparing = createDeferred();
  const prepared = createDeferred();
  const firstDone = createDeferred();
  const secondDone = createDeferred();
  const preparedNames: string[] = [];
  const started: string[] = [];
  const persisted: AgentMessage[] = [];
  const make = (name: string, gate = Promise.resolve()) =>
    tool(name, async () => {
      started.push(name);
      await gate;
      return { content: [], details: {}, terminate: true };
    });
  const firstTool = make("first", firstDone.promise);
  const secondTool = make("second", secondDone.promise);
  const thirdTool = make("third");
  if (mode.endsWith("exclusive")) {
    secondTool.executionMode = "sequential";
  }
  const calls = [call("first"), call("second", mode !== "mixed-parallel"), call("third")];
  const run = runAgentLoop(
    [{ role: "user", content: "start", timestamp: 0 }],
    {
      systemPrompt: "",
      messages: [],
      tools:
        mode === "deferred-exclusive" ? [firstTool, thirdTool] : [firstTool, secondTool, thirdTool],
    },
    {
      model,
      toolExecution:
        mode === "sequential" ? "sequential" : mode === "parallel" ? "parallel" : undefined,
      convertToLlm: (messages) => messages as Context["messages"],
      resolveDeferredTool: ({ toolCall }) => (toolCall.name === "second" ? secondTool : undefined),
      beforeToolCall: async ({ toolCall }) => {
        preparedNames.push(toolCall.name);
        if (toolCall.name === "first") {
          preparing.resolve();
          await prepared.promise;
        }
        return undefined;
      },
    },
    (event) => recordMessage(event, persisted),
    undefined,
    () => response,
  );
  try {
    response.push({ type: "start", partial: assistant([]) });
    calls.forEach((toolCall, contentIndex) =>
      response.push({
        type: "toolcall_end",
        contentIndex,
        toolCall,
        partial: assistant(calls.slice(0, contentIndex + 1)),
      }),
    );
    if (mode === "mixed-parallel") {
      response.push({ type: "done", reason: "toolUse", message: assistant(calls, "toolUse") });
      response.end();
    }
    await preparing.promise;
    await vi.waitFor(() =>
      expect(persisted.filter((message) => message.role === "assistant")).toHaveLength(
        mode === "mixed-parallel" ? 2 : 3,
      ),
    );
    expect(preparedNames).toEqual(["first"]);
    prepared.resolve();
    await vi.waitFor(() => expect(started).toContain("first"));
    if (mode === "default" || mode === "parallel" || mode === "mixed-parallel") {
      await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
      secondDone.resolve();
      await vi.waitFor(() =>
        expect(
          persisted.some(
            (message) => message.role === "toolResult" && message.toolCallId === "second",
          ),
        ).toBe(true),
      );
      expect(
        persisted.some(
          (message) => message.role === "toolResult" && message.toolCallId === "first",
        ),
      ).toBe(false);
      firstDone.resolve();
    } else {
      await setImmediate();
      expect(started).toEqual(["first"]);
      firstDone.resolve();
      await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
      await setImmediate();
      expect(started).not.toContain("third");
      secondDone.resolve();
      await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    }
  } finally {
    prepared.resolve();
    firstDone.resolve();
    secondDone.resolve();
    response.push({ type: "done", reason: "stop", message: assistant(calls) });
    response.end();
    await run;
  }
  expect(persisted.filter((message) => message.role === "toolResult")).toHaveLength(3);
});

it("keeps the live assistant visible while an async tool result starts and ends", async () => {
  const response = createAssistantMessageEventStream();
  const gate = createDeferred();
  const source = call("lookup");
  const text = { type: "text" as const, text: "independent answer" };
  const execute = vi.fn(async () => {
    await gate.promise;
    return { content: [{ type: "text" as const, text: "found" }], details: {} };
  });
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools: [tool("lookup", execute)] },
    streamFn: () => {
      if (++requests === 1) {
        return response;
      }
      const final = createAssistantMessageEventStream();
      final.push({
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "done" }]),
      });
      final.end();
      return final;
    },
  });
  const resultStates: Array<AgentMessage | undefined> = [];
  agent.subscribe((event) => {
    if (
      (event.type === "message_start" || event.type === "message_end") &&
      event.message.role === "toolResult"
    ) {
      resultStates.push(agent.state.streamingMessage);
    }
  });
  const run = agent.prompt("look up");
  try {
    response.push({ type: "start", partial: assistant([]) });
    response.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: source,
      partial: assistant([source]),
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    response.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text.text,
      partial: assistant([source, text]),
    });
    await vi.waitFor(() =>
      expect(agent.state.streamingMessage).toMatchObject({ role: "assistant", content: [text] }),
    );
    const activeAssistant = agent.state.streamingMessage;
    gate.resolve();
    await vi.waitFor(() => expect(resultStates).toHaveLength(2));
    expect(resultStates).toEqual([activeAssistant, activeAssistant]);
    expect(agent.state.streamingMessage).toBe(activeAssistant);
  } finally {
    gate.resolve();
    response.push({ type: "done", reason: "stop", message: assistant([source, text]) });
    response.end();
    await run;
  }
  expect(agent.state.streamingMessage).toBeUndefined();
});

it.each(["stop", "length"] as const)(
  "persists an execution identity for a done-only async %s response",
  async (stopReason) => {
    const persisted: AgentMessage[] = [];
    const execute = vi.fn(async () => {
      const owner = getAgentToolExecutionContext()?.assistantMessage;
      expect(owner?.turnId).toBeTruthy();
      expect(persisted).toContain(owner);
      return { content: [], details: {}, terminate: true };
    });
    const response = createAssistantMessageEventStream();
    response.push({
      type: "done",
      reason: stopReason,
      message: assistant([call("lookup")], stopReason),
    });
    response.end();
    const result = await runAgentLoop(
      [{ role: "user", content: "look up", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: [tool("lookup", execute)] },
      { model, convertToLlm: (messages) => messages as Context["messages"] },
      (event) => recordMessage(event, persisted),
      undefined,
      () => response,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(persisted);
    expect(result.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "lookup",
      isError: false,
    });
  },
);

it("persists async calls before admission, streams the remaining answer, and executes each call once", async () => {
  const response = createAssistantMessageEventStream();
  const gate = createDeferred();
  const source = call("lookup");
  const ordinary = call("ordinary", false);
  const persisted: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const executionOrder: string[] = [];
  const contexts: Context[] = [];
  const lookup = vi.fn(async () => {
    const owner = getAgentToolExecutionContext()?.assistantMessage;
    expect(persisted).toContain(owner);
    expect(owner?.turnId).toBeTruthy();
    executionOrder.push("lookup");
    await gate.promise;
    return { content: [{ type: "text" as const, text: "lookup result" }], details: {} };
  });
  const ordinaryExecute = vi.fn(async () => {
    executionOrder.push("ordinary");
    return { content: [], details: {} };
  });
  const streamFn: StreamFn = (_model, context) => {
    contexts.push({ messages: structuredClone(context.messages) });
    if (contexts.length === 1) {
      return response;
    }
    const final = createAssistantMessageEventStream();
    final.push({
      type: "done",
      reason: "stop",
      message: assistant([{ type: "text", text: "done" }]),
    });
    final.end();
    return final;
  };
  const run = runAgentLoop(
    [{ role: "user", content: "look up", timestamp: 0 }],
    {
      systemPrompt: "",
      messages: [],
      tools: [tool("lookup", lookup), tool("ordinary", ordinaryExecute)],
    },
    {
      model,
      convertToLlm: (messages) => messages as Context["messages"],
      beforeToolBatch: async ({ calls }) =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls: () => executionOrder.push(`admit:${calls[0]?.toolCall.id}`),
            releaseSkippedCalls: () => {},
          },
        ),
    },
    (event) => {
      events.push(event);
      recordMessage(event, persisted);
    },
    undefined,
    streamFn,
  );
  let closed = false;
  try {
    const prefix = assistant([source], "toolUse");
    response.push({ type: "start", partial: assistant([]) });
    response.push({ type: "toolcall_end", contentIndex: 0, toolCall: source, partial: prefix });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    const text = { type: "text" as const, text: "independent answer" };
    const progress = assistant([source, text]);
    response.push({ type: "text_delta", contentIndex: 1, delta: text.text, partial: progress });
    response.push({
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: ordinary,
      partial: assistant([source, text, ordinary]),
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
        ),
      ).toBe(true),
    );
    expect(ordinaryExecute).not.toHaveBeenCalled();
    const textEvent = events.find(
      (event) =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
    );
    expect(textEvent).toMatchObject({
      assistantMessageEvent: { contentIndex: 0 },
      message: { content: [text] },
    });
    gate.resolve();
    await vi.waitFor(() =>
      expect(persisted.some((message) => message.role === "toolResult")).toBe(true),
    );
    response.push({
      type: "done",
      reason: "toolUse",
      message: assistant([source, text, ordinary], "toolUse"),
    });
    response.end();
    closed = true;
    const result = await run;
    expect(result).toEqual(persisted);
    expect(executionOrder).toEqual(["admit:lookup", "lookup", "admit:ordinary", "ordinary"]);
    expect(
      result
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((item) => item.type === "toolCall")
        .map((item) => item.id),
    ).toEqual(["lookup", "ordinary"]);
    expect(contexts[1]?.messages).toEqual(persisted.slice(0, -1));
    expect(
      persisted
        .filter((message) => message.role === "assistant")
        .map((message) => message.usage.totalTokens),
    ).toEqual([0, 9, 9]);
  } finally {
    gate.resolve();
    if (!closed) {
      response.push({ type: "done", reason: "toolUse", message: assistant([source], "toolUse") });
      response.end();
    }
    await run;
  }
});

it.each(["error", "aborted"] as const)(
  "settles running async tools and fences queued source starts when the response is %s",
  async (stopReason) => {
    const response = createAssistantMessageEventStream();
    const gate = createDeferred();
    const persistTerminal = createDeferred();
    const first = call("first");
    const second = call("second");
    const persisted: AgentMessage[] = [];
    const events: AgentEvent[] = [];
    const firstExecute = vi.fn(async () => {
      await gate.promise;
      return { content: [], details: {} };
    });
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const streamFn = vi.fn(() => response);
    const run = runAgentLoop(
      [{ role: "user", content: "start", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [tool("first", firstExecute), tool("second", secondExecute)],
      },
      {
        model,
        toolExecution: "sequential",
        convertToLlm: (messages) => messages as Context["messages"],
      },
      async (event) => {
        events.push(event);
        recordMessage(event, persisted);
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === stopReason
        ) {
          await persistTerminal.promise;
        }
      },
      undefined,
      streamFn,
    );
    let closed = false;
    try {
      response.push({ type: "start", partial: assistant([]) });
      response.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: first,
        partial: assistant([first]),
      });
      response.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: second,
        partial: assistant([first, second]),
      });
      await vi.waitFor(() => expect(firstExecute).toHaveBeenCalledTimes(1));
      const failure = { ...assistant([first, second], stopReason), errorMessage: "stream failed" };
      response.push({ type: "error", reason: stopReason, error: failure });
      response.end();
      closed = true;
      await vi.waitFor(() =>
        expect(
          persisted.some(
            (message) => message.role === "assistant" && message.stopReason === stopReason,
          ),
        ).toBe(true),
      );
      expect(events.at(-1)?.type).not.toBe("agent_end");
      gate.resolve();
      await vi.waitFor(() =>
        expect(persisted.filter((message) => message.role === "toolResult")).toHaveLength(2),
      );
      expect(secondExecute).not.toHaveBeenCalled();
      persistTerminal.resolve();
      const result = await run;
      expect(result).toEqual(persisted);
      expect(secondExecute).not.toHaveBeenCalled();
      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(
        result
          .filter((message) => message.role === "toolResult")
          .map((message) => ({ id: message.toolCallId, isError: message.isError })),
      ).toEqual([
        { id: "first", isError: false },
        { id: "second", isError: true },
      ]);
      expect(events.at(-1)?.type).toBe("agent_end");
    } finally {
      gate.resolve();
      persistTerminal.resolve();
      if (!closed) {
        const failure = {
          ...assistant([first, second], stopReason),
          errorMessage: "stream failed",
        };
        response.push({ type: "error", reason: stopReason, error: failure });
        response.end();
      }
      await run;
    }
  },
);

it.each([
  "runtime-first",
  "thrown-runtime",
  "thrown-caller",
  "coded-runtime",
  "caller-first",
  "runtime-then-caller",
  "provider-first",
  "listener",
  "termination",
] as const)("preserves async failure ownership when %s", async (boundary) => {
  const fatalReady = createDeferred();
  const terminalRead = createDeferred();
  const failure = Object.assign(new Error("opaque admission failure"), {
    code: boundary === "coded-runtime" ? "RUNTIME_ADMISSION" : undefined,
  });
  const source = call("lookup");
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const commitReadyCalls = vi.fn(() => {
    if (boundary === "caller-first" || boundary === "thrown-caller") {
      agent.abort();
    }
    throw failure;
  });
  let requests = 0;
  const streamFn: StreamFn = (_model, _context, options) => {
    const signal = options?.signal;
    if (!signal) {
      throw new Error("expected the provider execution signal");
    }
    const firstRecovery = ++requests === 1 && boundary === "termination";
    const response = createAssistantMessageEventStream();
    const aborted = createDeferred();
    const onAbort = () => {
      if (boundary === "runtime-then-caller") {
        agent.abort();
      }
      aborted.resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
        try {
          yield { type: "start", partial: assistant([]) };
          yield {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: source,
            partial: assistant([source]),
          };
          if (firstRecovery) {
            response.push({ type: "done", reason: "stop", message: assistant([source]) });
            response.end();
          } else {
            await (boundary === "provider-first" ? fatalReady.promise : aborted.promise);
            const error =
              boundary === "provider-first"
                ? new Error("provider failed first")
                : transportAbortError(signal);
            if (boundary !== "provider-first") {
              expect(error.message).toBe(
                boundary === "coded-runtime" ? failure.message : "Request was aborted",
              );
            }
            if (boundary === "thrown-runtime" || boundary === "thrown-caller") {
              throw error;
            }
            failTransportStream({ stream: response, output: assistant([source]), signal, error });
          }
          yield* response;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      result() {
        terminalRead.resolve();
        return response.result();
      },
    };
  };
  const agent = new Agent({
    initialState: { model, tools: [tool("lookup", execute)] },
    streamFn,
    afterToolOutcome: async () => {
      fatalReady.resolve();
      if (boundary === "provider-first") {
        await terminalRead.promise;
      }
      return undefined;
    },
  });
  setInternalBeforeToolBatch(agent, async () => {
    if (boundary === "listener") {
      return undefined;
    }
    if (boundary === "termination") {
      return {
        intervention: {
          kind: "critical-tool-loop",
          toolCallId: source.id,
          toolName: source.name,
          actionKey: "lookup:same-action",
          detector: "generic_repeat",
          count: 20,
          reason: "Repeated tool action",
        },
      };
    }
    return attachInternalToolBatchLifecycle(
      {},
      {
        commitReadyCalls,
        releaseSkippedCalls: () => {},
      },
    );
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (boundary === "listener" && event.type === "tool_execution_start") {
      throw failure;
    }
  });
  await agent.prompt("look up");
  const terminal = agent.state.messages.findLast((message) => message.role === "assistant");
  const runtime =
    boundary !== "caller-first" && boundary !== "thrown-caller" && boundary !== "provider-first";
  expect(
    terminal?.diagnostics?.some((entry) => entry.type === "synthesized_run_failure") ?? false,
  ).toBe(runtime);
  expect(terminal?.stopReason).toBe(
    boundary === "provider-first" || boundary === "listener" || boundary === "thrown-runtime"
      ? "error"
      : "aborted",
  );
  expect(terminal?.errorCode).toBe(boundary === "coded-runtime" ? "RUNTIME_ADMISSION" : undefined);
  expect(events.at(-1)?.type).toBe("agent_end");
  expect(requests).toBe(boundary === "termination" ? 2 : 1);
  expect(commitReadyCalls).toHaveBeenCalledTimes(
    boundary === "listener" || boundary === "termination" ? 0 : 1,
  );
  expect(execute).not.toHaveBeenCalled();
  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.pendingToolCalls.size).toBe(0);
});
