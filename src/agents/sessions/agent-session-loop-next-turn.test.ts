import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt.queue-message.js";
import type { AgentTool } from "../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function mockAbortableQueuedRun() {
  const executeTool = vi.fn();
  const requests: Array<{ context: Context; signal: AbortSignal | undefined }> = [];
  const tool: ToolDefinition = {
    name: "queued_action",
    label: "Queued action",
    description: "records whether a queued turn executed",
    parameters: Type.Object({}),
    execute: async () => {
      executeTool();
      return { content: [{ type: "text", text: "action completed" }], details: {} };
    },
  };

  streamMocks.streamSimple.mockImplementation(
    (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
      const requestIndex = requests.length;
      requests.push({ context, signal: options?.signal });
      if (requestIndex === 0) {
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            const message = createAssistant(activeModel, [], "aborted");
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        return stream;
      }

      const content: AssistantMessage["content"] =
        requestIndex === 1
          ? [{ type: "toolCall", id: "queued-action-call", name: tool.name, arguments: {} }]
          : [{ type: "text", text: "queued turn finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requestIndex === 1 ? "toolUse" : "stop"),
      );
    },
  );

  return { executeTool, requests, tool };
}

describe("AgentSession queue and next-turn lifecycle correctness", () => {
  it("drains a follow-up queued by an agent-end handler", async () => {
    const sessionRef: { current?: AgentSession } = {};
    let queued = false;
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "agent_end",
        [
          async () => {
            lifecycleEvents.push("agent_end");
            if (!queued) {
              queued = true;
              await sessionRef.current?.followUp("queued after end");
            }
            return undefined;
          },
        ],
      ],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: `answer ${requests.length}` }]),
      );
    });
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
    sessionRef.current = session;

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("queued after end");
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(lifecycleEvents).toEqual(["agent_end", "agent_end", "agent_settled"]);
  });

  it.each([
    {
      kind: "steering",
      queue: (session: AgentSession) => session.steer("keep queued steering"),
      messages: (session: AgentSession) => session.getSteeringMessages(),
      expected: "keep queued steering",
    },
    {
      kind: "follow-up",
      queue: (session: AgentSession) => session.followUp("keep queued follow-up"),
      messages: (session: AgentSession) => session.getFollowUpMessages(),
      expected: "keep queued follow-up",
    },
  ])("keeps queued $kind dormant after its active run is aborted", async (scenario) => {
    const { executeTool, requests, tool } = mockAbortableQueuedRun();
    const { session } = await createTestSession({ customTools: [tool] });
    const prompt = session.prompt("wait for operator cancellation");
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await scenario.queue(session);
    expect(session.agent.hasQueuedMessages()).toBe(true);

    await Promise.all([session.abort(), prompt]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(session.agent.hasQueuedMessages()).toBe(true);
    expect(scenario.messages(session)).toEqual([scenario.expected]);
  });

  it("cancels only an uncommitted steering confirmation after an aborted turn", async () => {
    const { executeTool, requests, tool } = mockAbortableQueuedRun();
    const { session } = await createTestSession({ customTools: [tool] });
    const prompt = session.prompt("wait for operator cancellation");
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await session.steer("keep unrelated steering");
    await session.followUp("keep unrelated follow-up");
    const delivery = steerActiveSessionWithOptionalDeliveryWait(
      session,
      "cancel only this steering",
      { deliveryTimeoutMs: 10_000, waitForTranscriptCommit: true },
    ).then(
      () => "committed",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() =>
      expect(session.getSteeringMessages()).toEqual([
        "keep unrelated steering",
        "cancel only this steering",
      ]),
    );

    await Promise.all([session.abort(), prompt]);

    await expect(delivery).resolves.toBe(
      "active session ended before queued steering message was committed to the transcript",
    );
    expect(requests).toHaveLength(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(session.getSteeringMessages()).toEqual(["keep unrelated steering"]);
    expect(session.getFollowUpMessages()).toEqual(["keep unrelated follow-up"]);
    expect(session.agent.hasQueuedMessages()).toBe(true);
  });

  it("leaves queued messages dormant after a turn handoff", async () => {
    const sessionRef: { current?: AgentSession } = {};
    const settled = vi.fn();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_settled", [async () => settled()]],
    ]);
    const yieldTool: ToolDefinition = {
      name: "yield_turn",
      label: "Yield turn",
      description: "ends the current turn for an external handoff",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.agent.steer({
          role: "custom",
          customType: "test.turn-handoff",
          content: "resume only for external delivery",
          display: false,
          timestamp: Date.now(),
        });
        activeSession.agent.abort({ code: "turn_handoff", turnHandoff: true });
        return { content: [{ type: "text", text: "yielded" }], details: { yielded: true } };
      },
    };
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-yield", name: "yield_turn", arguments: {} }],
          "toolUse",
        ),
      ),
    );
    const { session } = await createTestSession({
      customTools: [yieldTool],
      resourceLoader: createResourceLoader(handlers),
    });
    sessionRef.current = session;

    await session.prompt("yield now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.agent.hasQueuedMessages()).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    session.agent.clearAllQueues();
  });

  it("applies session model, tool, and prompt changes on the following tool turn", async () => {
    const nextModel = { ...testModel, id: "next-model" };
    const sessionRef: { current?: AgentSession } = {};
    const switchTool: ToolDefinition = {
      name: "switch_state",
      label: "Switch state",
      description: "changes the next turn state",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.setActiveToolsByName(["second_tool"]);
        activeSession.agent.state.model = nextModel;
        return { content: [{ type: "text", text: "switched" }], details: {} };
      },
    };
    const secondTool: ToolDefinition = {
      name: "second_tool",
      label: "Second tool",
      description: "available after the switch",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["before_agent_start", [async () => ({ systemPrompt: "prompt override" })]],
    ]);
    const requests: Array<{ model: string; prompt: string; tools: string[] }> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push({
        model: activeModel.id,
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
      });
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [{ type: "toolCall", id: "call-switch", name: "switch_state", arguments: {} }]
          : [{ type: "text", text: "finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requests.length === 1 ? "toolUse" : "stop"),
      );
    });
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      customTools: [switchTool, secondTool],
    });
    sessionRef.current = session;
    session.setActiveToolsByName(["switch_state"]);

    await session.prompt("switch now");

    expect(requests).toEqual([
      { model: testModel.id, prompt: "prompt override", tools: ["switch_state"] },
      { model: nextModel.id, prompt: "prompt override", tools: ["second_tool"] },
    ]);
  });

  it("preserves explicit updates from an existing next-turn hook", async () => {
    const hookModel = { ...testModel, id: "hook-model" };
    const hookTool: AgentTool = {
      name: "hook_tool",
      label: "Hook tool",
      description: "provided by the existing turn hook",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const hookContext = {
      systemPrompt: "hook prompt",
      messages: [],
      tools: [hookTool],
    };
    let returnedUpdate = false;
    const { session } = await createTestSession();
    session.agent.prepareNextTurn = () => {
      if (returnedUpdate) {
        return undefined;
      }
      returnedUpdate = true;
      return { context: hookContext, model: hookModel, thinkingLevel: "high" };
    };
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const newMessages = [message];

    const firstUpdate = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [] },
      newMessages,
    });
    const secondUpdate = await contextualHook({
      message,
      toolResults: [],
      context: firstUpdate?.context ?? hookContext,
      newMessages,
    });

    for (const update of [firstUpdate, secondUpdate]) {
      expect(update).toMatchObject({
        context: {
          systemPrompt: "hook prompt",
          tools: [expect.objectContaining({ name: "hook_tool" })],
        },
        model: hookModel,
        thinkingLevel: "high",
      });
    }
  });

  it("preserves fields omitted by an existing next-turn context replacement", async () => {
    const sessionTool: AgentTool = {
      name: "session_tool",
      label: "Session tool",
      description: "available in session state",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const initialHook = vi.fn(() => ({
      context: { systemPrompt: "stale prompt", messages: [], tools: [sessionTool] },
    }));
    const replacementHook = vi.fn(() => ({
      context: { systemPrompt: "replacement prompt", messages: [] },
    }));
    const { session } = await createTestSession({ customTools: [sessionTool] });
    session.setActiveToolsByName([sessionTool.name]);
    session.agent.prepareNextTurn = initialHook;
    session.agent.prepareNextTurn = replacementHook;
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }

    const update = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [sessionTool] },
      newMessages: [message],
    });

    expect(update?.context).toEqual({ systemPrompt: "replacement prompt", messages: [] });
    expect(replacementHook).toHaveBeenCalledOnce();
    expect(initialHook).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when disposed", async () => {
    let providerSignal: AbortSignal | undefined;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        providerSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            const message = createAssistant(activeModel, [], "aborted");
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        return stream;
      },
    );
    const { session } = await createTestSession();
    const abortRetry = vi.spyOn(session, "abortRetry");
    const abortCompaction = vi.spyOn(session, "abortCompaction");
    const abortBranchSummary = vi.spyOn(session, "abortBranchSummary");
    const abortBash = vi.spyOn(session, "abortBash");
    const abortAgent = vi.spyOn(session.agent, "abort");
    abortRetry.mockImplementationOnce(() => {
      throw new Error("retry abort failed");
    });
    const prompt = session.prompt("wait");
    await vi.waitFor(() => expect(providerSignal).toBeDefined());

    session.dispose();
    await prompt;

    expect(providerSignal?.aborted).toBe(true);
    expect(abortRetry).toHaveBeenCalledOnce();
    expect(abortCompaction).toHaveBeenCalledOnce();
    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abortBash).toHaveBeenCalledOnce();
    expect(abortAgent).toHaveBeenCalledOnce();
  });

  it("resynchronizes queue modes when settings reload", async () => {
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({ settingsManager });
    settingsManager.setSteeringMode("all");
    settingsManager.setFollowUpMode("all");
    await settingsManager.flush();

    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("one-at-a-time");

    await session.reload();

    expect(session.agent.steeringMode).toBe("all");
    expect(session.agent.followUpMode).toBe("all");
  });
});
