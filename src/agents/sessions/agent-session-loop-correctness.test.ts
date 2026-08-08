import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  appendHistory,
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  mockInvalidThenTextSummary,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession loop correctness", () => {
  it("carries the canonical assistant entry id through ordered terminal listeners", async () => {
    const assistant = createAssistant(testModel, [{ type: "text", text: "same answer" }]);
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({ ...assistant });
    streamMocks.streamSimple.mockImplementation(() => createAssistantResultStream(assistant));
    const appendMessage = vi.spyOn(sessionManager, "appendMessage");
    const { session } = await createTestSession({ sessionManager });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let promptSettled = false;
    let terminalEntryId: string | undefined;

    session.subscribe(async (event) => {
      if (event.type !== "agent_end") {
        return;
      }
      terminalEntryId = event.assistantEntryId;
      order.push("first:start");
      session.subscribe((lateEvent) => {
        if (lateEvent.type === "agent_end") {
          order.push("late");
        }
      });
      unsubscribeSecond();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      throw new Error("listener rejected");
    });
    const unsubscribeSecond = session.subscribe(async (event) => {
      if (event.type === "agent_end") {
        order.push("second");
      }
    });

    const prompt = session.prompt("new prompt").then(() => {
      promptSettled = true;
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    expect(promptSettled).toBe(false);

    releaseFirst?.();
    await prompt;

    const persistedAssistantCall = appendMessage.mock.results.findLast(
      (result) => result.type === "return",
    );
    expect(terminalEntryId).toBe(persistedAssistantCall?.value);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("emits agent_settled once after a normal run", async () => {
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_end", [async () => lifecycleEvents.push("agent_end")]],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      ),
    );
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });

    await session.prompt("new prompt");

    expect(lifecycleEvents).toEqual(["agent_end", "agent_settled"]);
  });

  it("manually compacts a completed turn smaller than the retained-token budget", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "short answer" }]),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 10_000 },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });

    const result = await session.compact();

    expect(result.summary).toBe("condensed history");
    expect(sessionManager.getBranch().at(-1)).toMatchObject({
      type: "compaction",
      summary: "condensed history",
    });
  });

  it("keeps a successful high-usage response and performs threshold maintenance without retry", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "complete answer" }],
      }),
    );
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("skips threshold maintenance when embedded auto-compaction is disabled", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
  });

  it("does not retry a high-usage turn terminated by a tool result", async () => {
    const terminalTool: ToolDefinition = {
      name: "finish",
      label: "Finish",
      description: "finishes the current run",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "finished" }],
        details: {},
        terminate: true,
      }),
    };
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-finish", name: "finish", arguments: {} }],
          "toolUse",
          100,
        ),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      customTools: [terminalTool],
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("finish now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("compacts and retries a high-usage length-truncated response", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let requestCount = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      requestCount += 1;
      return createAssistantResultStream(
        requestCount === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true }),
    );
    expect(session.getLastAssistantText()).toBe("complete retry");
  });

  it("retries a reasoning-only summary once during default auto-compaction", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      const isSummary = context.systemPrompt?.includes("context summarization assistant") === true;
      if (isSummary) {
        summaryRequests += 1;
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            summaryRequests === 1
              ? [{ type: "thinking", thinking: "internal summary reasoning" }]
              : [{ type: "text", text: "recovered default summary" }],
          ),
        );
      }
      agentRequests += 1;
      return createAssistantResultStream(
        agentRequests === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 2, summaryRequests: 2 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true }),
    );
    const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({ type: "compaction", fromHook: false });
    expect(compactionEntry?.summary).toContain("recovered default summary");
    expect(session.getLastAssistantText()).toBe("complete retry");
  });

  it("shares invalid-summary recovery with caller-owned automatic compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "historical answer to summarize" }]),
    );
    const settingsManager = createAutoCompactionSettings();
    const getSummaryRequests = mockInvalidThenTextSummary("recovered caller-owned summary");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(),
    });

    const result = await session[agentSessionAutomaticCompaction]();

    expect(getSummaryRequests()).toBe(2);
    expect(result.summary).toContain("recovered caller-owned summary");
    const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
  });

  it("keeps public manual compaction one-shot for invalid summary output", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "historical answer to summarize" }]),
    );
    const settingsManager = createAutoCompactionSettings();
    const getSummaryRequests = mockInvalidThenTextSummary("must not be requested");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(),
    });

    await expect(session.compact()).rejects.toThrow(
      "Turn prefix summarization failed: model returned no summary text",
    );

    expect(getSummaryRequests()).toBe(1);
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("stops default auto-compaction after two invalid summaries", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      if (context.systemPrompt?.includes("context summarization assistant")) {
        summaryRequests += 1;
        return createAssistantResultStream(
          createAssistant(activeModel, [
            { type: "thinking", thinking: `internal summary reasoning ${summaryRequests}` },
          ]),
        );
      }
      agentRequests += 1;
      return createAssistantResultStream(createOverflowAssistant(activeModel));
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 1, summaryRequests: 2 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "overflow",
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed: Turn prefix summarization failed: model returned no summary text",
      }),
    );
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it.each([1, 2])(
    "preserves cancellation when aborting during summary attempt %i",
    async (abortAttempt) => {
      const settingsManager = createAutoCompactionSettings();
      const compactionEvents: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
      let agentRequests = 0;
      let summaryRequests = 0;
      const created = await createTestSession({
        settingsManager,
        resourceLoader: createResourceLoader(),
      });
      const { session } = created;
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        if (context.systemPrompt?.includes("context summarization assistant")) {
          const summaryAttempt = ++summaryRequests;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            if (summaryAttempt === abortAttempt) {
              session?.abortCompaction();
            }
            stream.push({
              type: "done",
              reason: "stop",
              message: createAssistant(activeModel, [
                { type: "thinking", thinking: `internal summary reasoning ${summaryAttempt}` },
              ]),
            });
            stream.end();
          });
          return stream;
        }
        agentRequests += 1;
        return createAssistantResultStream(createOverflowAssistant(activeModel));
      });
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactionEvents.push(event);
        }
      });

      await session.prompt("long request");

      expect({ agentRequests, summaryRequests }).toEqual({
        agentRequests: 1,
        summaryRequests: abortAttempt,
      });
      expect(compactionEvents).toHaveLength(1);
      expect(compactionEvents[0]).toMatchObject({
        type: "compaction_end",
        reason: "overflow",
        aborted: true,
        willRetry: false,
      });
      expect(compactionEvents[0]?.errorMessage).toBeUndefined();
      expect(created.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
        false,
      );
    },
  );

  it("does not retry provider errors during default auto-compaction", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      if (context.systemPrompt?.includes("context summarization assistant")) {
        summaryRequests += 1;
        return createAssistantResultStream({
          ...createAssistant(activeModel, [], "error"),
          errorMessage: "provider unavailable",
        });
      }
      agentRequests += 1;
      return createAssistantResultStream(createOverflowAssistant(activeModel));
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 1, summaryRequests: 1 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "overflow",
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed: Turn prefix summarization failed: provider unavailable",
      }),
    );
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("leaves reactive overflow recovery to the caller when configured", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream({
        ...createAssistant(activeModel, [], "error", 100),
        errorMessage: "400 Your input exceeds the context window of this model",
      }),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      contextOverflowRecoveryOwner: "caller",
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
    });
  });

  it("keeps threshold maintenance session-owned when the caller owns overflow recovery", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      contextOverflowRecoveryOwner: "caller",
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("delivers a pending prompt immediately after pre-prompt compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "old answer" }], "stop", 100),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "new answer" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    const continueRun = vi.spyOn(session.agent, "continue");

    await session.prompt("pending prompt");

    expect(continueRun).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("pending prompt");
  });
});
