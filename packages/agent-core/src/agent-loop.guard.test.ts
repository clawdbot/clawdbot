// Guard tests for the agent run-loop safety cutoffs: maxTurns,
// maxConsecutiveErrorBatches, and maxIdleRepeatCalls. Kept in this colocated
// file so agent-loop.test.ts stays under the max-lines lint limit.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import { Agent } from "./agent.js";
import { attachInternalSyncSteeringGetter } from "./internal-hooks.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Message,
  type Model,
} from "./llm.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeGuardAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: TEST_USAGE,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

function makeGuardTurnSequenceStream(
  turns: AssistantMessage["content"][],
  requestMessages: Message[][],
): StreamFn {
  let turnIndex = 0;
  return (_activeModel, context) => {
    requestMessages.push(context.messages.slice());
    const content = turns[turnIndex];
    turnIndex += 1;
    if (!content) {
      throw new Error(`unexpected provider request ${turnIndex}`);
    }
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = makeGuardAssistantMessage(content);
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };
}

describe("agentLoop maxTurns guard", () => {
  function makeGuardTool(name: string, executed: string[]): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        executed.push(name);
        return {
          content: [{ type: "text", text: `${name} result` }],
          details: { name },
        };
      },
    };
  }

  function lastAssistantText(messages: AgentMessage[]): string {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") {
      return "";
    }
    return last.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  function toolUseTurn(id: string, name: string, args: Record<string, unknown> = {}) {
    return [{ type: "toolCall" as const, id, name, arguments: args }];
  }

  it("terminates gracefully after maxTurns assistant responses", async () => {
    const executed: string[] = [];
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      toolUseTurn("call-1", "work"),
      toolUseTurn("call-2", "work"),
      toolUseTurn("call-3", "work"),
      toolUseTurn("call-4", "work"),
      toolUseTurn("call-5", "work"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [makeGuardTool("work", executed)] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxTurns: 2,
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(2);
    expect(executed).toEqual(["work", "work"]);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(lastAssistantText(agent.state.messages)).toContain("maximum of 2 assistant turns");
  });

  it("does not terminate when maxTurns is unset", async () => {
    const executed: string[] = [];
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      toolUseTurn("call-1", "work"),
      toolUseTurn("call-2", "work"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [makeGuardTool("work", executed)] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(3);
    expect(executed).toEqual(["work", "work"]);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("does not replace a natural stop that coincides with the limit", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      toolUseTurn("call-1", "work"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [makeGuardTool("work", [])] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxTurns: 2,
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(2);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
    expect(lastAssistantText(agent.state.messages)).not.toContain("maxTurns");
  });

  it("resets the turn budget on continuation", async () => {
    const requestMessages1: Message[][] = [];
    const stream1 = agentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [makeGuardTool("work", [])] },
      // Stop after the first tool turn so the run ends on a toolResult (the
      // loop always requests another provider turn after a tool batch).
      { ...config, maxTurns: 2, shouldStopAfterTurn: () => true },
      undefined,
      makeGuardTurnSequenceStream([toolUseTurn("call-1", "work")], requestMessages1),
    );
    await collectEvents(stream1);
    const result1 = await stream1.result();
    expect(requestMessages1).toHaveLength(1);
    expect(result1.at(-1)).toMatchObject({ role: "toolResult" });

    // A continuation gets a fresh budget: it may run two more turns and the
    // second one trips the limit again.
    const requestMessages2: Message[][] = [];
    const stream2 = agentLoopContinue(
      { systemPrompt: "", messages: result1, tools: [makeGuardTool("work", [])] },
      { ...config, maxTurns: 2 },
      undefined,
      makeGuardTurnSequenceStream(
        [toolUseTurn("call-2", "work"), toolUseTurn("call-3", "work")],
        requestMessages2,
      ),
    );
    await collectEvents(stream2);
    const result2 = await stream2.result();

    expect(requestMessages2).toHaveLength(2);
    expect(lastAssistantText(result2)).toContain("maximum of 2 assistant turns");
  });

  it("requeues drained steering when the maxTurns guard fires", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      toolUseTurn("call-1", "work"),
      [{ type: "text", text: "redirected" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [makeGuardTool("work", [])] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxTurns: 1,
    });
    agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "toolUse") {
          await Promise.resolve();
          agent.steer({ role: "user", content: "redirect now", timestamp: 2 });
        }
      }
    });

    await agent.prompt("start");

    // The guard fires before the steering turn starts. The steering was
    // drained into the loop (destructively) during tool execution, so the
    // guard must requeue it: it is neither processed this run nor lost.
    expect(requestMessages).toHaveLength(1);
    expect(lastAssistantText(agent.state.messages)).toContain("maximum of 1 assistant turns");
    expect(
      agent.state.messages.some((m) => m.role === "user" && m.content === "redirect now"),
    ).toBe(false);

    // The next run picks the requeued steering up instead of dropping it.
    await agent.continue();
    expect(requestMessages).toHaveLength(2);
    expect(lastAssistantText(agent.state.messages)).toBe("redirected");
  });
});

