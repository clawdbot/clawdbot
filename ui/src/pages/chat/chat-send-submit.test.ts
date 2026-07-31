// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";

const attachmentsToRelease: ChatAttachment[] = [];
const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

afterEach(() => {
  releaseChatAttachmentPayloads(attachmentsToRelease);
  attachmentsToRelease.length = 0;
});

function createStagedAttachment(id: string): ChatAttachment {
  const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
  const attachment = registerChatAttachmentPayload({
    attachment: {
      id,
      mimeType: "application/pdf",
      fileName: "brief.pdf",
      sizeBytes: file.size,
    },
    dataUrl: attachmentDataUrl,
    file,
  });
  attachmentsToRelease.push(attachment);
  return attachment;
}

function createImmediateCommandHost(
  command: string,
  attachment: ChatAttachment,
  overrides: Partial<ChatHost> = {},
): ChatHost {
  const host = {
    sessions: createSessionCapability({
      snapshot: { client: null, phase: "reconnecting", hello: null },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    }),
    client: null,
    connected: true,
    sessionKey: "agent:main",
    chatLoading: false,
    chatMessage: command,
    chatMessages: [],
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatAttachments: [attachment],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatModelCatalog: [],
    hello: null,
    refreshSessionsAfterChat: new Map(),
    ...overrides,
  } satisfies Partial<ChatHost>;
  return host as ChatHost;
}

describe("handleSendChat immediate local commands", () => {
  it.each(["/export-session", "/export"])(
    "preserves staged attachments while %s exports the chat",
    async (command) => {
      const attachment = createStagedAttachment("export-att");
      const exportCurrentChat = vi.fn();
      const host = createImmediateCommandHost(command, attachment, { exportCurrentChat });

      await handleSendChat(host);

      expect(exportCurrentChat).toHaveBeenCalledOnce();
      expect(host.chatMessage).toBe("");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toStrictEqual([]);
    },
  );

  it("does not duplicate staged attachments into both old and new session composers", async () => {
    const attachment = createStagedAttachment("new-session-att");
    const attachmentsBySession = new Map<string, ChatAttachment[]>();
    const host = createImmediateCommandHost("/new", attachment);
    host.createChatSession = vi.fn(async () => {
      const previousSessionKey = host.sessionKey;
      const nextSessionKey = "agent:main:new";
      // Session creation captures the next composer before route switching
      // decides whether the old session's attachment needs a memory fallback.
      const createdSessionAttachments = [...host.chatAttachments];
      attachmentsBySession.set(previousSessionKey, [...host.chatAttachments]);
      host.sessionKey = nextSessionKey;
      host.chatAttachments = createdSessionAttachments;
      attachmentsBySession.set(nextSessionKey, [...host.chatAttachments]);
      return true;
    });

    await handleSendChat(host);

    expect(host.createChatSession).toHaveBeenCalledOnce();
    expect(attachmentsBySession.get("agent:main")).toStrictEqual([]);
    expect(attachmentsBySession.get("agent:main:new")).toStrictEqual([]);
    expect(host.chatAttachments).toStrictEqual([]);
  });

  it("restores staged attachments when creating a new session is cancelled", async () => {
    const attachment = createStagedAttachment("cancelled-new-session-att");
    const createChatSession = vi.fn(async () => false);
    const host = createImmediateCommandHost("/new", attachment, { createChatSession });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("/new");
    expect(host.chatAttachments).toHaveLength(1);
    expect(host.chatAttachments[0]).toMatchObject(attachment);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
  });
});
