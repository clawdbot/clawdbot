import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { applyAgentCompactionSettingsFromConfig } from "../agent-settings.js";
import { buildRuntimeContextCustomMessage } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { createCompactionRequestBudget } from "./compaction/request-budget.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession small-context compaction", () => {
  it("defers a one-archive retention no-op until the foreground request budget is prepared", async () => {
    const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: model.contextWindow,
    });
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "a".repeat(46_191), timestamp: 1 });
    const assistant = createAssistant(model, [{ type: "text", text: "ACK" }]);
    sessionManager.appendMessage({
      ...assistant,
      usage: { ...assistant.usage, input: 19_140, output: 2, totalTokens: 19_142 },
    });
    const pending = "b".repeat(52_602);
    const pendingKey = "unprocessed-request";
    const pendingUser = {
      role: "user" as const,
      content: pending,
      timestamp: 3,
      idempotencyKey: pendingKey,
    };
    const pendingUserEntryId = sessionManager.appendMessage(pendingUser);
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      resourceLoader: {
        ...createResourceLoader(),
        getSystemPrompt: () => "Required instructions. ".repeat(1_000),
      },
    });
    const before = structuredClone(sessionManager.getBranch());
    await expect(
      session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
        pendingUserEntryId,
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "Nothing to compact (session too small)",
    });
    expect(sessionManager.getBranch()).toEqual(before);
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    let foregroundCalls = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      const currentUser = context.messages.findLast((message) => message.role === "user");
      const text =
        typeof currentUser?.content === "string"
          ? currentUser.content
          : currentUser?.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      const foreground = text === pending;
      if (foreground) {
        foregroundCalls += 1;
      }
      return createAssistantResultStream(
        createAssistant(activeModel, [
          {
            type: "text",
            text: foreground ? "FOREGROUND_DONE" : "The earlier archive was processed.",
          },
        ]),
      );
    });
    const requestBudget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: settingsManager.getCompactionReserveTokens(),
      systemPrompt: session.systemPrompt,
      tools: session.state.tools,
      pendingPrompt: pending,
      pendingUserIdempotencyKey: pendingKey,
    });
    await expect(
      session[agentSessionAutomaticCompaction](undefined, "unresolved", undefined, {
        pendingUserEntryId,
        requestBudget,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await session.prompt(pending, { persistedUserIdempotencyKey: pendingKey });
    expect(foregroundCalls).toBe(1);
    expect(session.getLastAssistantText()).toBe("FOREGROUND_DONE");
    expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
      1,
    );
    expect(
      session.messages.filter(
        (message) =>
          message.role === "user" &&
          "idempotencyKey" in message &&
          message.idempotencyKey === pendingKey,
      ),
    ).toHaveLength(1);
    expect(sessionManager.getEntry(pendingUserEntryId)).toMatchObject({ message: pendingUser });
  });

  it.each([
    { name: "a larger canonical user", rows: 600, extra: undefined },
    {
      name: "new additive context beside a reused user",
      rows: 280,
      extra: "New prompt context. ".repeat(220),
    },
  ])("does not undercount $name with a keyed carrier", async ({ rows, extra }) => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 1_024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Earlier answer" }]),
    );
    const canonicalUser = {
      role: "user" as const,
      content: "Protected recorded request. ".repeat(rows),
      timestamp: 3,
      idempotencyKey: "retained-canonical-user",
    };
    const userId = sessionManager.appendMessage(canonicalUser);
    const carrier = buildRuntimeContextCustomMessage("Retained runtime context");
    if (!carrier) {
      throw new Error("Expected a runtime context carrier");
    }
    sessionManager.appendCustomMessageEntry(
      carrier.customType,
      carrier.content,
      carrier.display,
      carrier.details,
    );
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      resourceLoader: {
        ...createResourceLoader(
          new Map([
            [
              "session_before_compact",
              [
                async () => ({
                  compaction: {
                    summary: "Earlier work completed.",
                    firstKeptEntryId: userId,
                    tokensBefore: 0,
                  },
                }),
              ],
            ],
          ]),
        ),
        getSystemPrompt: () => "Preserve project requirements.",
      },
    });
    const before = structuredClone(sessionManager.getBranch());
    const budget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: 1_024,
      systemPrompt: session.systemPrompt,
      pendingPrompt: extra ? `${extra}\n\nRebuilt prompt` : "Rebuilt prompt",
      pendingAdditivePrompt: extra,
      pendingUserIdempotencyKey: canonicalUser.idempotencyKey,
    });

    await expect(
      session[agentSessionAutomaticCompaction](undefined, "unresolved", undefined, {
        requestBudget: budget,
      }),
    ).rejects.toThrow("No complete recent message fits");

    expect(sessionManager.getBranch()).toEqual(before);
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  });

  it.each(["manual", "automatic"])(
    "preserves file metadata while fitting a non-Latin %s summary",
    async (mode) => {
      const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
      const settingsManager = SettingsManager.inMemory({
        compaction: { reserveTokens: 1_024, keepRecentTokens: 1 },
        retry: { enabled: false },
      });
      const sessionManager = SessionManager.inMemory();
      const file = "/workspace/archive.md";
      sessionManager.appendMessage({
        role: "user",
        content: "Read the archive and preserve its project decisions.",
        timestamp: 1,
      });
      sessionManager.appendMessage(
        createAssistant(
          model,
          [{ type: "toolCall", id: "archive-read", name: "read", arguments: { path: file } }],
          "toolUse",
        ),
      );
      sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "archive-read",
        toolName: "read",
        content: [{ type: "text", text: "The project uses blue buttons." }],
        isError: false,
        timestamp: 3,
      });
      sessionManager.appendMessage({
        role: "user",
        content: "Continue the project.",
        timestamp: 4,
      });
      sessionManager.appendMessage(
        createAssistant(model, [{ type: "text", text: "Ready to continue." }]),
      );
      const { session } = await createTestSession({
        model,
        settingsManager,
        sessionManager,
        resourceLoader: {
          ...createResourceLoader(),
          getSystemPrompt: () => "Preserve project decisions.",
        },
      });
      const generatedSummary = "保留项目的蓝色按钮和归档决策。".repeat(300);
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: generatedSummary }]),
        ),
      );
      const budget = createCompactionRequestBudget({
        contextWindow: model.contextWindow,
        reserveTokens: 1_024,
        systemPrompt: session.systemPrompt,
        tools: session.state.tools,
      });

      const outcome =
        mode === "manual"
          ? { status: "completed" as const, result: await session.compact() }
          : await session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
              requestBudget: budget,
            });
      if (outcome.status !== "completed") {
        throw new Error(outcome.reason);
      }
      const result = outcome.result;

      expect(result.summary).toContain(file);
      expect(result.summary).toContain("Turn Context (split turn)");
      expect(result.details).toMatchObject({ readFiles: [file] });
      expect(
        sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
      ).toMatchObject({ summary: result.summary });
      if (mode === "automatic") {
        expect(result.summary.length).toBeLessThan(generatedSummary.length);
      } else {
        expect(result.summary).toContain(generatedSummary);
      }
    },
  );

  it("leaves history intact when a complete tool-call/result tail cannot fit", async () => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 1_024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "Read the large archive.",
      timestamp: 1,
    });
    sessionManager.appendMessage(
      createAssistant(
        model,
        [
          {
            type: "toolCall",
            id: "large-read",
            name: "read",
            arguments: { path: "/workspace/large.txt" },
          },
        ],
        "toolUse",
      ),
    );
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "large-read",
      toolName: "read",
      content: [{ type: "text", text: "Large archive output. ".repeat(1_000) }],
      isError: false,
      timestamp: 3,
    });
    const { session } = await createTestSession({ model, settingsManager, sessionManager });
    const before = structuredClone(sessionManager.getBranch());
    const budget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: 1_024,
      systemPrompt: session.systemPrompt,
      tools: session.state.tools,
    });

    await expect(
      session[agentSessionAutomaticCompaction](undefined, "unresolved", undefined, {
        requestBudget: budget,
      }),
    ).rejects.toThrow("No complete recent message fits");

    expect(sessionManager.getBranch()).toEqual(before);
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
  });

  it.each(["retain", "drop", "missing"] as const)(
    "enforces admitted input preservation without a prepared budget (%s)",
    async (mode) => {
      const sessionManager = SessionManager.inMemory();
      sessionManager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
      sessionManager.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "Earlier answer" }], "stop"),
      );
      const pending = { role: "user" as const, content: "Approved current input", timestamp: 3 };
      const pendingId = sessionManager.appendMessage(pending);
      const carrierId = sessionManager.appendCustomMessageEntry(
        "runtime-context",
        "Current runtime context",
        false,
      );
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: SettingsManager.inMemory({
          compaction: { keepRecentTokens: 1, reserveTokens: 1_024 },
        }),
        resourceLoader: createResourceLoader(
          new Map([
            [
              "session_before_compact",
              [
                async () => ({
                  compaction: {
                    summary: "Earlier request answered.",
                    firstKeptEntryId: mode === "drop" ? carrierId : pendingId,
                    tokensBefore: 100,
                  },
                }),
              ],
            ],
          ]),
        ),
      });
      const before = structuredClone(sessionManager.getBranch());
      const work = session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
        pendingUserEntryId: mode === "missing" ? "unrelated-admission" : pendingId,
      });
      if (mode === "retain") {
        await work;
        expect(session.messages).toContainEqual(pending);
      } else {
        await expect(work).rejects.toThrow(
          mode === "drop"
            ? "retain the unprocessed pending user"
            : "find the admitted pending user",
        );
        expect(sessionManager.getBranch()).toEqual(before);
      }
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    },
  );

  it("reserves a recorder-persisted pending user once when retaining its exact row", async () => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 1_024 };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: model.contextWindow,
    });
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "Earlier project context. ".repeat(60),
      timestamp: 1,
    });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Earlier answer. ".repeat(80) }]),
    );
    const pending = "Process this pending project material. ".repeat(150);
    const pendingKey = "pending-budget-user";
    const pendingUser = {
      role: "user" as const,
      content: pending,
      idempotencyKey: pendingKey,
      timestamp: 3,
    };
    sessionManager.appendMessage(pendingUser);
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      resourceLoader: {
        ...createResourceLoader(),
        getSystemPrompt: () => "Preserve project requirements.",
      },
    });
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [
          {
            type: "text",
            text: "Earlier project context was processed. The latest user request still needs an answer.",
          },
        ]),
      ),
    );
    const budget = createCompactionRequestBudget({
      contextWindow: model.contextWindow,
      reserveTokens: settingsManager.getCompactionReserveTokens(),
      systemPrompt: session.agent.state.systemPrompt,
      tools: session.agent.state.tools,
      pendingPrompt: pending,
      pendingUserIdempotencyKey: pendingKey,
    });

    await session[agentSessionAutomaticCompaction](undefined, "unresolved", undefined, {
      requestBudget: budget,
    });

    const pendingUsers = session.messages.filter(
      (message) =>
        message.role === "user" &&
        "idempotencyKey" in message &&
        message.idempotencyKey === pendingKey,
    );
    expect(pendingUsers).toHaveLength(1);
    expect(pendingUsers[0]).toMatchObject({ content: pending });
    expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
      1,
    );
  });
  it("keeps a fresh 32K conversation intact and compacts growing history within summary headroom", async () => {
    const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: model.contextWindow,
    });
    const sessionManager = SessionManager.inMemory();
    const { session } = await createTestSession({ model, settingsManager, sessionManager });
    const summaryBudgets: number[] = [];
    const firstPrompt = "Remember that the project uses blue buttons.";
    const secondPrompt = `Review the module results and preserve button contrast.\n${"The module output needs a careful accessibility review.\n".repeat(1_400)}`;
    const firstAnswer = `Blue buttons are the project decision.\n${"Validated widget: blue buttons remain accessible.\n".repeat(600)}`;
    let userTurns = 0;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
        const userMessage = context.messages.findLast((message) => message.role === "user");
        const userText =
          typeof userMessage?.content === "string"
            ? userMessage.content
            : userMessage?.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
        if (userText !== firstPrompt && userText !== secondPrompt) {
          expect(options?.maxTokens).toBeTypeOf("number");
          summaryBudgets.push(options!.maxTokens!);
          return createAssistantResultStream(
            createAssistant(
              activeModel,
              [
                {
                  type: "text",
                  text: userText?.includes("blue buttons")
                    ? "The project uses blue buttons."
                    : "Preserve button contrast in the accessibility review.",
                },
              ],
              "stop",
              100,
            ),
          );
        }
        userTurns += 1;
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            [
              {
                type: "text",
                text: userTurns === 1 ? firstAnswer : "Completed the accessibility review.",
              },
            ],
            "stop",
            userTurns === 1 ? 12_824 : 24_577,
          ),
        );
      },
    );
    const compactionEvents: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt(firstPrompt);
    expect(compactionEvents).toHaveLength(0);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);

    await session.prompt(secondPrompt);
    expect(compactionEvents, JSON.stringify(compactionEvents)).toMatchObject([
      { outcome: { status: "completed" } },
    ]);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toMatchObject([{ summary: expect.stringContaining("blue buttons") }]);
    expect(summaryBudgets.length).toBeGreaterThan(0);
    for (const budget of summaryBudgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(6_553);
    }
    expect(
      session.messages.some((message) => JSON.stringify(message).includes("blue buttons")),
    ).toBe(true);
  });
  it.each([
    {
      contextWindow: 32_768,
      systemRows: 400,
      toolRows: 150,
      historyRows: 750,
      growthRows: 1_200,
      summaryRows: 150,
    },
    {
      contextWindow: 4_096,
      systemRows: 4,
      toolRows: 2,
      historyRows: 20,
      growthRows: 280,
      summaryRows: 4,
    },
  ])(
    "fits the complete foreground request after automatic compaction at $contextWindow tokens",
    async ({ contextWindow, systemRows, toolRows, historyRows, growthRows, summaryRows }) => {
      const model = { ...testModel, contextWindow, maxTokens: Math.floor(contextWindow / 4) };
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        contextTokenBudget: model.contextWindow,
      });
      const systemPrompt = "Follow the project conventions and preserve user requirements. ".repeat(
        systemRows,
      );
      const { session } = await createTestSession({
        model,
        settingsManager,
        resourceLoader: { ...createResourceLoader(), getSystemPrompt: () => systemPrompt },
        customTools: [
          {
            name: "lookup_fixture",
            label: "Fixture lookup",
            description:
              "Read the requested fixture field and return its documented value. ".repeat(toolRows),
            parameters: Type.Object({ query: Type.String() }),
            execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
          },
        ],
      });
      const first = "Remember that the project uses blue buttons.";
      const growth =
        "Review these recorded module results.\n" +
        "The module preserves accessible blue buttons.\n".repeat(growthRows);
      const continuation = "Confirm the retained button color.";
      const firstAnswer = "The agreed button color is blue.\n".repeat(historyRows);
      const summary =
        "The project uses blue buttons. Preserve the recorded accessibility decisions.\n".repeat(
          summaryRows,
        );
      const requests: Array<{ prompt: string; tokens: number }> = [];
      const compactions: AgentSessionEvent[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactions.push(event);
        }
      });
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        const user = context.messages.findLast((message) => message.role === "user");
        const prompt =
          typeof user?.content === "string"
            ? user.content
            : user?.content.map((block) => (block.type === "text" ? block.text : "")).join("");
        const foreground = prompt === first || prompt === growth || prompt === continuation;
        // This fake provider counts its complete wire representation, independently of the cut planner.
        const wire = JSON.stringify({
          system: context.systemPrompt,
          tools: context.tools?.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          messages: context.messages.map(({ role, content }) => ({ role, content })),
        });
        const inputTokens = Math.ceil(wire.length / 4);
        if (foreground) {
          requests.push({ prompt, tokens: inputTokens });
        }
        const text = !foreground
          ? summary
          : prompt === first
            ? firstAnswer
            : "The button color is blue.";
        const response = createAssistant(
          activeModel,
          [{ type: "text", text }],
          "stop",
          inputTokens,
        );
        response.usage.output = Math.ceil(text.length / 4);
        response.usage.totalTokens = inputTokens + response.usage.output;
        response.usage.contextUsage = {
          state: "available",
          promptTokens: inputTokens,
          totalTokens: response.usage.totalTokens,
        };
        return createAssistantResultStream(response);
      });

      await session.prompt(first);
      expect(compactions).toHaveLength(0);
      await session.prompt(growth);
      expect(compactions).toMatchObject([{ outcome: { status: "completed" } }]);
      await session.prompt(continuation);
      expect(requests.map(({ prompt }) => prompt)).toEqual([first, growth, continuation]);
      expect(requests.at(-1)?.tokens).toBeLessThanOrEqual(
        model.contextWindow - settingsManager.getCompactionReserveTokens(),
      );
      expect(compactions).toHaveLength(1);
      expect(
        session.messages.some((message) => JSON.stringify(message).includes("blue buttons")),
      ).toBe(true);
    },
  );
});
