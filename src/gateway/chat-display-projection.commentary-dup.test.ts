import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  reduceSessionProjection,
  readSessionMessageIdentity,
} from "../../packages/gateway-client/src/session-projection.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

const runId = "run-commentary-dup";

function textOf(message: unknown): string[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (block): block is { text: string } =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text);
}

const user = {
  role: "user",
  content: [{ type: "text", text: "Look it up for me." }],
  __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
};

// A mixed turn: inter-tool commentary text, then a tool call, then the final answer.
const mixedCommentary = {
  role: "assistant",
  content: [
    {
      type: "text",
      text: "Searching for the answer…",
      textSignature: '{"v":1,"phase":"commentary","id":"commentary-0"}',
    },
    { type: "toolCall", id: "call-1", name: "web_search", arguments: {} },
    {
      type: "text",
      text: "The answer is 42.",
      textSignature: '{"v":1,"phase":"final_answer"}',
    },
  ],
  stopReason: "stop",
  __openclaw: { id: "assistant", seq: 2, runId },
};

describe("commentary fallback reconciliation", () => {
  it("keeps inter-tool commentary text exactly once across incremental delivery", () => {
    // Server side: history serving emits a keyed "segment fallback" row next to
    // the full row (with commentary stripped). Both keep the owning transcript id.
    const projected = projectChatDisplayMessages([user, mixedCommentary], {
      includeCommentaryFallbacks: true,
    });

    // Client side: deliver each projected row incrementally, the way live
    // session.message events and history cursors do.
    let projection = createSessionProjection({ sessionKey: "agent:main:commentary-dup" });
    for (const message of projected) {
      projection = reduceSessionProjection(projection, {
        type: "messagePersisted",
        message,
        envelope: { runId },
      });
    }

    const texts = projection.messages.flatMap(textOf);
    expect(texts.filter((t) => t === "Searching for the answer…")).toHaveLength(1);
    expect(texts).toContain("The answer is 42.");
    // The fallback row and the full row remain distinct entries.
    expect(projection.messages).toHaveLength(3);
  });

  it("keeps the fallback row resolvable by its owning transcript id", () => {
    const projected = projectChatDisplayMessages([user, mixedCommentary], {
      includeCommentaryFallbacks: true,
    });
    const ids = projected.map((message) => readSessionMessageIdentity(message)?.id);
    // The fallback row still advertises the owning transcript id so recovery and
    // reply lookups (chat.message.get) keep resolving.
    expect(ids).toEqual(["user", "assistant", "assistant"]);
  });
});
