import path from "node:path";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  agentSessionAutomaticCompaction,
  agentSessionSetContextReplacementHook,
} from "./agent-session-compaction.js";
import {
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
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createStaleThinkingContent(): AssistantMessage["content"] {
  return [
    { type: "thinking", thinking: "old think", thinkingSignature: "stale-thinking" },
    { type: "thinking", thinking: "old think", signature: "stale-signature" },
    { type: "thinking", thinking: "old think", thought_signature: "stale-thought" },
    { type: "redacted_thinking", data: "stale-redacted" },
    { type: "text", text: "retained answer" },
  ] as unknown as AssistantMessage["content"];
}

function createResultHandlers(summary: string, firstKeptEntryId?: string) {
  const handlers = createCompactionHandlers();
  handlers.set("session_before_compact", [
    async (event: unknown) => {
      const preparation = (
        event as { preparation: { firstKeptEntryId: string; tokensBefore: number } }
      ).preparation;
      return {
        compaction: {
          summary,
          firstKeptEntryId: firstKeptEntryId ?? preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    },
  ]);
  return handlers;
}

function collectCompactionEnds(session: Awaited<ReturnType<typeof createTestSession>>["session"]) {
  const events: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
  session.subscribe((event) => {
    if (event.type === "compaction_end") {
      events.push(event);
    }
  });
  return events;
}

describe("AgentSession compaction", () => {
  it.each([
    { name: "provider timeout", errorName: "TimeoutError", cancelCaller: false, recovers: false },
    {
      name: "provider timeout recovery",
      errorName: "TimeoutError",
      cancelCaller: false,
      recovers: true,
    },
    { name: "ordinary provider failure", errorName: "Error", cancelCaller: false, recovers: false },
    { name: "provider-side abort", errorName: "AbortError", cancelCaller: false, recovers: true },
    { name: "caller cancellation", errorName: "AbortError", cancelCaller: true, recovers: false },
  ])(
    "preserves the safeguard boundary after $name",
    async ({ errorName, cancelCaller, recovers }) => {
      // A synthetic API plus the registered stream keep both real summarizers offline.
      const model = {
        ...testModel,
        api: "compaction-test-api",
        contextWindow: 4_096,
        maxTokens: 128,
      };
      const summary = recovers
        ? [
            "## Decisions\nThe old prompt was answered.",
            "## Open TODOs\nNone.",
            "## Constraints/Rules\nPreserve the session history.",
            "## Pending user asks\nNone.",
            "## Exact identifiers\nNone.",
          ].join("\n\n")
        : "Core summary without required safeguard headings";
      const recoveredSummary = [
        "## Latest user request context",
        JSON.stringify("old prompt"),
        "",
        summary,
      ].join("\n");
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "old answer" }]),
        timestamp: 2,
      });
      sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
      const providerStarted = createDeferred();
      const releaseProvider = createDeferred();
      const summarize = vi.fn<CompactionProvider["summarize"]>(async () => {
        providerStarted.resolve();
        await releaseProvider.promise;
        throw Object.assign(new Error("synthetic custom-provider failure"), { name: errorName });
      });
      const registration = {
        provider: { id: "session-compaction-test", label: "Session compaction test", summarize },
      };
      const registry = requireActivePluginRegistry();
      registry.compactionProviders.push(registration);
      setCompactionSafeguardRuntime(sessionManager, {
        provider: registration.provider.id,
        model,
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 0,
      });
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request in compaction test"));
      const eventBus = createEventBus();
      try {
        const resourceLoader = createResourceLoader();
        const extensions = resourceLoader.getExtensions();
        extensions.extensions.push(
          await loadExtensionFromFactory(
            compactionSafeguardExtension,
            sessionManager.getCwd(),
            eventBus,
            extensions.runtime,
          ),
        );
        streamMocks.streamSimple.mockImplementation(
          (activeModel: Model, _context: Context, options?: SimpleStreamOptions) =>
            createAssistantResultStream(
              createAssistant(
                activeModel,
                [{ type: "text", text: summary }],
                options?.signal?.aborted ? "aborted" : "stop",
              ),
            ),
        );
        const { session } = await createTestSession({
          model,
          sessionManager,
          resourceLoader,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
        });
        const subscription = subscribeEmbeddedAgentSession({
          session,
          runId: "run-safeguard-summary-usage",
        });
        const entriesBefore = structuredClone(sessionManager.getEntries());
        const messagesBefore = structuredClone(session.messages);
        const compactionEnds = collectCompactionEnds(session);
        const compaction = session.compact().then(
          (result) => ({ status: "resolved", summary: result.summary }),
          (error: unknown) => ({
            status: "rejected",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        // Cancel through the public session API while the custom provider is in flight.
        await Promise.race([providerStarted.promise, compaction]);
        const callerSignal = summarize.mock.calls[0]?.[0].signal;
        const callerAbortedAtProviderEntry = callerSignal?.aborted;
        if (cancelCaller) {
          session.abortCompaction();
        }
        releaseProvider.resolve();
        const result = await compaction;
        const appended = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction")
          .map(({ summary: text, fromHook }) => ({ summary: text, fromHook }));

        const observation = {
          providerCalls: summarize.mock.calls.length,
          callerAbortedAtProviderEntry,
          callerAborted: callerSignal?.aborted,
          result,
          outcomes: compactionEnds.map((event) => event.outcome.status),
          appended,
        };
        expect(subscription.getUsageTotals()?.total ?? 0).toBe(
          streamMocks.streamSimple.mock.calls.length * 2,
        );
        subscription.unsubscribe();
        expect.soft(observation).toMatchObject({
          providerCalls: 1,
          callerAbortedAtProviderEntry: false,
          callerAborted: cancelCaller,
          result: recovers
            ? { status: "resolved", summary: recoveredSummary }
            : { status: "rejected" },
          outcomes: [recovers ? "completed" : "aborted"],
          appended: recovers ? [{ summary: recoveredSummary, fromHook: true }] : [],
        });
        // The guarded pipeline may chunk the history; do not pin its request count.
        if (!cancelCaller) {
          expect(streamMocks.streamSimple).toHaveBeenCalled();
        }
        if (!recovers) {
          expect.soft(sessionManager.getEntries()).toEqual(entriesBefore);
          expect.soft(session.messages).toEqual(messagesBefore);
        }
        if (!cancelCaller && !recovers) {
          expect(getCompactionSafeguardRuntime(sessionManager)?.cancellation?.reason).toContain(
            "failed quality checks",
          );
        }
        expect(network.mock.calls.length).toBe(0);
      } finally {
        releaseProvider.resolve();
        setCompactionSafeguardRuntime(sessionManager, null);
        registry.compactionProviders.splice(registry.compactionProviders.indexOf(registration), 1);
        eventBus.clear();
        network.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "long untrusted focus",
      instructions: `\nKeep <API>\r\n\u0000\u202E${"😀".repeat(900)}  `,
      expectedFocus: `Keep &lt;API&gt;\n${"😀".repeat(786)}`,
    },
    { name: "blank focus", instructions: " \n\t ", expectedFocus: undefined },
    { name: "absent focus", instructions: undefined, expectedFocus: undefined },
  ])(
    "prepares $name for core without changing the extension input",
    async ({ instructions, expectedFocus }) => {
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
        timestamp: 2,
      });
      sessionManager.appendMessage({ role: "user", content: "split prompt", timestamp: 3 });
      sessionManager.appendMessage({
        ...createAssistant(testModel, [{ type: "text", text: "retained answer" }]),
        timestamp: 4,
      });
      const observedInstructions: Array<string | undefined> = [];
      const prompts: string[] = [];
      const eventBus = createEventBus();
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request in compaction test"));
      try {
        const resourceLoader = createResourceLoader();
        const extensions = resourceLoader.getExtensions();
        extensions.extensions.push(
          await loadExtensionFromFactory(
            (api) => {
              api.on("session_before_compact", (event) => {
                observedInstructions.push(event.customInstructions);
              });
            },
            sessionManager.getCwd(),
            eventBus,
            extensions.runtime,
          ),
        );
        streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
          const message = context.messages[0];
          if (message?.role !== "user") {
            throw new Error("expected a user summary prompt");
          }
          prompts.push(
            typeof message.content === "string"
              ? message.content
              : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          );
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "compacted summary" }]),
          );
        });
        const { session } = await createTestSession({
          sessionManager,
          resourceLoader,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
        });

        await session.compact(instructions);

        expect(observedInstructions).toEqual([instructions]);
        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
          if (expectedFocus) {
            expect.soft(prompt).toContain(`<untrusted-text>\n${expectedFocus}\n</untrusted-text>`);
            expect.soft(prompt).not.toContain("\u0000");
            expect.soft(prompt).not.toContain("\u202E");
          } else {
            expect.soft(prompt).not.toContain("Additional focus:");
          }
        }
        expect(
          sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.fromHook),
        ).toEqual([false]);
        expect(network.mock.calls.length).toBe(0);
      } finally {
        eventBus.clear();
        network.mockRestore();
      }
    },
  );

  it("preserves the automatic authentication failure as a reasoned skip", async () => {
    const { session, modelRegistry } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
    });
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
        ok: false,
        error: `No API key found for ${activeModel.provider}`,
      });
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      );
    });
    const compactionEvents = collectCompactionEnds(session);

    await session.prompt("continue");

    expect(compactionEvents.at(0)).toMatchObject({
      type: "compaction_end",
      reason: "threshold",
      outcome: { status: "skipped", reason: expect.stringContaining("No API key found") },
    });
  });

  it("records post-compaction live-message tokens through the subscriber", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    const firstKeptEntryId = sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "retained answer" }]),
      timestamp: 2,
    });
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        ++requests === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      ),
    );
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(
        createResultHandlers("condensed history", firstKeptEntryId),
      ),
    });
    const subscription = subscribeEmbeddedAgentSession({ session, runId: "run-tokens-after" });

    await session.prompt("long request");

    expect(subscription.getCompactionCount()).toBe(1);
    expect(subscription.getLastCompactionTokensAfter()).toEqual(expect.any(Number));
    expect(subscription.getLastCompactionTokensAfter()).toBeGreaterThan(0);
    subscription.unsubscribe();
  });

  it("sends a pre-persisted keyed user once after pre-prompt compaction", async () => {
    const dir = tempDirs.make("openclaw-agent-session-compaction-keyed-user-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-agent-session-compaction-keyed-user",
      sessionKey: "agent:main:dashboard:sqlite-agent-session-compaction-keyed-user",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const sessionManager = SessionManager.open(scope, dir);
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "old answer" }], "stop", 950),
      timestamp: 2,
    });
    const currentUser = {
      role: "user" as const,
      content: "current question",
      idempotencyKey: "agent-session-compaction-keyed-user:user",
      timestamp: 3,
    };
    const currentUserId = sessionManager.appendMessage(currentUser);
    guardSessionManager(sessionManager, { preparedUserTurnMessage: currentUser });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(createResultHandlers("condensed history")),
    });
    // Embedded attempt preparation removes the ingress-persisted user from model state.
    // Pre-prompt compaction rebuilds it from the durable branch before prompt submission.
    session.agent.state.messages = session.agent.state.messages.slice(0, -1);

    await session.prompt(currentUser.content, {
      persistedUserIdempotencyKey: currentUser.idempotencyKey,
    });

    expect(requests).toHaveLength(1);
    expect(
      requests[0]?.messages.filter(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes(currentUser.content),
      ),
    ).toHaveLength(1);
    expect(
      sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            "idempotencyKey" in entry.message &&
            entry.message.idempotencyKey === currentUser.idempotencyKey,
        ),
    ).toHaveLength(1);
    expect(sessionManager.getEntry(currentUserId)).toBeDefined();
    expect(session.getLastAssistantText()).toBe("complete answer");
  });

  it("accounts every automatic compaction response before summary validation", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
      timestamp: 2,
    });
    sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
    const requestCount = mockInvalidThenTextSummary("condensed history");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-automatic-summary-usage",
    });

    await session[agentSessionAutomaticCompaction]();

    expect(requestCount()).toBe(2);
    expect(subscription.getUsageTotals()).toMatchObject({ input: 2, output: 2, total: 4 });
    subscription.unsubscribe();
  });

  it("accounts branch-summary responses through the same run owner", async () => {
    const sessionManager = SessionManager.inMemory();
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const abandonedId = sessionManager.appendMessage({
      role: "user",
      content: "abandoned branch",
      timestamp: 2,
    });
    sessionManager.branch(rootId);
    const targetId = sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "target branch" }]),
      timestamp: 3,
    });
    sessionManager.branch(abandonedId);
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "branch summary" }], "stop", 7),
      ),
    );
    const { session } = await createTestSession({ sessionManager });
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-branch-summary-usage",
    });

    await session.navigateTree(targetId, { summarize: true });

    expect(subscription.getUsageTotals()).toMatchObject({ input: 7, output: 1, total: 8 });
    subscription.unsubscribe();
  });

  it("projects a rejected automatic cancellation as aborted without recording compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    const handlers = createCompactionHandlers();
    const syntheticError = new Error("synthetic cancellation rejection");
    const abortActiveCompaction = () => session.abortCompaction();
    handlers.set("session_before_compact", [
      async () => {
        abortActiveCompaction();
        throw syntheticError;
      },
    ]);
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        if (options?.signal?.aborted) {
          throw syntheticError;
        }
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
        );
      },
    );
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(handlers),
    });
    const onAgentEvent = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-rejected-cancellation",
      onAgentEvent,
    });

    await session.prompt("continue");

    const compactionEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "compaction");
    expect(compactionEvents).toHaveLength(2);
    expect(compactionEvents.at(-1)).toEqual({
      stream: "compaction",
      data: {
        phase: "end",
        outcome: "aborted",
        completed: false,
        willRetry: false,
      },
    });
    expect(subscription.getCompactionCount()).toBe(0);
    expect(subscription.getLastCompactionTokensAfter()).toBeUndefined();
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    subscription.unsubscribe();
  });

  it("projects a rejected manual cancellation as aborted without recording compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
      timestamp: 2,
    });
    const handlers = createCompactionHandlers();
    const syntheticError = new Error("synthetic manual cancellation rejection");
    const abortActiveCompaction = () => session.abortCompaction();
    handlers.set("session_before_compact", [
      async () => {
        abortActiveCompaction();
        throw syntheticError;
      },
    ]);
    streamMocks.streamSimple.mockImplementation(
      (_activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        if (options?.signal?.aborted) {
          throw syntheticError;
        }
        return createAssistantResultStream(
          createAssistant(testModel, [{ type: "text", text: "unexpected compaction" }]),
        );
      },
    );
    const { session } = await createTestSession({
      sessionManager,
      resourceLoader: createResourceLoader(handlers),
    });
    const onAgentEvent = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-rejected-manual-cancellation",
      onAgentEvent,
    });

    await expect(session.compact()).rejects.toBe(syntheticError);

    const compactionEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "compaction");
    expect(compactionEvents).toHaveLength(2);
    expect(compactionEvents.at(-1)).toEqual({
      stream: "compaction",
      data: {
        phase: "end",
        outcome: "aborted",
        completed: false,
        willRetry: false,
      },
    });
    expect(subscription.getCompactionCount()).toBe(0);
    expect(subscription.getLastCompactionTokensAfter()).toBeUndefined();
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    subscription.unsubscribe();
  });

  it("caps extension summaries before persistence and manual return", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({
      ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
      timestamp: 2,
    });
    const oversizedSummary = "summary detail ".repeat(2_000);
    const { session } = await createTestSession({
      sessionManager,
      resourceLoader: createResourceLoader(createResultHandlers(oversizedSummary)),
    });

    const result = await session.compact();
    const persisted = sessionManager.getBranch().findLast((entry) => entry.type === "compaction");

    expect(result.summary.length).toBeLessThanOrEqual(16_000);
    expect(result.summary).toContain("[Compaction summary truncated to fit budget]");
    expect(persisted).toMatchObject({ type: "compaction", summary: result.summary });
  });

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
      const compactionEvents = collectCompactionEnds(session);

      await session.prompt("long request");

      expect(agentRequests).toBe(overflowCount + 1);
      expect(
        compactionEvents.filter(
          (event) =>
            event.type === "compaction_end" &&
            event.outcome.status === "completed" &&
            event.outcome.willRetry,
        ),
      ).toHaveLength(overflowCount);
      expect(session.getLastAssistantText()).toBe("complete retry");
    },
  );

  it("invalidates context-bound state before the completed event and overflow retry", async () => {
    const contextState = new Map([["skill", true]]);
    const contextSizesAtCompactionEnd: number[] = [];
    let agentRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      agentRequests += 1;
      if (agentRequests === 2) {
        expect(contextState.size).toBe(0);
      }
      return createAssistantResultStream(
        agentRequests === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session } = await createTestSession({
      settingsManager: createAutoCompactionSettings(),
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session[agentSessionSetContextReplacementHook](() => contextState.clear());
    session.subscribe((event) => {
      if (event.type === "compaction_end" && event.outcome.status === "completed") {
        contextSizesAtCompactionEnd.push(contextState.size);
      }
    });

    await session.prompt("long request");

    expect(agentRequests).toBe(2);
    expect(contextState.size).toBe(0);
    expect(contextSizesAtCompactionEnd).toEqual([0]);
  });

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
    const compactionEvents = collectCompactionEnds(session);

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(MAX_OVERFLOW_COMPACTION_ATTEMPTS + 1);
    expect(compactionEvents.at(-1)).toMatchObject({
      type: "compaction_end",
      reason: "overflow",
      outcome: {
        status: "failed",
        reason: `Context overflow recovery failed after ${MAX_OVERFLOW_COMPACTION_ATTEMPTS} compact-and-retry attempts. Try reducing context or switching to a larger-context model.`,
      },
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