describe("agentLoop maxConsecutiveErrorBatches guard", () => {
  function failingTool(name: string): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        throw new Error(`${name} exploded`);
      },
    };
  }

  function okTool(name: string): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({
        content: [{ type: "text", text: `${name} ok` }],
        details: {},
      }),
    };
  }

  function turn(id: string, name: string) {
    return [{ type: "toolCall" as const, id, name, arguments: {} }];
  }

  function lastAssistantText(messages: AgentMessage[]): string {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") {
      return "";
    }
    return last.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  it("terminates after maxConsecutiveErrorBatches all-error batches", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "boom"),
      turn("call-2", "boom"),
      turn("call-3", "boom"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [failingTool("boom")] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxConsecutiveErrorBatches: 3,
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(3);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(lastAssistantText(agent.state.messages)).toContain(
      "3 consecutive tool batches in a row ended in errors",
    );
  });

  it("resets the error-batch counter after a successful batch", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "boom"),
      turn("call-2", "boom"),
      turn("call-3", "ok"),
      turn("call-4", "boom"),
      turn("call-5", "boom"),
      turn("call-6", "boom"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [failingTool("boom"), okTool("ok")] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxConsecutiveErrorBatches: 3,
    });
    await agent.prompt("start");

    // 2 errors -> success resets -> 3 errors trip the guard on the 6th request.
    expect(requestMessages).toHaveLength(6);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "3 consecutive tool batches in a row ended in errors",
    );
  });

  it("does not terminate while batches mix errors and successes", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "boom"),
      turn("call-2", "ok"),
      turn("call-3", "boom"),
      turn("call-4", "ok"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [failingTool("boom"), okTool("ok")] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxConsecutiveErrorBatches: 3,
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(5);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("does not count steering-skipped batches as error batches", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "boom"),
      turn("call-2", "boom"),
      turn("call-3", "boom"),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [failingTool("boom")] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxConsecutiveErrorBatches: 3,
      toolExecution: "sequential",
    });
    let steerIndex = 0;
    agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "toolUse") {
          await Promise.resolve();
          steerIndex += 1;
          agent.steer({ role: "user", content: "stop please", timestamp: 1 + steerIndex });
        }
      }
    });

    await agent.prompt("start");

    // Steering interruptions are not tool failures: three in a row must not
    // trip the consecutive error-batch guard or misreport the run as errors.
    expect(requestMessages).toHaveLength(4);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("resets the error-batch counter on continuation", async () => {
    const requestMessages1: Message[][] = [];
    const stream1 = agentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [failingTool("boom")] },
      // Stop after the first tool turn so the run ends on a toolResult.
      { ...config, maxConsecutiveErrorBatches: 3, shouldStopAfterTurn: () => true },
      undefined,
      makeGuardTurnSequenceStream([turn("call-1", "boom")], requestMessages1),
    );
    await collectEvents(stream1);
    const result1 = await stream1.result();
    // One error batch stays under the 3-batch limit and the run ends naturally.
    expect(requestMessages1).toHaveLength(1);
    expect(result1.at(-1)).toMatchObject({ role: "toolResult" });

    const requestMessages2: Message[][] = [];
    const stream2 = agentLoopContinue(
      { systemPrompt: "", messages: result1, tools: [failingTool("boom")] },
      { ...config, maxConsecutiveErrorBatches: 3 },
      undefined,
      makeGuardTurnSequenceStream(
        [turn("call-3", "boom"), turn("call-4", "boom"), turn("call-5", "boom")],
        requestMessages2,
      ),
    );
    await collectEvents(stream2);
    const result2 = await stream2.result();

    expect(requestMessages2).toHaveLength(3);
    expect(lastAssistantText(result2)).toContain(
      "3 consecutive tool batches in a row ended in errors",
    );
  });
});

