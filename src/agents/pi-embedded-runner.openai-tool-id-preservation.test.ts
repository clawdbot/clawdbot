import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSanitizeSessionHistoryHelpersMock,
  createSanitizeSessionHistoryProviderRuntimeMock,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  type SanitizeSessionHistoryHarness,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

vi.mock("./pi-embedded-helpers.js", async () => await createSanitizeSessionHistoryHelpersMock());

vi.mock(
  "../plugins/provider-runtime.js",
  async () => await createSanitizeSessionHistoryProviderRuntimeMock(),
);

describe("sanitizeSessionHistory openai tool id preservation", () => {
  let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];

  beforeEach(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
  });

  const makeSessionManager = () =>
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
});
