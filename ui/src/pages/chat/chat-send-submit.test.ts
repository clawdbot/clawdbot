// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";

const attachmentsToRelease: ChatAttachment[] = [];
const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(async () => {
  releaseChatAttachmentPayloads(attachmentsToRelease);
  attachmentsToRelease.length = 0;
  await Promise.resolve();
  vi.unstubAllGlobals();
});

function createBrowserAnnotationAttachment(id: string, modelContext: string): ChatAttachment {
  return {
    id,
    dataUrl: "data:image/png;base64,aQ==",
    mimeType: "image/png",
    browserAnnotation: {
      modelContext,
      title: `Page ${id}`,
      displayUrl: `https://example.com/${id}`,
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function findChatSendPayload(host: {
  request: { mock: { calls: ReadonlyArray<readonly [string, unknown?]> } };
}): Record<string, unknown> {
  const call = host.request.mock.calls.find(([method]) => method === "chat.send");
  if (!call?.[1] || typeof call[1] !== "object") {
    throw new Error("Expected chat.send payload");
  }
  return call[1] as Record<string, unknown>;
}

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

describe("composeBrowserAnnotationContext", () => {
  it("materializes an annotation-only message", () => {
    const attachment = createBrowserAnnotationAttachment("only", "Inspect the marked region.");

    expect(composeBrowserAnnotationContext("", [attachment])).toBe("Inspect the marked region.");
  });

  it("prepends annotation context to the user's draft", () => {
    const attachment = createBrowserAnnotationAttachment("mixed", "Browser context");

    expect(composeBrowserAnnotationContext("Please fix this", [attachment])).toBe(
      "Browser context\n\nPlease fix this",
    );
  });

  it("preserves attachment order across two annotations", () => {
    const first = createBrowserAnnotationAttachment("first", "First context");
    const second = createBrowserAnnotationAttachment("second", "Second context");

    expect(composeBrowserAnnotationContext("Compare them", [first, second])).toBe(
      "First context\n\nSecond context\n\nCompare them",
    );
  });

  it("omits context for an annotation removed before submit", () => {
    const removed = createBrowserAnnotationAttachment("removed", "Removed context");
    const remaining = createBrowserAnnotationAttachment("remaining", "Remaining context");
    const attachments = [removed, remaining];
    attachments.splice(0, 1);

    expect(composeBrowserAnnotationContext("Continue", attachments)).toBe(
      "Remaining context\n\nContinue",
    );
  });
});

describe("handleSendChat browser annotation context", () => {
  it("sends an annotation without requiring user-authored text", async () => {
    const attachment = createBrowserAnnotationAttachment("annotation-only", "Inspect this page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-only-run", status: "started" } },
      chatAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Inspect this page");
  });

  it("routes /new before materializing annotation context", async () => {
    const attachment = createBrowserAnnotationAttachment("slash", "Review the annotated page");
    const createChatSession = vi.fn(async () => true);
    const host = makeChatHost({
      requestHandlers: {},
      chatAttachments: [attachment],
      chatMessage: "/new",
      createChatSession,
    });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it.each(["/stop", "stop", "esc", "abort", "wait", "exit"])(
    "routes active-run stop intent %s before materializing annotation context",
    async (command) => {
      const attachment = createBrowserAnnotationAttachment("stop", "Review the annotated page");
      const host = makeChatHost({
        requestHandlers: { "chat.abort": { aborted: true } },
        chatAttachments: [attachment],
        chatMessage: command,
        chatRunId: "annotation-stop-run",
      });

      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith("chat.abort", {
        runId: "annotation-stop-run",
        sessionKey: "agent:main",
      });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    },
  );

  it.each(["/side", "/btw"])(
    "opens annotated companion intent %s without sending annotation context",
    async (command) => {
      const attachment = createBrowserAnnotationAttachment("companion", "Review the page");
      const openSessionCompanion = vi.fn();
      const host = makeChatHost({
        requestHandlers: {},
        chatAttachments: [attachment],
        chatMessage: `${command} explain this`,
        openSessionCompanion,
      });

      await handleSendChat(host);

      expect(openSessionCompanion).toHaveBeenCalledWith("explain this");
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    },
  );

  it("keeps annotation context on natural stop words when no run is active", async () => {
    const attachment = createBrowserAnnotationAttachment("idle-stop", "Review the page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-idle-run", status: "started" } },
      chatAttachments: [attachment],
      chatMessage: "wait",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Review the page\n\nwait");
    expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
  });

  it("preserves annotations across remote commands until the next actual model prompt", async () => {
    const annotation = createBrowserAnnotationAttachment("remote", "Review the annotated page");
    const document = createStagedAttachment("remote-document");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-command-run", status: "ok" } },
      chatAttachments: [annotation, document],
      chatMessage: "/status",
    });

    await handleSendChat(host);

    const command = findChatSendPayload(host);
    expect(command.message).toBe("/status");
    expect(command.attachments).toEqual([
      expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
    ]);
    expect(host.chatAttachments).toEqual([annotation]);
    expect(host.chatQueue).toEqual([]);

    host.request.mockClear();
    host.chatMessage = "Explain the highlighted issue";
    await handleSendChat(host);

    const modelPrompt = findChatSendPayload(host);
    expect(modelPrompt.message).toBe("Review the annotated page\n\nExplain the highlighted issue");
    expect(modelPrompt.attachments).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    expect(host.chatAttachments).toEqual([]);
  });

  it("retains annotations while forwarding an active-run approval with its ordinary file", async () => {
    const annotation = createBrowserAnnotationAttachment("approval", "Review the annotated page");
    const document = createStagedAttachment("approval-document");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "approval-command-run", status: "started" } },
      chatAttachments: [annotation, document],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    await handleSendChat(host);

    const command = findChatSendPayload(host);
    expect(command.message).toBe("/approve approval-123 allow-once");
    expect(command.attachments).toEqual([
      expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
    ]);
    expect(host.chatAttachments).toEqual([annotation]);
    expect(host.chatMessage).toBe("");
  });

  it("restores the command draft and mixed attachments when a remote command fails", async () => {
    const annotation = createBrowserAnnotationAttachment("failed-status", "Review the page");
    const document = createStagedAttachment("failed-status-document");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "failed-status-run", status: "error" } },
      chatAttachments: [annotation, document],
      chatMessage: "/status",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).attachments).toEqual([
      expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
    ]);
    expect(host.chatMessage).toBe("/status");
    expect(host.chatAttachments).toMatchObject([
      {
        id: annotation.id,
        browserAnnotation: annotation.browserAnnotation,
        dataUrl: annotation.dataUrl,
      },
      { id: document.id, fileName: "brief.pdf", dataUrl: attachmentDataUrl },
    ]);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(annotation.dataUrl);
    expect(getChatAttachmentDataUrl(host.chatAttachments[1]!)).toBe(attachmentDataUrl);
  });

  it("restores the command draft and mixed attachments when an approval fails", async () => {
    const annotation = createBrowserAnnotationAttachment("failed-approval", "Review the page");
    const document = createStagedAttachment("failed-approval-document");
    const command = "/approve approval-123 allow-once";
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "failed-approval-run", status: "error" } },
      chatAttachments: [annotation, document],
      chatMessage: command,
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).attachments).toEqual([
      expect.objectContaining({ fileName: "brief.pdf", mimeType: "application/pdf" }),
    ]);
    expect(host.chatMessage).toBe(command);
    expect(host.chatAttachments).toMatchObject([
      {
        id: annotation.id,
        browserAnnotation: annotation.browserAnnotation,
        dataUrl: annotation.dataUrl,
      },
      { id: document.id, fileName: "brief.pdf", dataUrl: attachmentDataUrl },
    ]);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(annotation.dataUrl);
    expect(getChatAttachmentDataUrl(host.chatAttachments[1]!)).toBe(attachmentDataUrl);
  });

  it("never restores over a replacement annotation that reuses the submitted attachment ID", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "error" }>();
    const annotation = createBrowserAnnotationAttachment("reused-annotation", "Original page");
    const replacement = {
      ...annotation,
      dataUrl: "data:image/png;base64,bmV3",
      browserAnnotation: {
        ...annotation.browserAnnotation!,
        modelContext: "Replacement page",
      },
    };
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => acknowledgment.promise },
      chatAttachments: [annotation],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledOnce());
    expect(host.chatMessage).toBe("");
    host.chatAttachments = [replacement];
    acknowledgment.resolve({ runId: "failed-approval-run", status: "error" });
    await send;

    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([replacement]);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(replacement.dataUrl);
  });

  it("never restores a failed approval over a newer composer attachment", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "error" }>();
    const annotation = createBrowserAnnotationAttachment("stale-approval", "Review the page");
    const replacement = createBrowserAnnotationAttachment("replacement", "Review the newer page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => acknowledgment.promise },
      chatAttachments: [annotation],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "active-run",
      chatStream: "Waiting for approval...",
    });

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledOnce());
    host.chatMessage = "Newer operator draft";
    host.chatAttachments = [replacement];
    acknowledgment.resolve({ runId: "failed-approval-run", status: "error" });
    await send;

    expect(host.chatMessage).toBe("Newer operator draft");
    expect(host.chatAttachments).toEqual([replacement]);
  });

  it("materializes annotation context for unrecognized slash-prefixed input", async () => {
    const attachment = createBrowserAnnotationAttachment("unknown", "Review the annotated page");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { runId: "annotation-model-run", status: "started" } },
      chatAttachments: [attachment],
      chatMessage: "/review-this",
    });

    await handleSendChat(host);

    expect(findChatSendPayload(host).message).toBe("Review the annotated page\n\n/review-this");
  });

  it("keeps one materialized snapshot through delayed failed delivery", async () => {
    const settingsPatch = createDeferred<boolean>();
    const attachment = createBrowserAnnotationAttachment("delayed", "Stable browser context");
    const replacement = createBrowserAnnotationAttachment("replacement", "New browser context");
    const host = makeChatHost({
      requestHandlers: { "chat.send": { status: "timeout" } },
      chatAttachments: [attachment],
      chatMessage: "Use the marked area",
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(host.chatQueue[0]?.text).toBe("Stable browser context\n\nUse the marked area");

    host.chatMessage = "New draft";
    host.chatAttachments = [replacement];
    settingsPatch.resolve(true);
    await send;

    expect(findChatSendPayload(host).message).toBe("Stable browser context\n\nUse the marked area");
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "failed",
      text: "Stable browser context\n\nUse the marked area",
    });
    expect(host.chatMessage).toBe("New draft");
    expect(host.chatAttachments).toEqual([replacement]);
    expect(host.chatLocalInputHistoryBySession[host.sessionKey]?.[0]?.text).toBe(
      "Use the marked area",
    );
  });
});

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

describe("handleSendChat session ownership", () => {
  it("keeps the composer intact when no visible session owns the send", async () => {
    const attachment = createStagedAttachment("unscoped-att");
    const request = vi.fn();
    const host = createImmediateCommandHost("keep this draft", attachment, {
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "",
      chatReplyTarget: {
        messageId: "reply-1",
        sourceMessageId: "source-1",
        text: "original message",
      },
    });

    await handleSendChat(host);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    expect(host.chatReplyTarget).toEqual({
      messageId: "reply-1",
      sourceMessageId: "source-1",
      text: "original message",
    });
    expect(host.chatQueue).toEqual([]);
    expect(host.lastError).toBe("The active session is unavailable; refresh and try again.");
    expect(host.chatError).toBe(host.lastError);
  });
});
