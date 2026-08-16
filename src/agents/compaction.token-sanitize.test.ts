// Verifies compaction token planning strips private/non-model fields first.
import { serializeConversation, type AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";

const agentSessionMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown) => 1),
  generateSummary: vi.fn(async () => "summary"),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-sessions")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    estimateTokens: agentSessionMocks.estimateTokens,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

import {
  buildStageSplitPlan,
  buildSummaryChunks,
  estimateMessagesTokens,
  projectCompactionMessagesForPlanning,
  sanitizeCompactionMessages,
} from "./compaction-planning.js";

describe("compaction token accounting sanitization", () => {
  it("does not pass toolResult.details into per-message token estimates", () => {
    // details can contain raw tool payloads or private diagnostics; token
    // estimates should account only for model-visible message content.
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { raw: "x".repeat(50_000) },
        timestamp: 1,
      } as AgentMessage,
      {
        role: "user",
        content: "next",
        timestamp: 2,
      },
    ];

    buildStageSplitPlan({ messages, maxChunkTokens: 0, parts: 2, minMessagesForSplit: 2 });
    buildSummaryChunks({ messages, maxChunkTokens: 16 });

    const calledWithDetails = agentSessionMocks.estimateTokens.mock.calls.some((call) => {
      const message = call[0] as { details?: unknown } | undefined;
      return Boolean(message?.details);
    });

    expect(calledWithDetails).toBe(false);
  });

  it("projects worker inputs to planning-safe messages before cloning", () => {
    // Worker input is cloned across threads, so sanitize before clone to remove
    // hidden runtime context and oversized diagnostic details.
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        details: { raw: "x".repeat(50_000) },
        timestamp: 1,
      } as AgentMessage,
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "internal",
        timestamp: 2,
      } as AgentMessage,
      {
        role: "user",
        content: "next",
        timestamp: 3,
      },
    ];

    const sanitized = sanitizeCompactionMessages(messages);

    expect(sanitized).toHaveLength(2);
    expect(sanitized[0]).not.toHaveProperty("details");
    expect(sanitized.map((message) => message.role)).toEqual(["toolResult", "user"]);
  });

  it("bounds oversized tool-result text before worker cloning while preserving token pressure", () => {
    const hugeText = "x".repeat(120_000);
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: hugeText }],
        timestamp: 1,
      } satisfies AgentMessage,
    ];

    const projected = projectCompactionMessagesForPlanning(messages);
    const originalJson = JSON.stringify(messages);
    const projectedJson = JSON.stringify(projected);

    expect(projectedJson.length).toBeLessThan(originalJson.length / 4);
    expect(projectedJson).not.toContain(hugeText);
    expect(estimateMessagesTokens(projected)).toBeGreaterThanOrEqual(
      estimateMessagesTokens(messages),
    );
  });

  it("bounds thinking and nested tool-call arguments before worker cloning", () => {
    const hugeText = "\n".repeat(120_000);
    const unmeasurableArgument = "\ud800".repeat(200_000);
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "gpt-5.6-luna",
        content: [
          { type: "thinking", thinking: hugeText, thinkingSignature: hugeText },
          {
            type: "toolCall",
            id: "call_large",
            name: "write",
            thoughtSignature: hugeText,
            arguments: {
              content: hugeText,
              unmeasurableArgument,
              nested: { note: hugeText },
              values: Array.from({ length: 50_000 }, (_, index) => index),
            },
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    ];

    const projected = projectCompactionMessagesForPlanning(messages);
    const projectedJson = JSON.stringify(projected);
    const projectedAssistant = projected[0];

    expect(projectedJson.length).toBeLessThan(JSON.stringify(messages).length / 4);
    expect(projectedJson).not.toContain(hugeText);
    expect(projectedAssistant?.role).toBe("assistant");
    if (!projectedAssistant || projectedAssistant.role !== "assistant") {
      throw new Error("expected projected assistant");
    }
    const projectedToolCall = projectedAssistant.content.find((block) => block.type === "toolCall");
    if (!projectedToolCall || projectedToolCall.type !== "toolCall") {
      throw new Error("expected projected tool call");
    }
    expect(projectedToolCall.arguments).toEqual({});
    expect(estimateMessagesTokens(projected)).toBeGreaterThan(Number.MAX_SAFE_INTEGER / 8);
  });

  it("bounds aggregate planning payloads and custom message variants", () => {
    const hugeText = "x".repeat(32_768);
    const customMessage = {
      role: "custom" as const,
      customType: "test",
      content: "visible",
      display: false,
      details: { raw: hugeText },
      timestamp: 0,
    } satisfies AgentMessage;
    const messages: AgentMessage[] = [
      customMessage,
      {
        role: "bashExecution",
        command: hugeText,
        output: hugeText,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      },
      { role: "branchSummary", summary: hugeText, fromId: "branch", timestamp: 2 },
      { role: "compactionSummary", summary: hugeText, tokensBefore: 1, timestamp: 3 },
      ...Array.from({ length: 64 }, (_, index) => ({
        role: "user" as const,
        content: hugeText,
        timestamp: index + 4,
      })),
    ];

    const projected = projectCompactionMessagesForPlanning(messages);
    const projectedJson = JSON.stringify(projected);
    const projectedCustom = projected[0];

    expect(projectedJson.length).toBeLessThan(JSON.stringify(messages).length / 4);
    expect(projectedCustom).not.toHaveProperty("details");
    expect(estimateMessagesTokens(projected)).toBeGreaterThanOrEqual(
      estimateMessagesTokens(messages),
    );
  });

  it("keeps later small tool calls within a realistic token estimate", () => {
    const messages: AgentMessage[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "user" as const,
        content: "x".repeat(32_768),
        timestamp: index,
      })),
      {
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "gpt-5.6-luna",
        content: [{ type: "toolCall", id: "call_late", name: "read", arguments: { path: "x" } }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 9,
      } satisfies AgentMessage,
    ];

    const projected = projectCompactionMessagesForPlanning(messages);
    const last = projected.at(-1);

    expect(last?.role).toBe("assistant");
    expect(estimateMessagesTokens(last ? [last] : [])).toBeLessThan(100);
  });

  it("removes tool-result image bytes while preserving image pressure and summary semantics", () => {
    const imageData = "a".repeat(1_000_000);
    const userImageMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
      timestamp: 0,
    } satisfies AgentMessage;
    const imageMessage = {
      role: "toolResult",
      toolCallId: "call_image",
      toolName: "browser",
      isError: false,
      content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      timestamp: 1,
    } satisfies AgentMessage;
    const messages: AgentMessage[] = [userImageMessage, imageMessage];

    const projected = projectCompactionMessagesForPlanning(messages);
    const projectedUserMessage = projected[0];
    expect(projectedUserMessage?.role).toBe("user");
    if (!projectedUserMessage || projectedUserMessage.role !== "user") {
      throw new Error("expected projected user message");
    }
    const projectedUserImage = Array.isArray(projectedUserMessage.content)
      ? projectedUserMessage.content[1]
      : undefined;
    const projectedMessage = projected[1];
    expect(projectedMessage?.role).toBe("toolResult");
    if (!projectedMessage || projectedMessage.role !== "toolResult") {
      throw new Error("expected projected tool result");
    }
    const projectedImage = projectedMessage.content[0];

    expect(projectedUserImage).toMatchObject({ type: "image", data: "", mimeType: "image/png" });
    expect(projectedImage).toMatchObject({ type: "image", data: "", mimeType: "image/png" });
    expect(JSON.stringify(projected)).not.toContain(imageData);
    expect(estimateMessagesTokens(projected)).toBe(estimateMessagesTokens(messages));
    expect(serializeConversation([projectedUserMessage, projectedMessage])).toBe(
      serializeConversation([userImageMessage, imageMessage]),
    );
  });
});
