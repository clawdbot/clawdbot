// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  captureChatOutboxAdmission,
  readStoredOutboxStore,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { syncVisibleChatQueueProjection } from "./chat-queue.ts";
import { retryQueuedChatMessage, retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";

const attachmentsToRelease: ChatAttachment[] = [];
const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(async () => {
  releaseChatAttachmentPayloads(attachmentsToRelease);
  attachmentsToRelease.length = 0;
  await Promise.resolve();
  vi.restoreAllMocks();
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

describe("structured Goal admission", () => {
  const intent = { kind: "session-goal-start", version: 1, issuedAtMs: 1_788_000_000_000 } as const;

  it.each(["pause the rollout", "/stop", "  /goal clear\nkeep   this literal  "])(
    "sends %j as an objective without command interpretation",
    async (objective) => {
      const host = makeChatHost({
        chatMessage: objective,
        currentSessionId: "incarnation-a",
        chatDisplayedLeafEntryId: "leaf-a",
        requestHandlers: { "chat.send": { status: "started" } },
      });
      await handleSendChat(host, undefined, { intent });
      expect(findChatSendPayload(host)).toMatchObject({
        message: objective,
        intent,
        sessionId: "incarnation-a",
        expectedLeafEntryId: "leaf-a",
      });
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
      expect(host.request.mock.calls.some(([method]) => method === "chat.abort")).toBe(false);
      expect(host.chatMessage).toBe("");
    },
  );

  it.each(["busy", "offline", "annotation"])(
    "preserves the complete draft when %s prevents Goal admission",
    async (reason) => {
      const attachment =
        reason === "annotation"
          ? createBrowserAnnotationAttachment(
              "goal-annotation",
              "Do not append this to the objective",
            )
          : createStagedAttachment(`goal-${reason}`);
      const host = makeChatHost({
        chatMessage: "Keep this objective",
        chatAttachments: [attachment],
        connected: reason !== "offline",
        chatRunId: reason === "busy" ? "existing-run" : null,
        requestHandlers: {},
      });
      await handleSendChat(host, undefined, { intent });
      expect(host.chatMessage).toBe("Keep this objective");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(host.request).not.toHaveBeenCalled();
      expect(host.lastError).toBeTruthy();
    },
  );

  it("keeps attachments and transcript replies separate from the objective", async () => {
    const attachment = createStagedAttachment("goal-document");
    const host = makeChatHost({
      chatMessage: "Review the attached brief",
      chatAttachments: [attachment],
      chatReplyTarget: {
        messageId: "message-a",
        sourceMessageId: "entry-a",
        text: "Earlier question",
      },
      requestHandlers: { "chat.send": { status: "started" } },
    });
    await handleSendChat(host, undefined, { intent });
    expect(findChatSendPayload(host)).toMatchObject({
      message: "Review the attached brief",
      replyToId: "entry-a",
      intent,
      attachments: [expect.objectContaining({ mimeType: "application/pdf" })],
    });
  });

  it("restores a rejected objective and retains the original run identity on a stored Retry", async () => {
    let reject = true;
    const host = makeChatHost({
      chatMessage: "Start this exactly once",
      currentSessionId: "incarnation-a",
      chatDisplayedLeafEntryId: "leaf-a",
      requestHandlers: {
        "chat.send": () => {
          if (reject) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Goal admission rejected",
            });
          }
          return { status: "started" };
        },
      },
    });
    await handleSendChat(host, undefined, { intent });
    expect(host.chatMessage).toBe("Start this exactly once");

    // Restored outboxes retry an already minted request; they must not mint another run.
    reject = false;
    host.chatMessage = "A separate conversation draft";
    const original = findChatSendPayload(host);
    const queued = {
      id: "goal-retry",
      text: "Start this exactly once",
      createdAt: Date.now(),
      intent,
      sessionId: "incarnation-a",
      expectedLeafEntryId: "leaf-a",
      sendRunId: String(original.idempotencyKey),
      sendState: "failed" as const,
      sessionKey: host.sessionKey,
    };
    // The same browser persistence owner used on reconnect restores this immutable row.
    const { admitQueuedMessageForSession } = await import("./chat-queue.ts");
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, host.sessionKey), queued),
    ).toBe(true);
    host.currentSessionId = "incarnation-b";
    host.chatDisplayedLeafEntryId = "leaf-b";
    await retryQueuedChatMessage(host, queued.id);
    const requests = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.[1]).toEqual(original);
    expect(host.chatMessage).toBe("A separate conversation draft");
  });
});

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

    vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
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

      vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
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

    vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
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
    await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
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
    "shows an empty export outcome and preserves staged attachments for %s",
    async (command) => {
      const attachment = createStagedAttachment("export-att");
      const exportCurrentChat = vi.fn(() => "empty" as const);
      const afterCommit = vi.fn(() => () => undefined);
      const host = createImmediateCommandHost(command, attachment, {
        exportCurrentChat,
        renderLifecycle: { invalidate: vi.fn(), afterCommit },
      });

      await handleSendChat(host);

      expect(exportCurrentChat).toHaveBeenCalledOnce();
      expect(host.chatMessages).toEqual([
        expect.objectContaining({
          role: "system",
          content: "There are no messages to export yet.",
        }),
      ]);
      expect(afterCommit).toHaveBeenCalledOnce();
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
  it.each(
    [false, true].flatMap((pendingHistory) =>
      [false, true].map((structured) => ({ pendingHistory, structured })),
    ),
  )(
    "retires the previous run error after local retry (pending history: $pendingHistory, structured: $structured)",
    async ({ pendingHistory, structured }) => {
      const failed: ChatHistoryResult = {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "run-first",
          lastRunError: "Earlier preparation failed. Retry after repairing the workspace.",
        },
      };
      const refresh = createDeferred<ChatHistoryResult>();
      const history = vi.fn().mockResolvedValueOnce(failed).mockReturnValue(refresh.promise);
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "Try again",
        requestHandlers: {
          "chat.history": history,
          "chat.send": { status: "started" },
        },
      });
      await loadChatHistory(host);
      expect(host.chatRunError?.summary).toContain(failed.sessionInfo!.lastRunError);
      const diagnostic = getChatSessionProjection(host, host.chatMessages).runs["run-first"];
      const loading = pendingHistory ? loadChatHistory(host) : undefined;
      try {
        const sending = handleSendChat(
          host,
          undefined,
          structured
            ? { intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() } }
            : undefined,
        );
        if (!structured) {
          expect(host.chatRunError).toBeNull();
        }
        if (pendingHistory) {
          expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
          refresh.resolve(failed);
          await loading;
        }
        await sending;
        const runId = String(findChatSendPayload(host).idempotencyKey);
        expect(host.chatRunId).toBe(runId);
        handleChatGatewayEvent(host, {
          sessionKey: "main",
          runId,
          state: "final",
          message: { role: "assistant", content: "Recovery completed." },
        });

        expect(host.chatMessages.at(-1)).toMatchObject({ content: "Recovery completed." });
        expect(host.chatRunStatus).toMatchObject({ phase: "done", runId });
        expect(host.chatRunId).toBeNull();
        expect(host.lastError).toBeNull();
        expect(getChatSessionProjection(host, host.chatMessages).runs["run-first"]).toEqual(
          diagnostic,
        );
        expect(host.chatRunError).toBeNull();
      } finally {
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each(["live", "history"] as const)(
    "does not let an ACK resurrect a run or clear its %s terminal diagnostic",
    async (source) => {
      const ack = createDeferred<{ status: "started" }>();
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "Try once",
        requestHandlers: { "chat.send": () => ack.promise },
      });
      const sending = handleSendChat(host);
      try {
        await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
        const runId = String(findChatSendPayload(host).idempotencyKey);
        const error = "This run failed before its ACK arrived";
        if (source === "live") {
          handleChatGatewayEvent(host, {
            sessionKey: "main",
            runId,
            state: "error",
            errorMessage: error,
          });
        } else {
          host.request.mockImplementationOnce(async () => ({
            messages: [],
            sessionInfo: {
              key: "main",
              kind: "direct",
              updatedAt: 1,
              status: "failed",
              hasActiveRun: false,
              lastRunId: runId,
              lastRunError: error,
            },
          }));
          await loadChatHistory(host, { deferBranches: true });
        }
        const diagnostic = host.chatRunError;
        expect(diagnostic?.summary).toContain(error);
        ack.resolve({ status: "started" });
        await sending;
        expect(host.chatRunId).toBeNull();
        expect(host.chatRunError).toEqual(diagnostic);
      } finally {
        ack.resolve({ status: "started" });
        await sending;
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each(["done", "failed"] as const)(
    "does not apply older %s history over a pending send",
    async (status) => {
      const ack = createDeferred<{ status: "started" }>();
      const host = makeChatHost({
        sessionKey: "main",
        chatMessage: "A new turn",
        requestHandlers: {
          "chat.send": () => ack.promise,
          "chat.history": {
            messages: [],
            sessionInfo: {
              key: "main",
              kind: "direct",
              updatedAt: 1,
              status,
              hasActiveRun: false,
              lastRunId: "old-run",
              ...(status === "failed" ? { lastRunError: "Old failure" } : {}),
            },
          },
        },
      });
      const sending = handleSendChat(host);
      try {
        await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
        await loadChatHistory(host);
        expect(host.chatRunId).toBeNull();
        expect(host.chatRunError).toBeNull();
        expect(getChatSessionProjection(host, host.chatMessages).runs["old-run"]).toBeUndefined();
      } finally {
        ack.resolve({ status: "started" });
        await sending;
        reconcileChatRunLifecycle(host, { clearRunStatus: true });
      }
    },
  );

  it.each(["later turn", ""])(
    "retains %j and attachments until account recovery is ready",
    async (message) => {
      const attachment = createStagedAttachment("cold-att");
      const host = makeChatHost({
        chatMessage: message,
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status: "started" } },
        hasPendingInitialTurn: () => false,
      });
      const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
      await handleSendChat(host);
      expect(host.chatMessage).toBe(message);
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatError).toContain("connection");
      readiness.mockReturnValue(true);
      await handleSendChat(host);
      expect(findChatSendPayload(host)).toMatchObject({
        message,
        attachments: [expect.objectContaining({ fileName: "brief.pdf" })],
      });
    },
  );

  it("holds an offline queue through cold recovery and an awaited history read", async () => {
    const history = createDeferred<unknown>();
    let pending = false;
    const host = makeChatHost({
      connected: false,
      chatMessage: "offline later turn",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
      },
      hasPendingInitialTurn: () => pending,
    });
    const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get").mockReturnValue(false);
    await handleSendChat(host);
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toMatchObject([{ text: "offline later turn", sendAttempts: 0 }]);
    const originalId = host.chatQueue[0]!.sendRunId;
    host.connected = true;
    readiness.mockReturnValue(true);
    const drain = retryReconnectableQueuedChatSends(host);
    const loading = loadChatHistory(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    readiness.mockReturnValue(false);
    history.resolve({
      messages: [],
      sessionInfo: {
        key: host.sessionKey,
        hasActiveRun: false,
        status: "failed",
        lastRunId: "previous-run",
        lastRunError: "Earlier preparation failed",
      },
    });
    await drain;
    await loading;
    expect(host.chatRunError?.summary).toContain("Earlier preparation failed");
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toMatchObject([
      { text: "offline later turn", sendAttempts: 0, sendRunId: originalId },
    ]);
    pending = true;
    readiness.mockReturnValue(true);
    await retryReconnectableQueuedChatSends(host);
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    pending = false;
    await retryReconnectableQueuedChatSends(host);
    expect(host.chatRunError).toBeNull();
    expect(findChatSendPayload(host)).toMatchObject({
      message: "offline later turn",
      idempotencyKey: originalId,
    });
  });

  it.each(["initial-turn", "recovery-scope"])(
    "rechecks %s after settings settle without sending an admitted later turn",
    async (hold) => {
      const settingsPatch = createDeferred<boolean>();
      let pending = false;
      const attachment = createStagedAttachment("waiting-att");
      const host = makeChatHost({
        chatMessage: "later turn",
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status: "started" } },
        pendingSettingsPatches: { "agent:main": settingsPatch.promise },
        hasPendingInitialTurn: () => pending,
      });
      const send = handleSendChat(host);
      await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
      const original = host.chatQueue[0]!;
      const readiness = vi.spyOn(host.client!, "recoveryScopeReady", "get");
      if (hold === "initial-turn") {
        pending = true;
      } else {
        readiness.mockReturnValue(false);
      }
      host.chatMessage = "newer draft";
      settingsPatch.resolve(true);
      await send;
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      // A connected unresolved owner cannot finish a Blob row's settings write.
      // The stored interrupted-settings state remains paused until explicit retry.
      const sendState = hold === "recovery-scope" ? "failed" : "waiting-idle";
      const retained = Object.values(
        readStoredOutboxStore(sessionStorage, storageTargetForGateway(host.settings?.gatewayUrl))
          .sessions,
      ).flatMap((session) => session.queue ?? []);
      expect(retained).toMatchObject([
        {
          id: original.id,
          sendRunId: original.sendRunId,
          attachmentPayload: original.attachmentPayload,
          text: "later turn",
          sendAttempts: 0,
          sendState,
        },
      ]);
      if (hold === "recovery-scope") {
        expect(retained[0]?.sendError).toBe(
          "Chat settings update was interrupted. Review and retry when ready.",
        );
        expect(host.chatQueue).toEqual([]);
        readiness.mockReturnValue(true);
        syncVisibleChatQueueProjection(host);
      }
      expect(host.chatQueue).toMatchObject([
        { id: original.id, text: "later turn", sendAttempts: 0, sendState },
      ]);
      expect(host.chatMessage).toBe("newer draft");
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    },
  );

  it.each([true, false])(
    "retains later text and attachments behind an initial turn (connected: %s)",
    async (connected) => {
      const attachment = createStagedAttachment("held-att");
      const host = makeChatHost({
        connected,
        chatMessage: "keep this later draft",
        chatAttachments: [attachment],
        requestHandlers: { "chat.send": { status: "started" } },
        hasPendingInitialTurn: () => true,
      });
      await handleSendChat(host);
      expect(host.chatMessage).toBe("keep this later draft");
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
      expect(host.chatQueue).toEqual([]);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatError).toContain("initial message");
    },
  );

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
