import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";

describe("chat history request byte budgets", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns a small tail with a lossless back-scroll cursor",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:budgeted-history",
          sessionId: "budgeted-history",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const messages = Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `record-${index}: ${"x".repeat(3_000)}` }],
        }));
        for (const message of messages) {
          await appendTranscriptMessage(scope, { message });
        }
        const context = createDirectChatContext();
        const request = async (params: Record<string, unknown>) => {
          let result: unknown;
          await expectDefined(
            chatHistoryHandlers[method],
            "history handler",
          )({
            params: { sessionKey: scope.sessionKey, limit: 80, ...params },
            context,
            req: { type: "req", id: "budgeted-history", method },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          return expectDefined(asOptionalRecord(result), "history response");
        };

        const tail = await request({ maxBytes: 8 * 1024 });
        expect(Buffer.byteLength(JSON.stringify(tail.messages))).toBeLessThanOrEqual(8 * 1024);
        expect(tail.hasMore).toBe(true);
        expect(tail.nextOffset).toBeGreaterThan(0);
        expect(JSON.stringify(tail.messages)).toContain("record-11:");
        const older = await request({ offset: tail.nextOffset });
        expect(older.hasMore).toBe(false);
        const restored = [...(older.messages as unknown[]), ...(tail.messages as unknown[])];
        expect(restored).toHaveLength(messages.length);
        for (const [index, message] of restored.entries()) {
          expect(JSON.stringify(message)).toContain(`record-${index}:`);
        }

        const longText = "Readable message beyond the soft page budget: " + "z".repeat(70_000);
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: [{ type: "text", text: longText }] },
        });
        expect(await request({ cursor: tail.deltaCursor, maxBytes: 8 * 1024 })).toEqual({
          kind: "reset",
        });
        const single = await request({ maxBytes: 64 * 1024, maxChars: 100_000 });
        expect(single.messages).toHaveLength(1);
        expect(JSON.stringify(single.messages)).toContain(longText);
        expect(single.hasMore).toBe(true);
      });
    },
  );
});
