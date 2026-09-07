import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";

describe("chat.message.get recovery visibility", () => {
  it("hides recovered empty failures while retaining unresolved, partial, and successful replies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:message-recovery",
        sessionId: "message-recovery",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        eventId: "user",
        message: { role: "user", content: "hello" },
      });
      const failure = {
        role: "assistant",
        provider: "openai",
        model: "primary",
        content: [],
        stopReason: "error",
        errorMessage: "model unavailable",
        __openclaw: { runId: "run-recovery" },
      };
      await appendTranscriptMessage(scope, { eventId: "failed", message: failure });
      const respond = vi.fn();
      const context = createDirectChatContext();
      const lookup = async (messageId: string) => {
        respond.mockClear();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: { sessionKey: scope.sessionKey, messageId },
          context,
          req: { type: "req", id: "message-recovery", method: "chat.message.get" },
          client: null,
          isWebchatConnect: () => false,
          respond,
        });
      };
      await lookup("failed");
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));

      await appendTranscriptMessage(scope, {
        eventId: "answer",
        message: {
          ...failure,
          model: "backup",
          stopReason: "stop",
          errorMessage: undefined,
          content: [{ type: "text", text: "Recovered answer" }],
        },
      });
      const persisted = await loadTranscriptEvents(scope);
      await lookup("failed");
      expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_found" });
      await lookup("answer");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          message: expect.objectContaining({
            content: [{ type: "text", text: "Recovered answer" }],
          }),
        }),
      );
      expect(await loadTranscriptEvents(scope)).toEqual(persisted);

      await appendTranscriptMessage(scope, {
        eventId: "partial",
        message: { ...failure, content: [{ type: "text", text: "Partial answer" }] },
      });
      await lookup("partial");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          message: expect.objectContaining({ content: [{ type: "text", text: "Partial answer" }] }),
        }),
      );
    });
  });
});
