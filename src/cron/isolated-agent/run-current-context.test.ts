import { describe, expect, it, vi } from "vitest";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";

const sourceSessionEntry = {
  sessionId: "source-session",
  updatedAt: 0,
};

async function buildContext(messages: unknown[]) {
  return await buildCurrentConversationContextBlock(
    {
      agentId: "main",
      sourceSessionEntry,
      sourceSessionKey: "agent:main:telegram:direct:42",
      storePath: "/tmp/store.sqlite",
    },
    { readSessionMessages: vi.fn().mockResolvedValue(messages) },
  );
}

describe("buildCurrentConversationContextBlock", () => {
  it("keeps recent user and assistant text while filtering other roles and empty content", async () => {
    await expect(
      buildContext([
        { role: "system", content: "system prompt" },
        { role: "user", content: " first\n fact " },
        { role: "tool", content: "tool result" },
        { role: "assistant", content: [{ type: "text", text: "noted" }] },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
        { role: "user", content: "  " },
      ]),
    ).resolves.toBe("Recent conversation:\n- User: first fact\n- Assistant: noted");
  });

  it("projects raw transcript envelopes and assistant phases before truncation", async () => {
    await expect(
      buildContext([
        {
          role: "user",
          content:
            'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"message_id":"123"}\n```\n\nActual user fact',
        },
        ...Array.from({ length: 15 }, () => ({ role: "toolResult", content: "tool output" })),
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "internal reasoning",
              textSignature: JSON.stringify({
                v: 1,
                id: "item_commentary",
                phase: "commentary",
              }),
            },
            {
              type: "text",
              text: "Visible answer",
              textSignature: JSON.stringify({
                v: 1,
                id: "item_final",
                phase: "final_answer",
              }),
            },
          ],
        },
      ]),
    ).resolves.toBe("Recent conversation:\n- User: Actual user fact\n- Assistant: Visible answer");
  });

  it("caps lines and drops the oldest messages first to fit the count and block limits", async () => {
    const context = await buildContext(
      Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"x".repeat(300)}`,
      })),
    );

    expect(context).toBeDefined();
    const lines = context?.split("\n") ?? [];
    expect(context?.length).toBeLessThanOrEqual(1400);
    expect(lines.slice(1).every((line) => line.length <= 220)).toBe(true);
    expect(lines.some((line) => line.startsWith("- User: 0:"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- Assistant: 5:"))).toBe(false);
    expect(lines.some((line) => line.startsWith("- User: 6:"))).toBe(true);
    expect(lines.some((line) => line.startsWith("- Assistant: 11:"))).toBe(true);
    expect(context?.indexOf("- User: 6:")).toBeLessThan(context?.indexOf("- Assistant: 11:") ?? -1);
  });

  it("returns undefined for empty or unreadable transcripts", async () => {
    await expect(buildContext([])).resolves.toBeUndefined();
    await expect(
      buildCurrentConversationContextBlock(
        {
          agentId: "main",
          sourceSessionEntry,
          sourceSessionKey: "agent:main:telegram:direct:42",
          storePath: "/tmp/store.sqlite",
        },
        { readSessionMessages: vi.fn().mockRejectedValue(new Error("unreadable")) },
      ),
    ).resolves.toBeUndefined();
  });
});
