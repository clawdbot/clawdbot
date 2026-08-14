// Provider thinking replay repair tests cover durable transcript cleanup after
// Anthropic/Bedrock proves a signed thinking block invalid.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { testing } from "../openai-transport-stream.test-support.js";
import { convertToLlm } from "../sessions/messages.js";
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

  it("removes a rejected checkpoint from the reopened SQLite branch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-repair-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "compaction-repair-session";
      const sessionKey = "agent:main:compaction-repair";
      const sessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath,
      });
      const target = { agentId: "main", sessionId, sessionKey, storePath };
      await replaceSessionEntry({ sessionKey, storePath }, {
        sessionFile,
        sessionId,
        updatedAt: 10,
      } as SessionEntry);

      const model = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      } satisfies Model<"openai-responses">;
      const identity = { sessionId, authProfileId: "profile-a" };
      const replayContext = testing.buildOpenAIResponsesReasoningReplayMetadata(model, identity);
      const checkpointContext = {
        provider: replayContext.provider,
        api: replayContext.api,
        model: replayContext.model,
        baseUrlHash: replayContext.baseUrlHash,
        sessionHash: replayContext.sessionHash,
        authProfileHash: replayContext.authProfileHash,
      };
      const sessionManager = SessionManager.open(target, dir);
      sessionManager.appendMessage(
        asAppendMessage({ role: "user", content: "full history prefix", timestamp: 1 }),
      );
      sessionManager.appendMessage(
        asAppendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "toolUse",
          timestamp: 2,
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            id: "cmp_rejected",
            data: "rejected-compaction-ciphertext",
            replayIndex: 0,
            ...checkpointContext,
          },
        }),
      );
      sessionManager.appendMessage(
        asAppendMessage({
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 3,
        }),
      );
      sessionManager.appendMessage(
        asAppendMessage({ role: "user", content: "current turn", timestamp: 4 }),
      );

      const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      });
      const retryStream = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new Error("retry stream failed");
            },
          };
        },
      };
      const create = vi
        .fn()
        .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
        .mockReturnValueOnce({
          withResponse: vi.fn().mockResolvedValue({
            data: retryStream,
            response: new Response(null, { status: 200 }),
          }),
        });
      let repairResult:
        | ReturnType<typeof repairRejectedCompactionReplayInSessionManager>
        | undefined;
      const recovery = await testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: {
          model: model.id,
          stream: true,
          input: [
            {
              type: "compaction",
              id: "cmp_rejected",
              encrypted_content: "rejected-compaction-ciphertext",
            },
          ],
        },
        requestOptions: undefined,
        model,
        onCompactionRejected: (checkpoint) => {
          repairResult = repairRejectedCompactionReplayInSessionManager({
            sessionManager,
            checkpoint,
          });
        },
      });
      await expect(recovery.stream[Symbol.asyncIterator]().next()).rejects.toThrow(
        "retry stream failed",
      );
      expect(repairResult).toMatchObject({ repaired: true, repairedCount: 1 });

      const reopened = SessionManager.open(target, dir);
      const messages = reopened.buildSessionContext().messages;
      expect(
        messages.find((message) => message.role === "assistant")?.providerReplay,
      ).toBeUndefined();
      const request = testing.buildOpenAIResponsesParams(
        model,
        { systemPrompt: "system", messages: convertToLlm(messages) },
        identity,
      );
      expect(request.input.some((item) => item.type === "compaction")).toBe(false);
      const encoded = JSON.stringify(request.input);
      expect(encoded).not.toContain("rejected-compaction-ciphertext");
      expect(encoded).toContain("full history prefix");
      expect(encoded).toContain("function_call");
      expect(encoded).toContain("function_call_output");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
