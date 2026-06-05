// Embedded run helper tests cover final assistant text extraction and error
// metadata assembly shared by normal exits and failure paths.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createUsageAccumulator } from "../usage-accumulator.js";
import {
  buildErrorAgentMeta,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
} from "./helpers.js";

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  // Minimal assistant fixture with usage fields required by the SDK type; the
  // tested helpers only care about content, phase, and final metadata.
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    // Commentary can be streamed before the final answer; user-visible result
    // extraction must choose the signed final phase when present.
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "   ",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "<final>keep this</final>",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantRawText(lastAssistant)).toBe("<final>keep this</final>");
  });
});

describe("buildErrorAgentMeta", () => {
  it("preserves active session file for error exits after transcript rotation", () => {
    // Error metadata follows the active session after transcript rotation so
    // diagnostics and resume links point at the file that contains the failure.
    expect(
      buildErrorAgentMeta({
        sessionId: "session-rotated",
        sessionFile: "/tmp/session-rotated.jsonl",
        provider: "anthropic",
        model: "claude-opus-4-6",
        usageAccumulator: createUsageAccumulator(),
        lastRunPromptUsage: undefined,
      }),
    ).toMatchObject({
      sessionId: "session-rotated",
      sessionFile: "/tmp/session-rotated.jsonl",
    });
  });
});
