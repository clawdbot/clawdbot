import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
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
import { createCompactionRequestBudget } from "./compaction/request-budget.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function inputTokens(
  system: string | undefined,
  messages: Array<{ role: string; content?: unknown }>,
  tools: unknown = [],
) {
  return Math.ceil(
    JSON.stringify({
      system,
      tools: tools ?? [],
      messages: messages.map(({ role, content }) => ({ role, content })),
    }).length / 4,
  );
}

it.each([
  { records: 352, ingress: "new" },
  { records: 410, ingress: "new" },
  { records: 410, ingress: "persisted" },
  { records: 410, ingress: "carrier" },
  { records: 200, ingress: "replayed carrier", queued: true },
])(
  "preserves $ingress pending input with $records records during pre-prompt compaction",
  async ({ records, ingress, queued }) => {
    const model = { ...testModel, contextWindow: 4_096, maxTokens: 256 };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const systemPrompt = "Follow the project rules. ".repeat(160);
    const oldInput = "Archived project facts. ".repeat(420);
    const pendingInput = "Incoming request data. ".repeat(records) + "Reply ACK after processing.";
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: oldInput, timestamp: 1 });
    const priorTokens = inputTokens(systemPrompt, sessionManager.buildSessionContext().messages);
    const pendingOnlyTokens = inputTokens(systemPrompt, [{ role: "user", content: pendingInput }]);
    expect(priorTokens).toBeGreaterThan(3_072);
    expect(priorTokens + model.maxTokens).toBeLessThan(model.contextWindow);
    if (queued) {
      expect(pendingOnlyTokens).toBeLessThan(3_072);
    } else {
      expect(pendingOnlyTokens).toBeGreaterThan(3_072);
    }
    expect(pendingOnlyTokens + model.maxTokens).toBeLessThan(model.contextWindow);
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Archive recorded." }], "stop", priorTokens),
    );
    const pendingKey = ingress === "new" ? undefined : "pending-ingress";
    if (pendingKey) {
      const pendingUser: PersistedUserTurnMessage = {
        role: "user",
        content: pendingInput,
        timestamp: 3,
        idempotencyKey: pendingKey,
      };
      sessionManager.appendMessage(pendingUser);
    }
    if (ingress.endsWith("carrier")) {
      const carrier = buildRuntimeContextCustomMessage("Retained runtime context");
      if (!carrier) {
        throw new Error("Expected runtime context carrier");
      }
      sessionManager.appendCustomMessageEntry(
        carrier.customType,
        carrier.content,
        carrier.display,
        carrier.details,
      );
    }
    const { session } = await createTestSession({
      model,
      settingsManager,
      sessionManager,
      resourceLoader: { ...createResourceLoader(), getSystemPrompt: () => systemPrompt },
    });
    if (queued) {
      const suppressed = buildRuntimeContextCustomMessage("Discarded queued context. ".repeat(35));
      if (!suppressed) {
        throw new Error("Expected queued runtime context");
      }
      await session.sendCustomMessage(suppressed, { deliverAs: "nextTurn" });
      await session.sendCustomMessage(
        { customType: "required-fixture", content: "queue-marker", display: false },
        { deliverAs: "nextTurn" },
      );
    }
    const calls: Array<{
      kind: string;
      input: number;
      requestedOutput: number;
      explicitOutput?: number;
      pendingPreserved: boolean;
      accepted: boolean;
      committedBefore: number;
    }> = [];
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
        const tokens = inputTokens(context.systemPrompt, context.messages, context.tools);
        // This registered provider defaults to its model output cap; the owner must
        // preserve valid requests without assuming every provider shares that rule.
        const outputCap = options?.maxTokens ?? activeModel.maxTokens;
        const accepted = tokens + outputCap <= model.contextWindow;
        const foreground = !session.isCompacting;
        if (queued && foreground && accepted) {
          expect(JSON.stringify(context.messages)).not.toContain("Discarded queued context.");
          expect(JSON.stringify(context.messages)).toContain("queue-marker");
        }
        const pendingPreserved = context.messages.some(
          (message) =>
            message.role === "user" &&
            (typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")
            ).includes(pendingInput),
        );
        calls.push({
          explicitOutput: options?.maxTokens,
          pendingPreserved,
          kind: foreground ? "foreground" : "summary",
          input: tokens,
          requestedOutput: outputCap,
          accepted,
          committedBefore: sessionManager
            .getEntries()
            .filter((entry) => entry.type === "compaction").length,
        });
        if (!accepted) {
          return createAssistantResultStream({
            ...createAssistant(activeModel, [], "error", tokens),
            errorMessage:
              "Context length exceeded: request and output limit exceed the model context window.",
          });
        }
        const text = foreground ? "ACK" : "Older archive summarized.";
        const response = createAssistant(activeModel, [{ type: "text", text }], "stop", tokens);
        response.usage.output = Math.ceil(text.length / 4);
        response.usage.totalTokens = tokens + response.usage.output;
        response.usage.contextUsage = {
          state: "available",
          promptTokens: tokens,
          totalTokens: response.usage.totalTokens,
        };
        return createAssistantResultStream(response);
      },
    );

    await session.prompt(pendingInput, { persistedUserIdempotencyKey: pendingKey });

    const foreground = calls.filter((call) => call.kind === "foreground");
    expect(
      foreground.some((call) => call.accepted && call.pendingPreserved),
      JSON.stringify(calls),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.kind === "summary" && call.committedBefore === 0)
        .every((call) => !call.pendingPreserved),
      JSON.stringify(calls),
    ).toBe(true);
    expect(foreground).toHaveLength(1);
    expect(foreground[0]?.committedBefore).toBeGreaterThan(0);
    expect(foreground[0]?.accepted).toBe(true);
    expect(session.getLastAssistantText()).toBe("ACK");
  },
);

