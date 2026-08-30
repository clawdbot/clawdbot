import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import type { GatewayRequestContext } from "./types.js";

describe("pending input read boundary", () => {
  it("redacts Responses inline images from pending history and message lookup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:pending-image",
        sessionId: "pending-image-session",
      };
      const imageUrl = "DATA:image/png;BASE64,cGVuZGluZw==";
      const redactedContent = [
        {
          type: "input_image",
          omitted: true,
          bytes: Buffer.byteLength(imageUrl, "utf8"),
        },
      ];
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "pending-image-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            content: [{ type: "input_image", image_url: imageUrl }],
            timestamp: 1,
            idempotencyKey: "pending-image:user",
          },
        }),
        "pending image receipt",
      );
      try {
        const page = readChatPendingInputs(scope, { limit: 1, maxChars: 1_000 });
        expect(page.items[0]?.message.content).toEqual(redactedContent);
        expect(JSON.stringify(page)).not.toContain(imageUrl);

        const respond = vi.fn();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: {
            sessionKey: scope.sessionKey,
            messageId: `pending:${receipt.inputId}`,
          },
          respond,
          context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            message: expect.objectContaining({ content: redactedContent }),
          }),
        );
        expect(JSON.stringify(respond.mock.lastCall)).not.toContain(imageUrl);
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("keeps cancelled input readable and sanitized without changing the transcript or crossing a reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:accepted",
        sessionId: "accepted-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "r".repeat(300),
          assertCurrent: () => {},
          message: {
            role: "user",
            content: "Accepted input ".repeat(2000),
            timestamp: 1,
            idempotencyKey: "queued:user",
            __openclaw: {
              media: [
                {
                  kind: "image",
                  data: "synthetic-inline-payload",
                  url: "https://example.test/image?credential=synthetic",
                },
              ],
            },
          },
        }),
        "pending receipt",
      );
      try {
        receipt.finish("cancelled");
        const page = readChatPendingInputs(scope, { limit: 1, maxChars: 50 });
        const displayId = `pending:${receipt.inputId}`;
        expect(page).toMatchObject({
          total: 1,
          items: [
            { state: "cancelled", message: { __openclaw: { id: displayId, truncated: true } } },
          ],
        });
        expect(page.items[0]).not.toHaveProperty("runId");
        expect(JSON.stringify(page)).not.toContain("synthetic-inline-payload");
        expect(JSON.stringify(page)).not.toContain("credential=");
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        const respond = vi.fn();
        const lookup = () =>
          expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId: displayId },
            respond,
            context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
            req: {} as never,
            client: null,
            isWebchatConnect: () => false,
          });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            message: expect.objectContaining({ content: receipt.message.content }),
          }),
        );
        await upsertSessionEntryCore(scope, { sessionId: "replacement-session", updatedAt: 2 });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(true, {
          ok: false,
          unavailableReason: "not_found",
        });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("does not reveal an input hidden by the canonical history visibility policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:hidden-input",
        sessionId: "hidden-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "hidden-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            display: false,
            content: "Internal continuation",
            timestamp: 1,
            idempotencyKey: "hidden:user",
          },
        }),
        "hidden pending receipt",
      );
      try {
        expect(readChatPendingInputs(scope, { limit: 20, maxChars: 100 }).items).toEqual([]);
        const respond = vi.fn();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: { sessionKey: scope.sessionKey, messageId: `pending:${receipt.inputId}` },
          respond,
          context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_visible" });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });
});
