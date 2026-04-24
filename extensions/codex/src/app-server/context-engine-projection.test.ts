import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";

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
});
