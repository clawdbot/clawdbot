// Codex tests cover context engine projection plugin behavior.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  fitCodexAdditionalContextForTurnStart,
  fitCodexTurnStartText,
  projectContextEngineAssemblyForCodex,
  resolveCodexContextEngineProjectionMaxChars,
} from "./context-engine-projection.js";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
  } as AgentMessage;
}

describe("projectContextEngineAssemblyForCodex", () => {
  it("produces stable output for identical inputs", () => {
    const params = {
      assembledMessages: [
        textMessage("user", "Earlier question"),
        textMessage("assistant", "Earlier answer"),
      ],
      originalHistoryMessages: [textMessage("user", "Earlier question")],
      prompt: "Need the latest answer",
      systemPromptAddition: "memory recall",
    };

    expect(projectContextEngineAssemblyForCodex(params)).toEqual(
      projectContextEngineAssemblyForCodex(params),
    );
  });

  it("drops a duplicate trailing current prompt from assembled history", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        textMessage("assistant", "You already asked this."),
        textMessage("user", "Need the latest answer"),
      ],
      originalHistoryMessages: [textMessage("assistant", "You already asked this.")],
      prompt: "Need the latest answer",
      systemPromptAddition: "memory recall",
    });

    expect(result.additionalContext).not.toContain("[user]\nNeed the latest answer");
    expect(result.promptText).toBe("Need the latest answer");
    expect(result.developerInstructionAddition).toBe("memory recall");
  });

  it("preserves role order and falls back to the raw prompt for empty history", () => {
    const empty = projectContextEngineAssemblyForCodex({
      assembledMessages: [],
      originalHistoryMessages: [],
      prompt: "hello",
    });
    expect(empty.promptText).toBe("hello");

    const ordered = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        textMessage("user", "one"),
        textMessage("assistant", "two"),
        textMessage("toolResult", "three"),
      ],
      originalHistoryMessages: [textMessage("user", "seed")],
      prompt: "next",
    });
    expect(ordered.additionalContext).toContain(
      "[user]\none\n\n[assistant]\ntwo\n\n[toolResult]\nthree",
    );
    expect(ordered.prePromptMessageCount).toBe(1);
  });

  it("frames projected history as reference data and omits tool payloads", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "exec", input: { token: "sk-secret", cmd: "cat .env" } },
          ],
          timestamp: 1,
        } as unknown as AgentMessage,
        {
          role: "toolResult",
          content: [{ type: "toolResult", toolUseId: "call-1", content: "API_KEY=sk-secret" }],
          timestamp: 2,
        } as unknown as AgentMessage,
      ],
      originalHistoryMessages: [],
      prompt: "continue",
    });

    expect(result.additionalContext).toContain("quoted reference data");
    expect(result.additionalContext).toContain("tool call: exec [input omitted]");
    expect(result.additionalContext).toContain("tool result: call-1 [content omitted]");
    expect(result.additionalContext).not.toContain("sk-secret");
    expect(result.additionalContext).not.toContain("cat .env");
  });

  it("preserves redacted tool payload context for thread bootstrap projections", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "exec",
              input: {
                token: "sk-1234567890abcdef",
                cmd: "cat .env",
                options: { recursive: true },
              },
            },
          ],
          timestamp: 1,
        } as unknown as AgentMessage,
        {
          role: "toolResult",
          content: [
            {
              type: "toolResult",
              toolUseId: "call-1",
              content: "OPENAI_API_KEY=sk-1234567890abcdef\nstatus ok",
            },
          ],
          timestamp: 2,
        } as unknown as AgentMessage,
      ],
      originalHistoryMessages: [],
      prompt: "continue",
      toolPayloadMode: "preserve",
    });

    expect(result.additionalContext).toContain("tool call: exec");
    expect(result.additionalContext).toContain('"inputShape"');
    expect(result.additionalContext).toContain('"token": "[string]"');
    expect(result.additionalContext).toContain('"cmd": "[string]"');
    expect(result.additionalContext).toContain('"recursive": "[boolean]"');
    expect(result.additionalContext).toContain("tool result: call-1");
    expect(result.additionalContext).toContain('"content"');
    expect(result.additionalContext).toContain("OPENAI_API_KEY=");
    expect(result.additionalContext).toContain("status ok");
    expect(result.additionalContext).not.toContain("cat .env");
    expect(result.additionalContext).not.toContain("sk-1234567890abcdef");
  });

  it("bounds oversized text context", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [textMessage("assistant", "x".repeat(30_000))],
      originalHistoryMessages: [],
      prompt: "next",
    });

    expect(result.additionalContext).toContain("[truncated ");
    expect(result.additionalContext?.length).toBeLessThan(25_000);
  });

  it("reports the exact text dropped when a text-part boundary crosses an emoji", () => {
    const prefix = "x".repeat(5_999);
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [textMessage("assistant", `${prefix}😀tail`)],
      originalHistoryMessages: [],
      prompt: "next",
    });

    expect(result.additionalContext).toContain(`[assistant]\n${prefix}\n[truncated 6 chars]`);
  });

  it("keeps recent context when the rendered conversation overflows", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        textMessage("assistant", `old discrawl setup from previous day ${"x".repeat(5_850)}`),
        ...Array.from({ length: 5 }, (_, index) =>
          textMessage("assistant", `stale filler ${index}:${"x".repeat(5_850)}`),
        ),
        textMessage(
          "user",
          "have Codex CLI do it via /goal. tell it in a SEPARATE repo; create recrawl",
        ),
        textMessage("assistant", "codex exec -C /tmp/recrawl started"),
      ],
      originalHistoryMessages: [],
      prompt: "?",
    });

    expect(result.additionalContext).toContain("[truncated ");
    expect(result.additionalContext).toContain("from older context");
    expect(result.additionalContext).not.toContain("old discrawl setup from previous day");
    expect(result.additionalContext).toContain("create recrawl");
    expect(result.additionalContext).toContain("codex exec -C /tmp/recrawl started");
    expect(result.promptText).toBe("?");
    expect(result.additionalContext?.length).toBeLessThan(25_000);
  });

  it("can scale the rendered context cap for larger Codex context windows", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: Array.from({ length: 12 }, (_, index) =>
        textMessage("assistant", `${index}:${"x".repeat(5_900)}`),
      ),
      originalHistoryMessages: [],
      prompt: "next",
      maxRenderedContextChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: 80_000,
      }),
    });

    expect(result.additionalContext?.length).toBeGreaterThan(60_000);
    expect(result.additionalContext).not.toContain("[truncated ");
  });

  it("bounds the current request and surrounding context independently", () => {
    const request = `urgent request ${"u".repeat(800)}`;
    const fittedRequest = fitCodexTurnStartText({ promptText: request, maxChars: 420 });
    const fittedContext = fitCodexAdditionalContextForTurnStart({
      contextText: `old context ${"c".repeat(800)}`,
      currentRequestChars: fittedRequest.length,
      maxChars: 840,
    });

    expect(fittedRequest.length).toBeLessThanOrEqual(420);
    expect(fittedRequest).toContain("u".repeat(100));
    expect(fittedContext?.length).toBeLessThanOrEqual(420);
    expect(fittedContext).toContain("[truncated ");
  });

  it("never splits a UTF-16 surrogate pair while fitting context", () => {
    const fitted = fitCodexAdditionalContextForTurnStart({
      contextText: `${"x".repeat(400)}😀tail`,
      currentRequestChars: 60,
      maxChars: 140,
    });

    expect(fitted).not.toContain("�");
  });

  it("keeps the old conservative cap when no runtime budget is available", () => {
    expect(resolveCodexContextEngineProjectionMaxChars({})).toBe(24_000);
    expect(resolveCodexContextEngineProjectionMaxChars({ contextTokenBudget: 0 })).toBe(24_000);
  });

  it("uses the shared reserve-token shape while preserving small-model prompt budget", () => {
    expect(resolveCodexContextEngineProjectionMaxChars({ contextTokenBudget: 80_000 })).toBe(
      240_000,
    );
    expect(resolveCodexContextEngineProjectionMaxChars({ contextTokenBudget: 16_000 })).toBe(
      32_000,
    );
  });

  it.each([
    { contextTokenBudget: 4_000, maxRenderedContextChars: 8_000 },
    { contextTokenBudget: 8_000, maxRenderedContextChars: 16_000 },
  ])(
    "keeps a $contextTokenBudget-token model within its reserved prompt budget",
    ({ contextTokenBudget, maxRenderedContextChars }) => {
      expect(resolveCodexContextEngineProjectionMaxChars({ contextTokenBudget })).toBe(
        maxRenderedContextChars,
      );
    },
  );

  it("applies configured reserve tokens to the scaled projection cap", () => {
    expect(
      resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: 80_000,
        reserveTokens: 40_000,
      }),
    ).toBe(160_000);
  });

  it("caps very large runtime budgets to a bounded projection size", () => {
    expect(resolveCodexContextEngineProjectionMaxChars({ contextTokenBudget: 1_000_000 })).toBe(
      1_000_000,
    );
  });
});
