// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const attachmentsToRelease: ChatAttachment[] = [];
const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  releaseChatAttachmentPayloads(attachmentsToRelease);
  attachmentsToRelease.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStagedAttachment(id: string): ChatAttachment {
  const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
  const attachment = registerChatAttachmentPayload({
    attachment: { id, mimeType: file.type, fileName: file.name, sizeBytes: file.size },
    dataUrl: attachmentDataUrl,
    file,
  });
  attachmentsToRelease.push(attachment);
  return attachment;
}

describe.each(["steer", "redirect"] as const)("handleSendChat /%s recovery", (command) => {
  const draft = `/${command} keep the correction available`;

  it.each(["timeout", "error", "rejected"] as const)(
    "restores submitted input after the %s acknowledgment",
    async (outcome) => {
      const attachment = createStagedAttachment(`${command}-${outcome}`);
      const host = makeChatHost({
        chatMessage: draft,
        chatAttachments: [attachment],
        requestHandlers: {
          "chat.send": () => {
            if (outcome === "rejected") {
              throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Request rejected" });
            }
            return { runId: "command-run", status: outcome };
          },
        },
      });

      await handleSendChat(host);

      expect(findChatSendPayload(host)).toMatchObject({
        message: "keep the correction available",
        queueMode: command === "steer" ? "steer" : "interrupt",
      });
      expect(host.chatMessage).toBe(draft);
      expect(host.chatAttachments).toEqual([expect.objectContaining({ id: attachment.id })]);
      expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
      expect(host.chatError).toBeTruthy();
      expect(host.chatQueue).toEqual([]);
    },
  );

  it.each(["started", "in_flight", "ok"] as const)(
    "retires the submitted draft after a successful %s acknowledgment",
    async (status) => {
      const host = makeChatHost({
        chatMessage: draft,
        chatRunId: "active-run",
        requestHandlers: { "chat.send": { runId: "command-run", status } },
      });

      await handleSendChat(host);

      expect(host.chatMessage).toBe("");
      expect(host.chatComposerFallbackByScope).toEqual({});
      expect(host.chatError).toBeFalsy();
      expect(host.chatRunId).toBe(
        command === "redirect" && status !== "ok" ? "command-run" : "active-run",
      );
    },
  );

  it("does not restore a failed command over a newer draft", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "timeout" }>();
    const newerAttachment = createStagedAttachment(`${command}-newer`);
    const host = makeChatHost({
      chatMessage: draft,
      requestHandlers: { "chat.send": () => acknowledgment.promise },
    });

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
    host.chatMessage = "Newer operator draft";
    host.chatAttachments = [newerAttachment];
    acknowledgment.resolve({ runId: "command-run", status: "timeout" });
    await send;

    expect(host.chatMessage).toBe("Newer operator draft");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(getChatAttachmentDataUrl(newerAttachment)).toBe(attachmentDataUrl);
  });

  it("retains a failed command in its submitted session after navigation", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "timeout" }>();
    const attachment = createStagedAttachment(`${command}-submitted-session`);
    const host = makeChatHost({
      sessionKey: "agent:main:first",
      chatMessage: draft,
      chatAttachments: [attachment],
      requestHandlers: { "chat.send": () => acknowledgment.promise },
    });
    const submittedScopeKey = storedChatOutboxScopeKey(
      captureChatOutboxAdmission(host, host.sessionKey).scope,
    );

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "Second session draft";
    host.chatError = "Second session error";
    acknowledgment.resolve({ runId: "command-run", status: "timeout" });
    await send;

    expect(host.chatMessage).toBe("Second session draft");
    expect(host.chatError).toBe("Second session error");
    const fallbacks = Object.entries(host.chatComposerFallbackByScope);
    expect(fallbacks).toHaveLength(1);
    const [scopeKey, fallback] = fallbacks[0]!;
    expect(scopeKey).toBe(submittedScopeKey);
    expect(fallback.message).toBe(draft);
    expect(getChatAttachmentDataUrl(fallback.attachments[0]!)).toBe(attachmentDataUrl);
  });
});
