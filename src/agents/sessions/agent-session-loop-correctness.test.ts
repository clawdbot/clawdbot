import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
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
import { clearExtensionCache, loadExtensionsCached } from "./extensions/loader.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { getSteeringMessageIdentity } from "./steering-message-identity.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const completedCompactionEvent = (reason: "threshold" | "overflow", willRetry: boolean) =>
  expect.objectContaining({
    type: "compaction_end",
    reason,
    outcome: expect.objectContaining({ status: "completed", willRetry }),
  });

describe("AgentSession loop correctness", () => {
  it("publishes a queued user message only after its transcript entry is committed", async () => {
    const { session, sessionManager } = await createTestSession();
    type QueuedMessage = Parameters<SessionManager["appendMessage"]>[0];
    const queuedMessages = (
      session.agent as unknown as { steeringQueue: { messages: QueuedMessage[] } }
    ).steeringQueue.messages;
    const handleAgentEvent = Reflect.get(session, "handleAgentEvent") as (event: {
      type: "message_start" | "message_end";
      message: QueuedMessage;
    }) => Promise<void>;
    const observedPersistedMessages: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        observedPersistedMessages.push(
          sessionManager
            .getEntries()
            .some(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.timestamp === event.message.timestamp,
            ),
        );
      }
    });
    const abortController = new AbortController();
    const wait = steerActiveSessionWithOptionalDeliveryWait(session, "commit before receipt", {
      deliveryTimeoutMs: 10_000,
      waitForTranscriptCommit: true,
      abortSignal: abortController.signal,
    });

    try {
      await vi.waitFor(() => expect(queuedMessages).toHaveLength(1));
      const message = queuedMessages.shift();
      expect(message).toBeDefined();
      if (!message) {
        return;
      }
      await handleAgentEvent({ type: "message_start", message });
      await handleAgentEvent({ type: "message_end", message });
      await expect(wait).resolves.toBeUndefined();

      expect(observedPersistedMessages).toEqual([true]);
    } finally {
      abortController.abort();
      await Promise.allSettled([wait]);
    }
  });

  it("rejects a consumed steer immediately when its transcript append fails", async () => {
    const { session, sessionManager } = await createTestSession();
    type QueuedMessage = Parameters<SessionManager["appendMessage"]>[0];
    const queuedMessages = (
      session.agent as unknown as { steeringQueue: { messages: QueuedMessage[] } }
    ).steeringQueue.messages;
    const handleAgentEvent = Reflect.get(session, "handleAgentEvent") as (event: {
      type: "message_start" | "message_end";
      message: QueuedMessage;
    }) => Promise<void>;
    const persistenceError = new Error("SQLite transcript append failed");
    vi.spyOn(sessionManager, "appendMessage").mockImplementation(() => {
      throw persistenceError;
    });
    const publishedUserMessages: unknown[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        publishedUserMessages.push(event.message);
      }
    });
    let sourceConsumed = false;
    const abortController = new AbortController();
    const wait = steerActiveSessionWithOptionalDeliveryWait(session, "retain queued source", {
      deliveryTimeoutMs: 10_000,
      waitForTranscriptCommit: true,
      abortSignal: abortController.signal,
    }).then(() => {
      sourceConsumed = true;
    });
    const rejection = expect(wait).rejects.toBe(persistenceError);

    try {
      await vi.waitFor(() => expect(queuedMessages).toHaveLength(1));
      const message = queuedMessages.shift();
      expect(message).toBeDefined();
      if (!message) {
        return;
      }
      await handleAgentEvent({ type: "message_start", message });
      await expect(handleAgentEvent({ type: "message_end", message })).rejects.toBe(
        persistenceError,
      );
      await rejection;

      expect(sourceConsumed).toBe(false);
      expect(publishedUserMessages).toEqual([]);
      expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
    } finally {
      abortController.abort();
      await Promise.allSettled([wait, rejection]);
    }
  });

  it.each([2, 3])(
    "confirms each of %i identical queued messages only after its own transcript commit",
    async (waiterCount) => {
      const { session, sessionManager } = await createTestSession();
      type QueuedMessage = Parameters<SessionManager["appendMessage"]>[0];
      const queuedMessages = (
        session.agent as unknown as { steeringQueue: { messages: QueuedMessage[] } }
      ).steeringQueue.messages;
      const handleAgentEvent = Reflect.get(session, "handleAgentEvent") as (event: {
        type: "message_start" | "message_end";
        message: QueuedMessage;
      }) => Promise<void>;
      const confirmed: number[] = [];
      const waits = Array.from({ length: waiterCount }, (_, index) =>
        steerActiveSessionWithOptionalDeliveryWait(session, "same queued message", {
          deliveryTimeoutMs: 10_000,
          waitForTranscriptCommit: true,
        }).then(() => confirmed.push(index + 1)),
      );

      await vi.waitFor(() => expect(queuedMessages).toHaveLength(waiterCount));
      const originalMessages = [...queuedMessages];

      try {
        for (let index = 0; index < waiterCount; index += 1) {
          const message = queuedMessages.shift();
          expect(message).toBeDefined();
          if (!message) {
            return;
          }
          await handleAgentEvent({ type: "message_start", message });
          await handleAgentEvent({ type: "message_end", message });
          await vi.waitFor(() =>
            expect(confirmed).toEqual(
              Array.from({ length: index + 1 }, (_, position) => position + 1),
            ),
          );
        }
        await Promise.all(waits);

        const identities = originalMessages.map(getSteeringMessageIdentity);
        expect(identities.every((identity) => typeof identity === "string")).toBe(true);
        expect(new Set(identities).size).toBe(waiterCount);
        for (const message of originalMessages) {
          const identitySymbol = Object.getOwnPropertySymbols(message).find(
            (symbol) => symbol === Symbol.for("openclaw.steeringMessageIdentity"),
          );
          expect(identitySymbol).toBeDefined();
          if (identitySymbol) {
            expect(Object.getOwnPropertyDescriptor(message, identitySymbol)?.enumerable).toBe(
              false,
            );
          }
          expect(JSON.stringify(message)).not.toContain(getSteeringMessageIdentity(message));
        }
        const persistedMessages = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message);
        expect(persistedMessages).toHaveLength(waiterCount);
        expect(persistedMessages.every((message) => !getSteeringMessageIdentity(message))).toBe(
          true,
        );
      } finally {
        for (const message of queuedMessages.splice(0)) {
          await handleAgentEvent({ type: "message_end", message });
        }
        await Promise.allSettled(waits);
      }
    },
  );

  it("snapshots ordinary event listeners before self-removal and late subscription", async () => {
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      ),
    );
    const { session } = await createTestSession();
    const observed: string[] = [];
    const unsubscribeFirst = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "user") {
        return;
      }
      observed.push("first");
      unsubscribeFirst();
      session.subscribe((laterEvent) => {
        if (laterEvent.type === "message_end" && laterEvent.message.role === "user") {
          observed.push("late");
        }
      });
    });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        observed.push("second");
      }
    });

    await session.prompt("first prompt");
    expect(observed).toEqual(["first", "second"]);
    await session.prompt("second prompt");
    expect(observed).toEqual(["first", "second", "second", "late"]);
  });

  it("finishes an ordinary event snapshot when another listener is unsubscribed", async () => {
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      ),
    );
    const { session } = await createTestSession();
    const observed: string[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        observed.push("first");
        unsubscribeSecond();
      }
    });
    const unsubscribeSecond = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        observed.push("second");
      }
    });

    await session.prompt("first prompt");

    expect(observed).toEqual(["first", "second"]);
  });

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

  it("does not append when a compaction extension rejects the finalized summary", async () => {
    const dir = tempDirs.make("openclaw-rejected-compaction-");
    const target = {
      agentId: "main",
      sessionId: "rejected-compaction-reopen",
      sessionKey: "agent:main:rejected-compaction-reopen",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    await appendTranscriptMessage(target, {
      cwd: dir,
      message: { role: "user", content: "authoritative question", timestamp: 1 },
    });
    const sessionManager = SessionManager.open(target, dir);
    sessionManager.appendMessage(
      createAssistant(testModel, [{ type: "text", text: "authoritative answer" }]),
    );
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["session_before_compact", [async () => ({ cancel: true })]],
    ]);
    const { session } = await createTestSession({
      sessionManager,
      resourceLoader: createResourceLoader(handlers),
    });
    const persistedBefore = await loadTranscriptEvents(target);
    const contextBefore = sessionManager.buildSessionContext();

    await expect(session.compact()).rejects.toThrow("Compaction cancelled");

    sessionManager.flushPendingPersistence();
    const persistedAfterRejection = await loadTranscriptEvents(target);
    expect(JSON.stringify(persistedAfterRejection)).toBe(JSON.stringify(persistedBefore));
    expect(
      persistedAfterRejection.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          entry.type === "compaction",
      ),
    ).toBe(false);

    const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
    expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
    const reopened = SessionManager.open(target, dir);
    try {
      expect(reopened.getBranch()).toEqual(persistedBefore.slice(1));
      expect(reopened.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
      expect(reopened.buildSessionContext()).toEqual(contextBefore);
    } finally {
      closeOpenClawAgentDatabaseByPath(databasePath);
    }
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
    expect(compactionEvents).toContainEqual(completedCompactionEvent("threshold", false));
  });

  it("surfaces threshold safeguard rejection without appending compaction state", async () => {
    const settingsManager = createAutoCompactionSettings();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["session_before_compact", [async () => ({ cancel: true })]],
    ]);
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(handlers),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(compactionEvents).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "threshold",
        outcome: { status: "aborted" },
      }),
    );
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("does not pre-prompt compact from usage before a zero unavailable marker", async () => {
    const model = { ...testModel, contextWindow: 1_000 };
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(model, [{ type: "text", text: "old cumulative turn" }], "stop", 950),
    );
    sessionManager.appendMessage({ role: "user", content: "CLI prompt", timestamp: Date.now() });
    sessionManager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: "usage unavailable" }]),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        contextUsage: { state: "unavailable" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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

    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      usage: { contextUsage: { state: "unavailable" } },
    });
    expect(session.getContextUsage()?.tokens).toBeLessThan(900);
    await session.prompt("continue after CLI turn");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
    expect(session.getLastAssistantText()).toBe("complete answer");
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

  it.each([
    {
      label: "stops after a plugin terminates a normal result",
      toolTerminate: undefined,
      pluginTerminate: true,
      expectedModelTurns: 1,
    },
    {
      label: "continues after a plugin clears terminal state",
      toolTerminate: true,
      pluginTerminate: false,
      expectedModelTurns: 2,
    },
  ])("$label", async ({ toolTerminate, pluginTerminate, expectedModelTurns }) => {
    const passthroughTool: ToolDefinition = {
      name: "finish_via_middleware",
      label: "Finish via middleware",
      description: "returns a tool result that middleware can update",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "raw tool result" }],
        details: {},
        ...(toolTerminate === undefined ? {} : { terminate: toolTerminate }),
      }),
    };
    const pluginDir = tempDirs.make("openclaw-terminate-plugin-");
    const pluginPath = path.join(pluginDir, "extension.mjs");
    await writeFile(
      pluginPath,
      `export default async function(api) {
  api.on("tool_result", async event => ({ ...event, terminate: ${pluginTerminate} }));
}
`,
    );
    clearExtensionCache();
    const loaded = await loadExtensionsCached([pluginPath], pluginDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect(loaded.extensions[0]?.handlers.get("tool_result")).toHaveLength(1);
    const resourceLoader = {
      ...createResourceLoader(),
      getExtensions: () => loaded,
    };
    let modelTurns = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      modelTurns += 1;
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          modelTurns === 1
            ? [
                {
                  type: "toolCall",
                  id: "call-finish-via-middleware",
                  name: "finish_via_middleware",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: "continued" }],
          modelTurns === 1 ? "toolUse" : "stop",
        ),
      );
    });
    const { session } = await createTestSession({
      resourceLoader,
      customTools: [passthroughTool],
    });

    await session.prompt("finish through loaded middleware");

    expect(modelTurns).toBe(expectedModelTurns);
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
    expect(compactionEvents).toContainEqual(completedCompactionEvent("threshold", false));
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
    expect(compactionEvents).toContainEqual(completedCompactionEvent("overflow", true));
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
    expect(compactionEvents).toContainEqual(completedCompactionEvent("overflow", true));
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
        outcome: {
          status: "failed",
          reason:
            "Context overflow recovery failed: Turn prefix summarization failed: model returned no summary text",
        },
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
        outcome: { status: "aborted" },
      });
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
        outcome: {
          status: "failed",
          reason:
            "Context overflow recovery failed: Turn prefix summarization failed: provider unavailable",
        },
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
    expect(compactionEvents).toContainEqual(completedCompactionEvent("threshold", false));
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