describe("agentLoop maxIdleRepeatCalls guard", () => {
  function pingTool(): AgentTool {
    return {
      name: "ping",
      label: "ping",
      description: "ping",
      parameters: Type.Any(),
      execute: async () => ({
        content: [{ type: "text", text: "pong" }],
        details: {},
      }),
    };
  }

  function otherTool(): AgentTool {
    return {
      name: "other",
      label: "other",
      description: "other",
      parameters: Type.Any(),
      execute: async () => ({
        content: [{ type: "text", text: "other ok" }],
        details: {},
      }),
    };
  }

  function turn(id: string, name: string, args: Record<string, unknown>) {
    return [{ type: "toolCall" as const, id, name, arguments: args }];
  }

  function lastAssistantText(messages: AgentMessage[]): string {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") {
      return "";
    }
    return last.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  it("terminates on identical repeated calls even when results succeed", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", args),
      turn("call-2", "ping", args),
      turn("call-3", "ping", args),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    // Success results do not hide the loop: the guard keys on name + args only.
    expect(requestMessages).toHaveLength(3);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
  });

  it("counts identical parallel calls as one observed repeat", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      [
        { type: "toolCall", id: "call-1", name: "ping", arguments: args },
        { type: "toolCall", id: "call-2", name: "ping", arguments: args },
        { type: "toolCall", id: "call-3", name: "ping", arguments: args },
      ],
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    // One parallel batch of three identical calls is a single observed model
    // decision: the calls were prepared/executed concurrently with no result
    // or retry interval between them, so it must not trip the guard by itself.
    expect(requestMessages).toHaveLength(2);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("trips after the identical call repeats across three observed turns", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      [
        { type: "toolCall", id: "call-1", name: "ping", arguments: args },
        { type: "toolCall", id: "call-2", name: "ping", arguments: args },
      ],
      [{ type: "toolCall", id: "call-3", name: "ping", arguments: args }],
      [{ type: "toolCall", id: "call-4", name: "ping", arguments: args }],
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    // Turn 1 (two parallel pings) = one observed repeat, turn 2 = two,
    // turn 3 = three: the guard fires after the third provider request.
    expect(requestMessages).toHaveLength(3);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
  });

  it("trips when alternating parallel batches repeat two signatures across turns", async () => {
    const requestMessages: Message[][] = [];
    const argsA = { url: "https://mam.example/v1/status", mode: "poll" };
    const argsB = { url: "https://mam.example/v2/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      [
        { type: "toolCall", id: "call-1", name: "ping", arguments: argsA },
        { type: "toolCall", id: "call-2", name: "ping", arguments: argsB },
      ],
      [
        { type: "toolCall", id: "call-3", name: "ping", arguments: argsA },
        { type: "toolCall", id: "call-4", name: "ping", arguments: argsB },
      ],
      [
        { type: "toolCall", id: "call-5", name: "ping", arguments: argsA },
        { type: "toolCall", id: "call-6", name: "ping", arguments: argsB },
      ],
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    // Each alternating batch is one observed occurrence per signature. A
    // single shared streak would reset on every A/B switch and never trip;
    // per-signature streaks reach 3 on the third batch.
    expect(requestMessages).toHaveLength(3);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
  });

  it("requeues drained steering when a post-tool guard fires", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", args),
      turn("call-2", "ping", args),
      turn("call-3", "ping", args),
      [{ type: "text", text: "redirected" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    // Inject steering during the third turn's tool execution (after
    // tool_execution_end fires). The ping has already executed and its
    // signature counts toward the idle-repeat streak, but the steering is
    // drained at the post-execution checkpoint and must be requeued when the
    // guard fires.
    let toolExecCount = 0;
    agent.subscribe(async (event) => {
      if (event.type === "tool_execution_end" && event.toolName === "ping") {
        await Promise.resolve();
        toolExecCount += 1;
        if (toolExecCount === 3) {
          agent.steer({ role: "user", content: "stop and redirect", timestamp: 10 });
        }
      }
    });

    await agent.prompt("start");

    // The third identical ping trips the idle-repeat guard. The steering
    // drained during that tool batch is requeued: not processed this run,
    // not lost.
    expect(requestMessages).toHaveLength(3);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
    expect(
      agent.state.messages.some((m) => m.role === "user" && m.content === "stop and redirect"),
    ).toBe(false);

    // The next run processes the requeued steering.
    await agent.continue();
    expect(requestMessages).toHaveLength(4);
    expect(lastAssistantText(agent.state.messages)).toBe("redirected");
  });

  it("requeues two drained steering messages in their original FIFO order", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", args),
      turn("call-2", "ping", args),
      turn("call-3", "ping", args),
      [{ type: "text", text: "after-first" }],
      [{ type: "text", text: "after-second" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    // Inject two steering messages during the third turn's tool execution.
    // The ping has already executed and counts toward the idle-repeat streak;
    // the drained steering messages must be requeued in FIFO order when the
    // guard fires.
    let toolExecCount = 0;
    agent.subscribe(async (event) => {
      if (event.type === "tool_execution_end" && event.toolName === "ping") {
        await Promise.resolve();
        toolExecCount += 1;
        if (toolExecCount === 3) {
          agent.steer({ role: "user", content: "first", timestamp: 10 });
          agent.steer({ role: "user", content: "second", timestamp: 11 });
        }
      }
    });

    await agent.prompt("start");

    // The guard fires after the third identical ping. In one-at-a-time mode
    // only "first" was drained into the run; "second" is still in the queue.
    expect(requestMessages).toHaveLength(3);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );

    // Requeue must restore FIFO order: "first" (drained first) is processed
    // before "second" (still queued) in the next run.
    await agent.continue();
    expect(requestMessages).toHaveLength(5);
    expect(requestMessages[3]?.findLast((m) => m.role === "user")).toMatchObject({
      content: "first",
    });
    expect(requestMessages[4]?.findLast((m) => m.role === "user")).toMatchObject({
      content: "second",
    });
    expect(lastAssistantText(agent.state.messages)).toBe("after-second");
  });

  it("resets the idle counter when the signature changes", async () => {
    const requestMessages: Message[][] = [];
    const first = { url: "https://mam.example/v1/status", mode: "poll" };
    const second = { url: "https://mam.example/v1/status", mode: "watch" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", first),
      turn("call-2", "ping", first),
      turn("call-3", "ping", second),
      turn("call-4", "ping", first),
      turn("call-5", "ping", first),
      turn("call-6", "ping", first),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    // 2x first -> second (reset) -> 3x first trips the guard on the 6th request.
    expect(requestMessages).toHaveLength(6);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
  });

  it("does not terminate while the signature keeps changing", async () => {
    const requestMessages: Message[][] = [];
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", { url: "a" }),
      turn("call-2", "ping", { url: "b" }),
      turn("call-3", "other", { url: "a" }),
      turn("call-4", "ping", { url: "a" }),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool(), otherTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    await agent.prompt("start");

    expect(requestMessages).toHaveLength(5);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("does not reset the idle streak on a tool-less turn", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", args),
      [{ type: "text", text: "thinking between polls" }],
      turn("call-2", "ping", args),
      turn("call-3", "ping", args),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    // Use followUp (not steer) to keep the run going across the tool-less
    // turn: followUp is only checked when the agent would otherwise stop,
    // not at tool-execution checkpoints, so it does not skip tool calls.
    agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        await Promise.resolve();
        agent.followUp({ role: "user", content: "continue", timestamp: 10 });
      }
    });

    await agent.prompt("start");

    // The tool-less turn neither extends nor resets the streak: the third
    // identical ping after the text-only turn still trips the guard (4
    // provider requests total). A reset would need a fifth request.
    expect(requestMessages).toHaveLength(4);
    expect(lastAssistantText(agent.state.messages)).toContain(
      "identical arguments 3 times in a row",
    );
  });

  it("resets the idle counter on continuation", async () => {
    const requestMessages1: Message[][] = [];
    const stream1 = agentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [pingTool()] },
      // Stop after the first tool turn so the run ends on a toolResult.
      { ...config, maxIdleRepeatCalls: 3, shouldStopAfterTurn: () => true },
      undefined,
      makeGuardTurnSequenceStream([turn("call-1", "ping", { url: "a" })], requestMessages1),
    );
    await collectEvents(stream1);
    const result1 = await stream1.result();
    // One ping stays under the 3-repeat limit and the run ends naturally.
    expect(requestMessages1).toHaveLength(1);
    expect(result1.at(-1)).toMatchObject({ role: "toolResult" });

    const requestMessages2: Message[][] = [];
    const stream2 = agentLoopContinue(
      { systemPrompt: "", messages: result1, tools: [pingTool()] },
      { ...config, maxIdleRepeatCalls: 3 },
      undefined,
      makeGuardTurnSequenceStream(
        [
          turn("call-2", "ping", { url: "a" }),
          turn("call-3", "ping", { url: "a" }),
          turn("call-4", "ping", { url: "a" }),
        ],
        requestMessages2,
      ),
    );
    await collectEvents(stream2);
    const result2 = await stream2.result();

    expect(requestMessages2).toHaveLength(3);
    expect(lastAssistantText(result2)).toContain("identical arguments 3 times in a row");
  });

  it("does not count steering-skipped calls as idle repeats (sequential)", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      turn("call-1", "ping", args),
      turn("call-2", "ping", args),
      turn("call-3", "ping", args),
      turn("call-4", "ping", args),
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
      toolExecution: "sequential",
    });
    let steerIndex = 0;
    agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "toolUse") {
          await Promise.resolve();
          steerIndex += 1;
          agent.steer({ role: "user", content: "stop please", timestamp: 1 + steerIndex });
        }
      }
    });

    await agent.prompt("start");

    // Steering interrupts every tool call before execution: no ping ever ran,
    // so no repeated result exists. The idle-repeat guard must not trip on
    // three unexecuted identical requests.
    expect(requestMessages).toHaveLength(5);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });

  it("does not count steering-skipped calls as idle repeats (parallel)", async () => {
    const requestMessages: Message[][] = [];
    const args = { url: "https://mam.example/v1/status", mode: "poll" };
    const turns: AssistantMessage["content"][] = [
      [
        { type: "toolCall", id: "call-1", name: "ping", arguments: args },
        { type: "toolCall", id: "call-2", name: "ping", arguments: args },
        { type: "toolCall", id: "call-3", name: "ping", arguments: args },
      ],
      [
        { type: "toolCall", id: "call-4", name: "ping", arguments: args },
        { type: "toolCall", id: "call-5", name: "ping", arguments: args },
        { type: "toolCall", id: "call-6", name: "ping", arguments: args },
      ],
      [
        { type: "toolCall", id: "call-7", name: "ping", arguments: args },
        { type: "toolCall", id: "call-8", name: "ping", arguments: args },
        { type: "toolCall", id: "call-9", name: "ping", arguments: args },
      ],
      [{ type: "text", text: "done" }],
    ];
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [pingTool()] },
      streamFn: makeGuardTurnSequenceStream(turns, requestMessages),
      maxIdleRepeatCalls: 3,
    });
    let steerIndex = 0;
    agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "toolUse") {
          await Promise.resolve();
          steerIndex += 1;
          agent.steer({ role: "user", content: "stop please", timestamp: 1 + steerIndex });
        }
      }
    });

    await agent.prompt("start");

    // Three parallel batches, each all-steered-away before any call executes.
    // The identical ping signature appears three times across turns, but no
    // call was ever executed — the guard must not trip.
    expect(requestMessages).toHaveLength(4);
    expect(lastAssistantText(agent.state.messages)).toBe("done");
  });
});

