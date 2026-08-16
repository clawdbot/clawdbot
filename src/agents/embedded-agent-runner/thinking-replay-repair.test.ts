// Provider thinking replay repair tests cover durable transcript cleanup after
// Anthropic/Bedrock proves a signed thinking block invalid.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import {
  repairRejectedCompactionReplayInSessionManager,
  repairRejectedThinkingReplayInSessionManager,
} from "./thinking-replay-repair.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function branchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function branchAssistantContents(sessionManager: SessionManager): unknown[] {
  return branchMessages(sessionManager)
    .filter((message): message is Extract<AgentMessage, { role: "assistant" }> => {
      return message.role === "assistant";
    })
    .map((message) => message.content);
}

describe("repairRejectedThinkingReplayInSessionManager", () => {
  it("strips thinking blocks from active-branch assistant messages and preserves visible content", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", thinkingSignature: "sig_bad" },
          { type: "text", text: "visible answer" },
        ],
        timestamp: 2,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({ role: "user", content: "second", timestamp: 3 }),
    );

    const result = repairRejectedThinkingReplayInSessionManager({ sessionManager });

    expect(result).toMatchObject({ repaired: true, repairedCount: 1 });
    expect(branchMessages(sessionManager).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(branchAssistantContents(sessionManager)).toEqual([
      [{ type: "text", text: "visible answer" }],
    ]);
  });

  it("keeps thinking-only assistant turns as omitted-reasoning placeholders", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "private", thinkingSignature: "sig_bad" }],
        timestamp: 2,
      }),
    );

    const result = repairRejectedThinkingReplayInSessionManager({ sessionManager });

    expect(result).toMatchObject({ repaired: true, repairedCount: 1 });
    expect(branchAssistantContents(sessionManager)).toEqual([
      [{ type: "text", text: "[assistant reasoning omitted]" }],
    ]);
  });

  it("preserves downstream branch suffix entries after rewriting the first repaired assistant", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", thinkingSignature: "sig_bad" },
          { type: "text", text: "first answer" },
        ],
        timestamp: 2,
      }),
    );
    sessionManager.appendMessage(
      asAppendMessage({ role: "user", content: "follow-up", timestamp: 3 }),
    );
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "follow-up answer" }],
        timestamp: 4,
      }),
    );

    const result = repairRejectedThinkingReplayInSessionManager({ sessionManager });

    expect(result).toMatchObject({ repaired: true, repairedCount: 1 });
    expect(branchMessages(sessionManager).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(branchAssistantContents(sessionManager)).toEqual([
      [{ type: "text", text: "first answer" }],
      [{ type: "text", text: "follow-up answer" }],
    ]);
  });

  it("does not rewrite sessions without active-branch thinking blocks", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
    sessionManager.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
        timestamp: 2,
      }),
    );

    const beforeLeafId = sessionManager.getLeafId();
    const result = repairRejectedThinkingReplayInSessionManager({ sessionManager });

    expect(result).toMatchObject({
      repaired: false,
      repairedCount: 0,
      reason: "no thinking blocks on active branch",
    });
    expect(sessionManager.getLeafId()).toBe(beforeLeafId);
  });
});

describe("repairRejectedCompactionReplayInSessionManager", () => {
  it("rewrites from the checkpoint identity that supplied the rejected request", () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage(asAppendMessage({ role: "user", content: "first", timestamp: 1 }));
    for (const [data, id, timestamp] of [
      ["rejected-ciphertext", "cmp_rejected", 2],
      ["newer-ciphertext", "cmp_newer", 4],
    ] as const) {
      sessionManager.appendMessage(
        asAppendMessage({
          role: "assistant",
          content: [{ type: "text", text: id }],
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data,
            id,
            replayIndex: 0,
          },
          timestamp,
        }),
      );
      sessionManager.appendMessage(
        asAppendMessage({ role: "user", content: `after ${id}`, timestamp: timestamp + 1 }),
      );
    }

    expect(
      repairRejectedCompactionReplayInSessionManager({
        sessionManager,
        checkpoint: { data: "rejected-ciphertext", id: "cmp_rejected" },
      }),
    ).toMatchObject({ repaired: true, repairedCount: 1 });
    expect(
      branchMessages(sessionManager)
        .filter((message) => message.role === "assistant")
        .map((message) => message.providerReplay),
    ).toEqual([undefined, undefined]);
  });
});
