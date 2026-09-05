// Covers OpenAI replay tool-call id preservation and downgrade rules.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSanitizeSessionHistoryHelpersMock,
  createSanitizeSessionHistoryProviderHookRuntimeMock,
  createSanitizeSessionHistoryProviderRuntimeMock,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  type SanitizeSessionHistoryHarness,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

vi.mock("./embedded-agent-helpers.js", async () => await createSanitizeSessionHistoryHelpersMock());

vi.mock(
  "../plugins/provider-runtime.js",
  async () => await createSanitizeSessionHistoryProviderRuntimeMock(),
);
vi.mock(
  "../plugins/provider-hook-runtime.js",
  async () =>
    await createSanitizeSessionHistoryProviderHookRuntimeMock({
      resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) =>
        provider === "openai" || provider === "openrouter"
          ? {
              buildReplayPolicy: (context?: { modelApi?: string }) => ({
                // Completions APIs need strict ids; Responses can preserve richer
                // call_id|fc_id pairs when reasoning metadata is replayable.
                sanitizeMode: "images-only",
                sanitizeToolCallIds: context?.modelApi === "openai-completions",
                ...(context?.modelApi === "openai-completions" ? { toolCallIdMode: "strict" } : {}),
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
              }),
            }
          : undefined,
      ),
    }),
);

describe("sanitizeSessionHistory openai tool id preservation", () => {
  let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
  });

  const makeSessionManager = () =>
    // Snapshot entry supplies model API context used by replay-policy lookup.
    makeInMemorySessionManager([
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      }),
    ]);

  const makeMessages = (withReasoning: boolean): AgentMessage[] => [
    castAgentMessage({
      role: "assistant",
      content: [
        ...(withReasoning
          ? [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
              },
            ]
          : []),
        { type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} },
      ],
    }),
    castAgentMessage({
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
  ];

  it.each([
    {
      name: "strips fc ids when replayable reasoning metadata is missing",
      withReasoning: false,
      expectedToolId: "call_123",
    },
    {
      name: "keeps canonical call_id|fc_id pairings when replayable reasoning is present",
      withReasoning: true,
      expectedToolId: "call_123|fc_123",
    },
  ])("$name", async ({ withReasoning, expectedToolId }) => {
    // Reasoning metadata proves the item id half is replayable; without it we
    // downgrade to the canonical call id.
    const result = await sanitizeSessionHistory({
      messages: makeMessages(withReasoning),
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.4",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
    });

    const assistant = result[0] as { content?: Array<{ type?: string; id?: string }> };
    const toolCall = assistant.content?.find((block) => block.type === "toolCall");
    expect(toolCall?.id).toBe(expectedToolId);

    const toolResult = result[1] as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe(expectedToolId);
  });

  it("repairs displaced tool results before downgrading openai pairing ids", async () => {
    // Pairing repair must run before id downgrade so toolResult follows the
    // correct assistant call after normalization.
    const result = await sanitizeSessionHistory({
      messages: [
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "call_123|fc_123", name: "noop", arguments: {} }],
        }),
        castAgentMessage({
          role: "user",
          content: [{ type: "text", text: "still waiting" }],
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call_123|fc_123",
          toolName: "noop",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        }),
      ],
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.4",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
    });

    const toolResult = result[1] as {
      role?: string;
      toolCallId?: string;
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_123");
    expect(toolResult.content?.[0]?.text).toBe("ok");
    expect(toolResult.isError).toBe(false);

    const userMessage = result[2] as { role?: string };
    expect(userMessage.role).toBe("user");
  });

  it("normalizes overlong responses call ids and malformed item ids for replay", async () => {
    const longCallId = `call_${"x".repeat(120)}`;
    const longItemId = `notfc_${"y".repeat(120)}`;
    const rawToolCallId = `${longCallId}|${longItemId}`;

    const result = await sanitizeSessionHistory({
      messages: [
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: rawToolCallId, name: "noop", arguments: {} }],
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: rawToolCallId,
          toolName: "noop",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        }),
      ],
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.4",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
    });

    const assistant = result[0] as { content?: Array<{ type?: string; id?: string }> };
    const toolCall = assistant.content?.find((block) => block.type === "toolCall");
    expect(toolCall?.id).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(toolCall?.id).not.toBe(rawToolCallId);
    expect(toolCall?.id).not.toContain("|");
    expect(toolCall?.id?.length).toBeLessThanOrEqual(64);

    const toolResult = result[1] as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe(toolCall?.id);
  });

  it("keeps repeated Kimi calls distinct while repairing an incomplete later turn", async () => {
    const firstRawId = "functions.gateway:0|fc_tmp_first";
    const secondRawId = "functions.gateway:0|fc_tmp_second";
    const result = await sanitizeSessionHistory({
      messages: [
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: firstRawId, name: "gateway", arguments: {} }],
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: firstRawId,
          toolName: "gateway",
          content: [{ type: "text", text: "first result" }],
          isError: false,
        }),
        castAgentMessage({ role: "user", content: "check again" }),
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: secondRawId, name: "gateway", arguments: {} }],
        }),
        castAgentMessage({ role: "user", content: "continue" }),
      ],
      modelApi: "openai-responses",
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.5",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
    });

    const firstAssistant = result[0] as { content?: Array<{ type?: string; id?: string }> };
    const secondAssistant = result[3] as { content?: Array<{ type?: string; id?: string }> };
    const firstCallId = firstAssistant.content?.find((block) => block.type === "toolCall")?.id;
    const secondCallId = secondAssistant.content?.find((block) => block.type === "toolCall")?.id;
    expect(firstCallId).toMatch(/^call_[A-Za-z0-9_-]+$/);
    expect(secondCallId).toMatch(/^call_[A-Za-z0-9_-]+$/);
    expect(secondCallId).not.toBe(firstCallId);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: firstCallId,
      isError: false,
      content: [{ type: "text", text: "first result" }],
    });
    expect(result[4]).toMatchObject({
      role: "toolResult",
      toolCallId: secondCallId,
      isError: true,
      content: [{ type: "text", text: "aborted" }],
    });
    expect(result.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
  });
});