it.each([
  "unchanged",
  "growing",
  "discarded pending user",
  "processed pending user",
  "processed fixed overhead",
  "unchanged fixed overhead",
  "growing fixed overhead",
])("validates %s history against the foreground request", async (outcome) => {
  const processed = outcome.startsWith("processed");
  const fixedOnly = outcome.endsWith("fixed overhead");
  const model = { ...testModel, contextWindow: 4_096, maxTokens: 256 };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory();
  const keptId = sessionManager.appendMessage({
    role: "user",
    content: "Continue the project.",
    timestamp: 1,
  });
  const originalSummary = "The project uses blue buttons. ".repeat(40);
  sessionManager.appendCompaction(originalSummary, keptId, 2_000);
  sessionManager.appendMessage(createAssistant(model, [{ type: "text", text: "Ready." }]));
  const pending = "Pending project material. ".repeat(550);
  const pendingKey = outcome.endsWith("pending user") ? "protected-pending" : undefined;
  let firstKeptEntryId = keptId;
  if (pendingKey) {
    const pendingUser: PersistedUserTurnMessage = {
      role: "user",
      content: pending,
      idempotencyKey: pendingKey,
      timestamp: 3,
    };
    sessionManager.appendMessage(pendingUser);
    firstKeptEntryId = sessionManager.appendCustomMessageEntry(
      "runtime-context",
      "Retained context",
      false,
    );
  }
  const hook = vi.fn(async () => ({
    compaction: {
      summary:
        pendingKey || processed
          ? "Earlier work completed."
          : outcome.startsWith("unchanged")
            ? originalSummary
            : originalSummary.repeat(2),
      firstKeptEntryId,
      tokensBefore: 2_000,
    },
  }));
  const { session } = await createTestSession({
    model,
    settingsManager,
    sessionManager,
    resourceLoader: {
      ...createResourceLoader(new Map([["session_before_compact", [hook]]])),
      ...(fixedOnly
        ? { getSystemPrompt: () => "Required operating instructions. ".repeat(340) }
        : {}),
    },
  });
  const before = structuredClone(sessionManager.getBranch());
  const budget = createCompactionRequestBudget({
    contextWindow: model.contextWindow,
    reserveTokens: 1_024,
    systemPrompt: session.systemPrompt,
    pendingPrompt: fixedOnly ? undefined : pending,
    pendingUserIdempotencyKey: pendingKey,
  });
  if (fixedOnly) {
    expect(budget.fixedTokens).toBeGreaterThan(model.contextWindow - budget.reserveTokens);
    expect(inputTokens(session.systemPrompt, session.messages) + model.maxTokens).toBeLessThan(
      model.contextWindow,
    );
  }
  const result = session[agentSessionAutomaticCompaction](undefined, undefined, undefined, {
    requestBudget: processed ? { ...budget, pendingTokens: 0 } : budget,
  });
  if (processed) {
    await result;
    expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(
      2,
    );
    expect(
      session.messages.some(
        (message) =>
          message.role === "user" &&
          "idempotencyKey" in message &&
          message.idempotencyKey === pendingKey,
      ),
    ).toBe(false);
    expect(inputTokens(session.systemPrompt, session.messages) + model.maxTokens).toBeLessThan(
      model.contextWindow,
    );
  } else {
    await expect(result).rejects.toThrow(
      pendingKey ? "retain the unprocessed pending user request" : "foreground request budget",
    );
    expect(sessionManager.getBranch()).toEqual(before);
  }
  expect(hook).toHaveBeenCalledOnce();
  expect(streamMocks.streamSimple).not.toHaveBeenCalled();
});
