/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession, subscribeChatOutboxProjection } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import {
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./steer-lifecycle.ts";

const SESSION_KEY = "agent:main";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(
  items: readonly Partial<ChatQueueItem>[],
  overrides: Parameters<typeof makeChatHost>[0] = {},
) {
  const host = makeChatHost({ sessionKey: SESSION_KEY, connected: false, ...overrides });
  const unsubscribe = subscribeChatOutboxProjection(host as never);
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
  return registerChatAttachmentPayload({
    attachment: { id, mimeType: "image/png" },
    dataUrl: `data:image/png;base64,iVB${id}`,
    file: new File(["png"], `${id}.png`, { type: "image/png" }),
  });
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

describe("queued message edit round-trip", () => {
  it("keeps the row in place and owns the draft outside the composer", () => {
    const attachment = { id: "att-1", mimeType: "image/png", dataUrl: "data:image/png;base64,iVB" };
    const { host, unsubscribe } = queueHost([{}, { attachments: [attachment] }, {}]);
    host.chatMessage = "a separate composer draft";

    expect(beginQueuedMessageEdit(host as never, "queued-2")).toBe("started");

    expect(host.chatMessage).toBe("a separate composer draft");
    expect(host.chatAttachments).toEqual([]);
    expect(host.chatQueuedEdit?.draftText).toBe("message 2");
    expect(host.chatQueuedEdit?.attachments.map((item) => item.id)).toEqual(["att-1"]);
    // The row holds its slot so the operator can see where the edit lands.
    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
    unsubscribe();
  });

  it("leaves the current composer untouched when the edit is cancelled", () => {
    const original = stageQueuedImage("att-original");
    const added = stageQueuedImage("att-added");
    const { host, unsubscribe } = queueHost([{ attachments: [original] }, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-1");
    host.chatMessage = "a separate composer draft";
    host.chatAttachments = [original, added];

    expect(cancelQueuedMessageEdit(host as never)).toBe(true);

    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(host.chatMessage).toBe("a separate composer draft");
    expect(host.chatAttachments).toHaveLength(2);
    expect(host.chatAttachments[0]?.id).toBe(original.id);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0] as ChatAttachment)).not.toBeNull();
    expect(host.chatAttachments[1]?.id).toBe(added.id);
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
    unsubscribe();
  });

  it("replaces the row in the same slot when the edited message is sent", async () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");
    const edit = host.chatQueuedEdit!;

    await handleSendChat(host as never, edit.draftText, {
      attachmentsOverride: [...edit.attachments],
      resumeQueuedMessageEditId: edit.id,
    });

    expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(false);
    unsubscribe();
  });

  it("rejects a stale second-pane replacement after the source is retired", async () => {
    const paneA = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
    const paneB = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
    const unsubscribeA = subscribeChatOutboxProjection(paneA as never);
    let unsubscribeB = subscribeChatOutboxProjection(paneB as never);
    expect(
      admitQueuedMessageForSession(paneA as never, SESSION_KEY, {
        id: "queued-1",
        text: "message 1",
        createdAt: 1_000,
        sendState: "waiting-reconnect",
        sessionKey: SESSION_KEY,
      }),
    ).toBe(true);

    // Model a pane that captured the edit before it was detached from the shared owner.
    expect(beginQueuedMessageEdit(paneB as never, "queued-1")).toBe("started");
    unsubscribeB();

    expect(beginQueuedMessageEdit(paneA as never, "queued-1")).toBe("started");
    updateQueuedMessageEdit(paneA as never, "message 1, corrected");
    await handleSendChat(paneA as never, "message 1, corrected", {
      attachmentsOverride: [],
      resumeQueuedMessageEditId: "queued-1",
    });

    unsubscribeB = subscribeChatOutboxProjection(paneB as never);
    expect(beginQueuedMessageEdit(paneB as never, "queued-1")).toBe("unavailable");
    await handleSendChat(paneB as never, "message 1, corrected", {
      attachmentsOverride: [],
      resumeQueuedMessageEditId: "queued-1",
    });

    expect(storedOrder(paneA)).toEqual(["message 1, corrected"]);
    expect(listStoredChatOutboxes(paneA as never)[0]?.queue).toHaveLength(1);
    unsubscribeA();
    unsubscribeB();
  });

  it("aborts a replacement when its edit is cancelled during history loading", async () => {
    const history = createDeferred<{ messages: unknown[] }>();
    const { host, unsubscribe } = queueHost([{}], {
      connected: true,
      chatLoading: true,
      requestHandlers: { "chat.history": () => history.promise },
    });
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "message 1, corrected");
    const edit = host.chatQueuedEdit!;

    const send = handleSendChat(host as never, edit.draftText, {
      attachmentsOverride: [...edit.attachments],
      resumeQueuedMessageEditId: edit.id,
    });
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: SESSION_KEY }),
      ),
    );

    expect(cancelQueuedMessageEdit(host as never)).toBe(true);
    history.resolve({ messages: [] });
    await send;

    expect(storedOrder(host)).toEqual(["message 1"]);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    unsubscribe();
  });

  it("preserves the queued reply target instead of the composer target", async () => {
    const queuedReplyTarget = {
      messageId: "queued-reply",
      sourceMessageId: "queued-reply",
      text: "the queued source",
      senderLabel: "Queue source",
    };
    const composerReplyTarget = {
      messageId: "composer-reply",
      sourceMessageId: "composer-reply",
      text: "the composer source",
      senderLabel: "Composer source",
    };
    const { host, unsubscribe } = queueHost([{ replyToId: queuedReplyTarget.sourceMessageId }]);
    host.chatReplyTarget = composerReplyTarget;
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "edited queued reply");
    const edit = host.chatQueuedEdit!;

    await handleSendChat(host as never, edit.draftText, {
      attachmentsOverride: [...edit.attachments],
      resumeQueuedMessageEditId: edit.id,
    });

    expect(listStoredChatOutboxes(host as never)[0]?.queue[0]?.replyToId).toBe(
      queuedReplyTarget.sourceMessageId,
    );
    expect(host.chatReplyTarget).toEqual(composerReplyTarget);
    unsubscribe();
  });

  it("releases only the images the replacement dropped", async () => {
    const kept = stageQueuedImage("att-kept");
    const dropped = stageQueuedImage("att-dropped");
    const { host, unsubscribe } = queueHost([{}, { attachments: [kept, dropped] }, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");
    await handleSendChat(host as never, "message 2, corrected", {
      attachmentsOverride: [kept],
      resumeQueuedMessageEditId: host.chatQueuedEdit!.id,
    });

    expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
    // The row that owned the dropped image is gone, so nothing else can free it —
    // and the row's own copy is already unreachable by the time the send lands.
    expect(getChatAttachmentDataUrl(dropped)).toBeNull();
    expect(getChatAttachmentDataUrl(kept)).not.toBeNull();
    unsubscribe();
  });

  it("keeps the original queued when the replacement's stored write is rejected", async () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    updateQueuedMessageEdit(host as never, "message 2, corrected");
    rejectStoredGrowth();

    await handleSendChat(host as never, "message 2, corrected");

    // Retiring the original before its replacement is stored would lose both, in
    // the one failure the offline queue exists to survive. The edit stays open on
    // the row that is still there, which is what cancelling already promises.
    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(host.chatMessage).toBe("");
    expect(host.chatError).toBe(OFFLINE_QUEUE_STORAGE_ERROR);
    unsubscribe();
  });

  it("keeps a normal composer send independent of an open row edit", async () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    host.chatMessage = "a separate composer draft";

    await handleSendChat(host as never);

    expect(storedOrder(host)).toEqual([
      "message 1",
      "message 2",
      "message 3",
      "a separate composer draft",
    ]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(host.chatMessage).toBe("");
    unsubscribe();
  });

  it("does not collapse same-payload row and composer sends", async () => {
    const ack = createDeferred<{ status: "started" }>();
    const { host, unsubscribe } = queueHost([{}], {
      connected: true,
      requestHandlers: { "chat.send": () => ack.promise },
    });
    beginQueuedMessageEdit(host as never, "queued-1");
    updateQueuedMessageEdit(host as never, "same payload");
    const edit = host.chatQueuedEdit!;

    const rowSend = handleSendChat(host as never, edit.draftText, {
      attachmentsOverride: [...edit.attachments],
      resumeQueuedMessageEditId: edit.id,
    });
    await vi.waitFor(() => expect(host.request).toHaveBeenCalledTimes(1));

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
    const unsubscribe = subscribeChatOutboxProjection(host as never);
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

    updateQueuedMessageEdit(host as never, "message 1, corrected");
    await handleSendChat(host as never, "message 1, corrected");

    expect(storedOutboxesByAgent(host)).toEqual({
      lily: ["message 1"],
      nova: ["message 1, corrected"],
    });
    unsubscribe();
  });

  it("edits beside an existing composer draft", () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    host.chatMessage = "typing something else";

    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("started");

    expect(storedOrder(host)).toEqual(["message 1", "message 2"]);
    expect(host.chatMessage).toBe("typing something else");
    expect(host.chatQueuedEdit?.draftText).toBe("message 1");
    unsubscribe();
  });

  it("edits one row at a time", () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    beginQueuedMessageEdit(host as never, "queued-1");
    host.chatMessage = "";

    expect(beginQueuedMessageEdit(host as never, "queued-2")).toBe("unavailable");
    unsubscribe();
  });

  it.each([
    { label: "a steer chip", overrides: { kind: "steered" as const } },
    { label: "a local command", overrides: { localCommandName: "compact" } },
    { label: "a delivery-uncertain row", overrides: { sendState: "unconfirmed" as const } },
  ])("refuses to edit $label", ({ overrides }) => {
    const { host, unsubscribe } = queueHost([overrides]);

    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("unavailable");
    unsubscribe();
  });

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
