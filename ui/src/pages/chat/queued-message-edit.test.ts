/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession, subscribeChatOutboxProjection } from "./chat-queue.ts";
import { enqueuePendingSendMessage } from "./chat-send-queue-state.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";
import {
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
} from "./queued-message-edit.ts";

const SESSION_KEY = "agent:main";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(items: readonly Partial<ChatQueueItem>[]) {
  const host = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
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

describe("queued message edit round-trip", () => {
  it("keeps the row in place and lifts its attachments into the composer", () => {
    const attachment = { id: "att-1", mimeType: "image/png", dataUrl: "data:image/png;base64,iVB" };
    const { host, unsubscribe } = queueHost([{}, { attachments: [attachment] }, {}]);

    expect(beginQueuedMessageEdit(host as never, "queued-2")).toBe("started");

    expect(host.chatMessage).toBe("message 2");
    expect(host.chatAttachments.map((item) => item.id)).toEqual(["att-1"]);
    // The row holds its slot so the operator can see where the edit lands.
    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(true);
    expect(isQueuedMessageBeingEdited(host as never, "queued-1")).toBe(false);
    unsubscribe();
  });

  it("leaves the queue untouched when the edit is cancelled", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");
    host.chatMessage = "half-typed replacement";

    expect(cancelQueuedMessageEdit(host as never)).toBe(true);

    expect(storedOrder(host)).toEqual(["message 1", "message 2", "message 3"]);
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(false);
    unsubscribe();
  });

  it("replaces the row in the same slot when the edited message is sent", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    beginQueuedMessageEdit(host as never, "queued-2");

    const resent = enqueuePendingSendMessage(host as never, "message 2, corrected");
    expect(resent).not.toBeNull();
    expect(admitQueuedMessageForSession(host as never, SESSION_KEY, resent!)).toBe(true);

    expect(storedOrder(host)).toEqual(["message 1", "message 2, corrected", "message 3"]);
    expect(isQueuedMessageBeingEdited(host as never, "queued-2")).toBe(false);
    unsubscribe();
  });

  it("refuses to edit while the composer already holds a message", () => {
    const { host, unsubscribe } = queueHost([{}, {}]);
    host.chatMessage = "typing something else";

    expect(beginQueuedMessageEdit(host as never, "queued-1")).toBe("composer-busy");

    expect(storedOrder(host)).toEqual(["message 1", "message 2"]);
    expect(host.chatMessage).toBe("typing something else");
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
