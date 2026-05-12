import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  projectContextEngineAssemblyForCodex,
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
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

    expect(result.promptText).not.toContain("[user]\nNeed the latest answer");
    expect(result.promptText).toContain("Current user request:\nNeed the latest answer");
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
    expect(ordered.promptText).toContain("[user]\none\n\n[assistant]\ntwo\n\n[toolResult]\nthree");
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

    expect(result.promptText).toContain("quoted reference data");
    expect(result.promptText).toContain("tool call: exec [input omitted]");
    expect(result.promptText).toContain("tool result: call-1 [content omitted]");
    expect(result.promptText).not.toContain("sk-secret");
    expect(result.promptText).not.toContain("cat .env");
  });

  it("bounds oversized text context", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [textMessage("assistant", "x".repeat(30_000))],
      originalHistoryMessages: [],
      prompt: "next",
    });

    expect(result.promptText).toContain("[truncated ");
    expect(result.promptText.length).toBeLessThan(25_000);
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

    expect(result.promptText.length).toBeGreaterThan(60_000);
    expect(result.promptText).not.toContain("[truncated ");
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

  it("maps OpenClaw compaction reserve config onto Codex projection reserves", () => {
    expect(
      resolveCodexContextEngineProjectionReserveTokens({
        config: { agents: { defaults: { compaction: { reserveTokens: 12_000 } } } },
      }),
    ).toBe(20_000);
    expect(
      resolveCodexContextEngineProjectionReserveTokens({
        config: {
          agents: { defaults: { compaction: { reserveTokens: 12_000, reserveTokensFloor: 0 } } },
        },
      }),
    ).toBe(12_000);
    expect(
      resolveCodexContextEngineProjectionReserveTokens({
        config: { agents: { defaults: { compaction: { reserveTokens: 48_000 } } } },
      }),
    ).toBe(48_000);
    expect(
      resolveCodexContextEngineProjectionReserveTokens({
        config: { agents: { defaults: { compaction: { reserveTokensFloor: 0 } } } },
      }),
    ).toBe(0);
  });

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
