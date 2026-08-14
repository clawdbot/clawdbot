import type { AssistantMessage, Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import {
  createCompactionHandlers,
  createResourceLoader,
} from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function createStaleThinkingContent(): AssistantMessage["content"] {
  return [
    { type: "thinking", thinking: "old think", thinkingSignature: "stale-thinking" },
    { type: "thinking", thinking: "old think", signature: "stale-signature" },
    { type: "thinking", thinking: "old think", thought_signature: "stale-thought" },
    { type: "redacted_thinking", data: "stale-redacted" },
    { type: "text", text: "retained answer" },
  ] as unknown as AssistantMessage["content"];
}

describe("AgentSession compaction", () => {
  it.each(Array.from({ length: MAX_OVERFLOW_COMPACTION_ATTEMPTS }, (_, index) => index + 1))(
    "recovers when the provider accepts overflow compaction attempt %i",
    async (overflowCount) => {
      let agentRequests = 0;
      streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
        agentRequests += 1;
        const response =
          agentRequests <= overflowCount
            ? createOverflowAssistant(activeModel)
            : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]);
        return createAssistantResultStream({ ...response, timestamp: Date.now() + agentRequests });
      });
      const { session } = await createTestSession({
        settingsManager: createAutoCompactionSettings(),
        resourceLoader: createResourceLoader(createCompactionHandlers()),
      });
      const compactionEvents: AgentSessionEvent[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactionEvents.push(event);
        }
      });

      await session.prompt("long request");

      expect(agentRequests).toBe(overflowCount + 1);
      expect(
        compactionEvents.filter((event) => event.type === "compaction_end" && event.willRetry),
      ).toHaveLength(overflowCount);
      expect(session.getLastAssistantText()).toBe("complete retry");
    },
  );

  it("surfaces the shared overflow recovery limit after exhausting it", async () => {
    let agentRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      agentRequests += 1;
      return createAssistantResultStream({
        ...createOverflowAssistant(activeModel),
        timestamp: Date.now() + agentRequests,
      });
    });
    const { session } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    const compactionEvents: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(MAX_OVERFLOW_COMPACTION_ATTEMPTS + 1);
    expect(compactionEvents.at(-1)).toMatchObject({
      type: "compaction_end",
      reason: "overflow",
      willRetry: false,
      errorMessage: `Context overflow recovery failed after ${MAX_OVERFLOW_COMPACTION_ATTEMPTS} compact-and-retry attempts. Try reducing context or switching to a larger-context model.`,
    });
  });

  it("strips stale thinking signatures before continuing after auto-compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "old prompt",
      timestamp: Date.now() - 3,
    });
    const retainedAssistantId = sessionManager.appendMessage({
      ...createAssistant(testModel, createStaleThinkingContent()),
      timestamp: Date.now() - 2,
    });
    const handlers = createCompactionHandlers();
    handlers.set("session_before_compact", [
      async (event: unknown) => ({
        compaction: {
          summary: "condensed history",
          firstKeptEntryId: retainedAssistantId,
          tokensBefore: (event as { preparation: { tokensBefore: number } }).preparation
            .tokensBefore,
        },
      }),
    ]);
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        requests.length === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(handlers),
    });

    await session.prompt("long request");

    expect(requests).toHaveLength(2);
    const retained = session.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "text" && block.text === "retained answer"),
    );
    expect(retained).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old think" },
        { type: "thinking", thinking: "old think" },
        { type: "thinking", thinking: "old think" },
        { type: "redacted_thinking" },
        { type: "text", text: "retained answer" },
      ],
    });
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("stale-");
  });

  it("sanitizes restored compaction history before pre-prompt maintenance", async () => {
    const model = { ...testModel, contextWindow: 1_000 };
    const sessionManager = SessionManager.inMemory();
    const now = Date.now();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: now - 2 });
    const retainedAssistantId = sessionManager.appendMessage({
      ...createAssistant(model, createStaleThinkingContent(), "stop", 950),
      timestamp: now - 1,
    });
    sessionManager.appendCompaction("condensed history", retainedAssistantId, 950);
    sessionManager.appendMessage({
      role: "user",
      content: "post-compaction prompt",
      timestamp: now + 1_000,
    });
    sessionManager.appendMessage({
      ...createAssistant(model, [], "error"),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        contextUsage: { state: "unavailable" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      errorMessage: "temporary provider error",
      timestamp: now + 1_001,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 20),
      ),
    );
    const { session } = await createTestSession({
      model,
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    const retained = session.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "text" && block.text === "retained answer"),
    );
    expect(retained).toMatchObject({
      role: "assistant",
      usage: { input: 0, output: 0, totalTokens: 0 },
      content: [
        { type: "thinking", thinking: "old think" },
        { type: "thinking", thinking: "old think" },
        { type: "thinking", thinking: "old think" },
        { type: "redacted_thinking" },
        { type: "text", text: "retained answer" },
      ],
    });

    await session.prompt("continue restored session");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
    expect(session.getLastAssistantText()).toBe("complete answer");
  });
});