describe("agentLoop guard steering preservation for direct callers", () => {
  function lastAssistantText(messages: AgentMessage[]): string {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") {
      return "";
    }
    return last.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  it("preserves drained steering in the terminal sequence when a guard fires", async () => {
    // Direct agentLoop callers do not supply requeueSteeringMessages, so a
    // guard that fires with drained steering must keep the messages in this
    // run's result instead of dropping them. maxTurns=0 fires the guard
    // before any provider request: the initial steering poll (a destructive
    // drain) leaves the user message in pendingMessages when the guard hits.
    const requestMessages: Message[][] = [];
    const steering: AgentMessage[] = [{ role: "user", content: "queued input", timestamp: 2 }];
    // The public steering contract is async-only; the internal sync hook lets
    // the test model a destructive drain (returns the message once, then []).
    let drained = false;
    const getSteeringMessages = attachInternalSyncSteeringGetter(
      async () => [],
      (): AgentMessage[] => {
        if (drained) {
          return [];
        }
        drained = true;
        return steering;
      },
    );
    const stream = agentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [] },
      {
        ...config,
        maxTurns: 0,
        getSteeringMessages,
      },
      undefined,
      makeGuardTurnSequenceStream([], requestMessages),
    );
    const events = await collectEvents(stream);
    const result = await stream.result();

    // No provider request was made; the guard fired with the drained
    // steering still pending.
    expect(requestMessages).toHaveLength(0);
    expect(lastAssistantText(result)).toContain("maximum of 0 assistant turns");
    // The drained steering is preserved in the terminal sequence (not lost).
    expect(result.some((m) => m.role === "user" && m.content === "queued input")).toBe(true);
    // The preserved user message is emitted before the terminal guard message.
    const userIndex = events.findIndex(
      (event) => event.type === "message_end" && event.message.role === "user",
    );
    const terminalIndex = events.findIndex(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.content.some(
          (part) => part.type === "text" && part.text.includes("maximum of 0 assistant turns"),
        ),
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(userIndex);
  });
});
