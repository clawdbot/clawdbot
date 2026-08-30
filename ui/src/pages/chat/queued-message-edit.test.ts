/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { applyChatAgentsList } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  admitQueuedMessageForSession,
  removeQueuedMessageWithoutReleasing,
  subscribeChatOutboxProjection,
  syncVisibleChatQueueProjection,
  updateQueuedMessage,
} from "./chat-queue.ts";
import {
  moveQueuedChatMessage,
  retryQueuedChatMessage,
  steerQueuedChatMessage,
} from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  isQueuedMessageRemovalBlocked,
  isQueuedMessageReorderBlocked,
  isQueuedMessageRetryBlocked,
  QUEUED_MESSAGE_REORDER_CONFLICT_ERROR,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";

const SESSION_KEY = "agent:main:main";
const outboxSubscriptions: Array<() => void> = [];
const stagedAttachments: ChatAttachment[] = [];

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  for (const unsubscribe of outboxSubscriptions.splice(0)) {
    unsubscribe();
  }
  releaseChatAttachmentPayloads(stagedAttachments.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trackOutboxProjection(host: Parameters<typeof subscribeChatOutboxProjection>[0]) {
  const unsubscribe = subscribeChatOutboxProjection(host);
  outboxSubscriptions.push(unsubscribe);
  return unsubscribe;
}

function queueHost(
  items: readonly Partial<ChatQueueItem>[],
  overrides: Parameters<typeof makeChatHost>[0] = {},
) {
  const host = makeChatHost({
    sessionKey: SESSION_KEY,
    connected: false,
    requestHandlers: {},
    ...overrides,
  });
  const unsubscribe = trackOutboxProjection(host as never);
  items.forEach((item, index) => {
    expect(
      admitQueuedMessageForSession(host as never, SESSION_KEY, {
        id: `queued-${index + 1}`,
        text: `message ${index + 1}`,
        createdAt: 1_000 + index,
        sendState: "waiting-reconnect",
        sessionKey: SESSION_KEY,
        ...item,
      }),
    ).toBe(true);
  });
  return { host, unsubscribe };
}

/** The drain reads the stored outbox, so this is the delivery order. */
function storedOrder(host: unknown): string[] {
  return listStoredChatOutboxes(host as never).flatMap(({ queue }) =>
    queue.map((item) => item.text),
  );
}

/** Queue text per owning agent, because an outbox is scoped by session *and* agent. */
function storedOutboxesByAgent(host: unknown): Record<string, string[]> {
  return Object.fromEntries(
    listStoredChatOutboxes(host as never).map((outbox) => [
      outbox.agentId ?? outbox.sessionKey,
      outbox.queue.map((item) => item.text),
    ]),
  );
}

/** An image whose bytes live in the payload store, so releasing it is observable. */
function stageQueuedImage(id: string): ChatAttachment {
  const attachment = registerChatAttachmentPayload({
    attachment: { id, mimeType: "image/png" },
    dataUrl: "data:image/png;base64,cG5n",
    file: new File(["png"], `${id}.png`, { type: "image/png" }),
  });
  stagedAttachments.push(attachment);
  return attachment;
}

/** A full store: any write that would grow it is rejected, exactly as quota does. */
function rejectStoredGrowth(): void {
  const storage = globalThis.sessionStorage;
  const write = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementation((key: string, value: string) => {
    if (value.length > (storage.getItem(key)?.length ?? 0)) {
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    }
    write(key, value);
  });
}

async function submitQueuedEdit(host: ReturnType<typeof makeChatHost>): Promise<void> {
  const edit = host.chatQueuedEdit;
  if (!edit) {
    throw new Error("expected active queued edit");
  }
  await handleSendChat(host as never, edit.draftText, {
    attachmentsOverride: [...edit.attachments],
    resumeQueuedMessageEditId: edit.id,
  });
}

describe("queued message edit round-trip", () => {
  it("keeps the row-local draft and attachments separate from the composer", () => {
    const attachment = { id: "att-1", mimeType: "image/png", dataUrl: "data:image/png;base64,iVB" };
    const { host, unsubscribe } = queueHost([{}, { attachments: [attachment] }, {}]);
    host.chatMessage = "separate composer draft";

    expect(beginQueuedMessageEdit(host as never, "queued-2")).toBe("started");

    expect(host.chatQueuedEdit?.draftText).toBe("message 2");
    expect(host.chatQueuedEdit?.attachments.map((item) => item.id)).toEqual(["att-1"]);
    expect(host.chatMessage).toBe("separate composer draft");
    expect(host.chatAttachments).toEqual([]);
    // The row holds its slot so the operator can see where the edit lands.
    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
    unsubscribe();
  });

  it("leaves the queue untouched when the edit is cancelled", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    host.chatMessage = "separate composer draft";
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "half-typed replacement");

    expect(cancelQueuedMessageEdit(host as never)).toBe(true);

    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(host.chatMessage).toBe("separate composer draft");
    expect(host.chatAttachments).toEqual([]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(false);
    unsubscribe();
  });

  it("leaves composer attachments untouched when an edit is cancelled", () => {
    const original = stageQueuedImage("att-original");
    const added = stageQueuedImage("att-added");
    const { host, unsubscribe } = queueHost([{ attachments: [original] }]);
    host.chatAttachments = [added];
    beginQueuedMessageEdit(host as never, "queued-1");

    expect(cancelQueuedMessageEdit(host as never)).toBe(true);

    expect(storedOrder(host)).toEqual(["message 1"]);
    expect(getChatAttachmentDataUrl(original)).not.toBeNull();
    expect(getChatAttachmentDataUrl(added)).not.toBeNull();
    expect(host.chatAttachments).toEqual([added]);
    unsubscribe();
  });

  it("replaces the row in the same slot when the edited message is sent", async () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");

    await submitQueuedEdit(host);

    expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(false);
    unsubscribe();
  });

  it.each(["/stop", "/compact", "stop"])(
    "keeps the source row and rejects a command-like inline edit: %s",
    async (command) => {
      const sendRequest = vi.fn(() => ({ status: "started" as const }));
      const { host, unsubscribe } = queueHost([{}], {
        chatRunId: "run-active",
        connected: true,
        requestHandlers: { "chat.send": sendRequest },
      });
      beginQueuedMessageEdit(host as never, "queued-1");
      updateQueuedMessageEdit(host as never, command);

      await submitQueuedEdit(host);

      expect(storedOrder(host)).toEqual(["message 1"]);
      expect(host.chatQueuedEdit?.draftText).toBe(command);
      expect(sendRequest).not.toHaveBeenCalled();
      expect(host.chatError).toContain("Queued-row edits cannot run commands or stop aliases");
      unsubscribe();
    },
  );

  it("keeps a composer send separate from an open row edit", async () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "message 1, corrected");
    host.chatMessage = "separate composer send";

    await handleSendChat(host as never);

    expect(storedOrder(host)).toEqual(["message 1", "message 2", "separate composer send"]);
    expect(host.chatQueuedEdit?.draftText).toBe("message 1, corrected");
    unsubscribe();
  });

  it.each(
    [false, true].flatMap((roundTrip) =>
      ["move", "remove"].map((mutation) => ({ roundTrip, mutation })),
    ),
  )(
    "retains a stale edit after peer $mutation (route round trip: $roundTrip)",
    async ({ roundTrip, mutation }) => {
      const { host, unsubscribe } = queueHost([{}, {}]);
      beginQueuedMessageEdit(host as never, "queued-1");
      updateQueuedMessageEdit(host as never, "message 1, corrected");
      const captured = host.chatQueuedEdit?.source;
      if (roundTrip) {
        host.sessionKey = "agent:main:elsewhere";
        expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
      }
      const stalePane = makeChatHost({ connected: false, sessionKey: SESSION_KEY });
      if (mutation === "remove") {
        removeQueuedMessageWithoutReleasing(stalePane as never, "queued-1");
      } else {
        expect(
          updateQueuedMessage(stalePane as never, "queued-1", (item) => ({
            ...item,
            orderKey: (item.orderKey ?? item.createdAt) + 10,
          })),
        ).not.toBeNull();
      }
      const expectedOrder = mutation === "remove" ? ["message 2"] : ["message 2", "message 1"];

      host.sessionKey = SESSION_KEY;
      await submitQueuedEdit(host);

      expect(host.chatQueuedEdit?.source).toBe(captured);
      expect(storedOrder(host)).toEqual(expectedOrder);
      expect(host.chatQueuedEdit?.draftText).toBe("message 1, corrected");
      expect(host.chatError).toBe(OFFLINE_QUEUE_STORAGE_ERROR);
      expect(cancelQueuedMessageEdit(host as never)).toBe(true);
      expect(storedOrder(host)).toEqual(expectedOrder);
      unsubscribe();
    },
  );

  it("aborts a replacement when its edit is cancelled during history loading", async () => {
    const history = createDeferred<{ messages: unknown[] }>();
    const historyRequest = vi.fn(() => history.promise);
    const sendRequest = vi.fn(() => ({ status: "started" as const }));
    const { host, unsubscribe } = queueHost([{}], {
      chatLoading: true,
      connected: true,
      requestHandlers: {
        "chat.history": historyRequest,
        "chat.send": sendRequest,
      },
    });
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "message 1, corrected");

    const send = submitQueuedEdit(host);
    await vi.waitFor(() => expect(historyRequest).toHaveBeenCalledOnce());
    expect(cancelQueuedMessageEdit(host as never)).toBe(true);
    history.resolve({ messages: [] });
    await send;

    expect(storedOrder(host)).toEqual(["message 1"]);
    expect(sendRequest).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("aborts a replacement when its draft changes during history loading", async () => {
    const history = createDeferred<{ messages: unknown[] }>();
    const historyRequest = vi.fn(() => history.promise);
    const sendRequest = vi.fn(() => ({ status: "started" as const }));
    const { host, unsubscribe } = queueHost([{}], {
      chatLoading: true,
      connected: true,
      requestHandlers: {
        "chat.history": historyRequest,
        "chat.send": sendRequest,
      },
    });
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "message 1, corrected");

    const send = submitQueuedEdit(host);
    await vi.waitFor(() => expect(historyRequest).toHaveBeenCalledOnce());
    updateQueuedMessageEdit(host as never, "message 1, changed while loading");
    history.resolve({ messages: [] });
    await send;

    expect(storedOrder(host)).toEqual(["message 1"]);
    expect(host.chatQueuedEdit?.draftText).toBe("message 1, changed while loading");
    expect(sendRequest).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("preserves attachments and reply context on the replacement", async () => {
    const kept = stageQueuedImage("att-kept");
    const { host, unsubscribe } = queueHost([
      {},
      { attachments: [kept], replyToId: "reply-source" },
      {},
    ]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");
    await submitQueuedEdit(host);

    expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
    const replacement = listStoredChatOutboxes(host as never)[0]?.queue[1];
    expect(replacement?.attachments?.map((attachment) => attachment.id)).toEqual(["att-kept"]);
    expect(replacement?.replyToId).toBe("reply-source");
    expect(getChatAttachmentDataUrl(kept)).not.toBeNull();
    unsubscribe();
  });

  it("keeps the original queued when the replacement's stored write is rejected", async () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");
    rejectStoredGrowth();

    await submitQueuedEdit(host);

    // Retiring the original before its replacement is stored would lose both, in
    // the one failure the offline queue exists to survive. The edit stays open on
    // the row that is still there, which is what cancelling already promises.
    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(host.chatQueuedEdit?.draftText).toBe("message 2, corrected");
    expect(host.chatError).toBe(OFFLINE_QUEUE_STORAGE_ERROR);
    unsubscribe();
  });

  it("fences peer remove, reorder, retry, and steer actions while a row edit is open", async () => {
    const original = { id: "queued-1", text: "message 1", createdAt: 1_000 };
    const { host, unsubscribe } = queueHost([original]);
    const sendRequest = vi.fn(() => ({ status: "started" as const }));
    const peer = makeChatHost({
      chatQueue: [original],
      chatRunId: "run-active",
      connected: true,
      requestHandlers: { "chat.send": sendRequest },
      sessionKey: SESSION_KEY,
    });
    const stopPeer = trackOutboxProjection(peer as never);

    try {
      beginQueuedMessageEdit(host as never, original.id);

      expect(isQueuedMessageBeingEdited(peer as never, original.id)).toBe(true);
      expect(isQueuedMessageRemovalBlocked(peer as never, original.id)).toBe(true);
      expect(isQueuedMessageReorderBlocked(peer as never, original.id)).toBe(true);
      expect(isQueuedMessageRetryBlocked(peer as never, original.id)).toBe(true);
      expect(moveQueuedChatMessage(peer as never, original.id, 0)).toBe("rejected");
      await retryQueuedChatMessage(peer as never, original.id);
      await steerQueuedChatMessage(peer as never, original.id);
      expect(sendRequest).not.toHaveBeenCalled();
      expect(storedOrder(peer)).toEqual(["message 1"]);
    } finally {
      stopPeer();
      unsubscribe();
    }
  });

  it("reports when a peer reorder crosses the row another pane is editing", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    const peer = makeChatHost({
      client: host.client,
      connected: false,
      sessionKey: SESSION_KEY,
    });
    const stopPeer = trackOutboxProjection(peer as never);

    try {
      beginQueuedMessageEdit(host as never, "queued-2");

      expect(moveQueuedChatMessage(peer as never, "queued-3", 0)).toBe("rejected");
      expect(peer.chatError).toBe(QUEUED_MESSAGE_REORDER_CONFLICT_ERROR);
      expect(storedOrder(peer)).toEqual(["message 1", "message 2", "message 3"]);
    } finally {
      stopPeer();
      unsubscribe();
    }
  });

  it("translates peer reorder indices within one side of an edited-row barrier", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}, {}]);
    const peer = makeChatHost({
      client: host.client,
      connected: false,
      sessionKey: SESSION_KEY,
    });
    const stopPeer = trackOutboxProjection(peer as never);

    try {
      beginQueuedMessageEdit(host as never, "queued-2");

      expect(moveQueuedChatMessage(peer as never, "queued-4", 2)).toBe("moved");
      expect(storedOrder(peer)).toEqual(["message 1", "message 2", "message 4", "message 3"]);
    } finally {
      stopPeer();
      unsubscribe();
    }
  });

  it("keeps local reorder indices within one side of its own edited-row barrier", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}, {}]);

    try {
      beginQueuedMessageEdit(host as never, "queued-2");

      expect(moveQueuedChatMessage(host as never, "queued-4", 0)).toBe("moved");
      expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 4", "message 3"]);
    } finally {
      unsubscribe();
    }
  });

  it("does not collapse same-payload row and composer sends", async () => {
    const ack = createDeferred<{ status: "started" }>();
    const sendRequest = vi.fn(() => ack.promise);
    const { host, unsubscribe } = queueHost([{}], {
      connected: true,
      requestHandlers: { "chat.send": sendRequest },
    });
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "same payload");

    const rowSend = submitQueuedEdit(host);
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce());
    host.chatMessage = "same payload";
    const composerSend = handleSendChat(host as never);
    await vi.waitFor(() => expect(host.chatMessage).toBe(""));
    expect(host.chatQueue.map((item) => item.text)).toContain("same payload");

    ack.resolve({ status: "started" });
    await Promise.all([rowSend, composerSend]);
    unsubscribe();
  });

  it("cannot retire a row in the outbox a global agent switch left behind", async () => {
    const host = makeChatHost({ assistantAgentId: "lily", connected: false, sessionKey: "global" });
    const unsubscribe = trackOutboxProjection(host as never);
    expect(
      admitQueuedMessageForSession(host as never, "global", {
        id: "queued-1",
        text: "message 1",
        agentId: "lily",
        createdAt: 1_000,
        sendState: "waiting-reconnect",
        sessionKey: "global",
      }),
    ).toBe(true);
    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("started");

    // A raw global session keeps its key across agent switches, so the session key
    // alone cannot tell the two outboxes apart.
    host.assistantAgentId = "nova";
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);

    host.chatMessage = "message 1, corrected";
    await handleSendChat(host as never);

    expect(storedOutboxesByAgent(host)).toEqual({
      lily: ["message 1"],
      nova: ["message 1, corrected"],
    });
    unsubscribe();
  });

  it("starts a row edit while the composer holds a separate message", () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    host.chatMessage = "typing something else";

    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("started");

    expect(storedOrder(host)).toEqual(["message 1", "message 2"]);
    expect(host.chatMessage).toBe("typing something else");
    unsubscribe();
  });

  it("edits one row at a time and rejects a submit naming another row", async () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    beginQueuedMessageEdit(host as never, "queued-1");

    expect(beginQueuedMessageEdit(host as never, "queued-2")).toBe("unavailable");
    await handleSendChat(host as never, "wrong replacement", {
      resumeQueuedMessageEditId: "queued-2",
    });
    expect(storedOrder(host)).toEqual(["message 1", "message 2"]);
    expect(host.chatQueuedEdit?.id).toBe("queued-1");
    unsubscribe();
  });

  it.each([
    { label: "a local command", overrides: { localCommandName: "compact" } },
    { label: "a delivery-uncertain row", overrides: { sendState: "unconfirmed" as const } },
  ])("refuses to edit $label", ({ overrides }) => {
    const { host, unsubscribe } = queueHost([overrides]);

    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("unavailable");
    unsubscribe();
  });

  it.each([false, true])(
    "keeps captured edit custody when main defaults change: %s",
    async (changeMainKey) => {
      const agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      } satisfies AgentsListResult;
      const send = vi.fn(async () => ({ status: "started" }));
      const { host, unsubscribe } = queueHost([{}], {
        connected: true,
        agentsList,
        requestHandlers: { "chat.send": send },
      });
      const container = document.createElement("div");
      try {
        expect(beginQueuedMessageEdit(host, "queued-1")).toBe("started");
        expect(updateQueuedMessageEdit(host, "Unsaved original correction")).toBe(true);
        const captured = host.chatQueuedEdit!;
        const originalOutboxes = listStoredChatOutboxes(host);
        if (changeMainKey) {
          applyChatAgentsList(host, { ...agentsList, mainKey: "current" }, host.client!);
        }
        host.sessionKey = "agent:main:current";
        syncVisibleChatQueueProjection(host);
        expect(host.chatQueue).toEqual([]);
        const active = activeQueuedMessageEdit(host);
        render(
          renderChatComposer(
            createComposerProps({
              queue: host.chatQueue,
              sessionKey: host.sessionKey,
              queuedEdit: {
                editingId: active?.id ?? null,
                editingText: active?.draftText,
                source: active?.source,
                onCancel: () => cancelQueuedMessageEdit(host),
              },
            }),
          ),
          container,
        );
        await submitQueuedEdit(host);
        expect(send).not.toHaveBeenCalled();
        expect(listStoredChatOutboxes(host)).toEqual(originalOutboxes);
        expect(host.chatQueuedEdit).toBe(captured);
        expect.soft(active).toBeNull();
        expect.soft(container.querySelector(".chat-queue__edit-input")).toBeNull();
        expect.soft(cancelQueuedMessageEdit(host)).toBe(false);
        expect.soft(host.chatQueuedEdit).toBe(captured);
        // Returning the real routing facts restores the original owner, not a renamed token.
        applyChatAgentsList(host, agentsList, host.client!);
        host.sessionKey = SESSION_KEY;
        syncVisibleChatQueueProjection(host);
        expect(activeQueuedMessageEdit(host)?.draftText).toBe("Unsaved original correction");
        expect(cancelQueuedMessageEdit(host)).toBe(true);
        expect(listStoredChatOutboxes(host)).toEqual(originalOutboxes);
      } finally {
        render(null, container);
        unsubscribe();
        await resetComposerFixture();
      }
    },
  );

  it("leaves the edit behind when the pane routes to another session", () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    beginQueuedMessageEdit(host as never, "queued-1");

    host.sessionKey = "agent:other";

    // Neither the badge nor the drain block may follow the operator elsewhere,
    // and the stale edit must not lock the composer in the new session either.
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
    expect(cancelQueuedMessageEdit(host as never)).toBe(false);
    unsubscribe();
  });
});
