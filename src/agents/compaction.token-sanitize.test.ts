// Verifies compaction token planning strips private/non-model fields first.
import { serializeConversation, type AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  buildOversizedFallbackPlan,
  estimateMessagesTokens,
  projectCompactionMessagesForPlanning,
} from "./compaction-planning.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

describe("compaction token accounting sanitization", () => {
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

    const sanitized = projectCompactionMessagesForPlanning(messages);

    expect(estimateMessagesTokens(messages)).toBe(estimateMessagesTokens(sanitized));
    expect(sanitized[0]).not.toHaveProperty("details");
    expect(sanitized.map((message) => message.role)).toEqual(["toolResult", "user"]);
  });

  it.each([
    { script: "ASCII", glyph: "x" },
    { script: "common CJK", glyph: "漢" },
    { script: "rare BMP CJK", glyph: "㐀" },
    { script: "supplementary CJK", glyph: "𠀀" },
  ])("bounds $script text and arguments without losing token pressure", ({ glyph }) => {
    const hugeText = glyph.repeat(40_000);
    const messages: AgentMessage[] = [
      { role: "user", content: hugeText, timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "browser",
        isError: false,
        content: [{ type: "text", text: hugeText }],
        timestamp: 1,
      },
      makeAgentAssistantMessage({
        content: [{ type: "thinking", thinking: hugeText, thinkingSignature: hugeText }],
      }),
      // Fill the payload budget so even small later JSON values must be projected.
      ...Array.from({ length: 8 }, (_, timestamp) => ({
        role: "user" as const,
        content: "x".repeat(32_768),
        timestamp: timestamp + 2,
      })),
      ...[hugeText, "small"].map((text) =>
        makeAgentAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call_args",
              name: "write",
              arguments: { [text]: { nested: [text, '\n"\\\ud800'] } },
            },
          ],
        }),
      ),
    ];

    const projected = projectCompactionMessagesForPlanning(messages);
    const projectedJson = JSON.stringify(projected);
    expect(projectedJson.length).toBeLessThan(280_000);
    expect(projectedJson.length).toBeLessThan(JSON.stringify(messages).length);
    expect(projectedJson).not.toContain(hugeText);
    expect(projectedJson).not.toContain("thinkingSignature");
    for (const [index, message] of messages.entries()) {
      const tokens = estimateMessagesTokens([message]);
      const projectedTokens = estimateMessagesTokens([projected[index]!]);
      expect(projectedTokens).toBeGreaterThanOrEqual(tokens);
      // Independently rounded retained and omitted estimates can add one token.
      expect(projectedTokens).toBeLessThanOrEqual(tokens + 1);
      for (const contextWindow of [tokens * 2, tokens * 3]) {
        const direct = buildOversizedFallbackPlan({ messages: [message], contextWindow });
        const planned = buildOversizedFallbackPlan({
          messages: [projected[index]!],
          contextWindow,
        });
        expect(planned.oversizedNotes).toEqual(direct.oversizedNotes);
        expect(planned.smallMessages).toHaveLength(direct.smallMessages.length);
      }
    }
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
