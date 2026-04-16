import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";

describe("qa-bus state", () => {
  it("records inbound and outbound traffic in cursor order", () => {
    const state = createQaBusState();

    const inbound = state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "hello",
    });
    const outbound = state.addOutboundMessage({
      to: "dm:alice",
      text: "hi",
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.cursor).toBe(2);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "inbound-message",
      "outbound-message",
    ]);
    expect(snapshot.messages.map((message) => message.id)).toEqual([inbound.id, outbound.id]);
  });

  it("creates threads and mutates message state", async () => {
    const state = createQaBusState();

    const thread = state.createThread({
      conversationId: "qa-room",
      title: "QA thread",
    });
    const message = state.addOutboundMessage({
      to: `thread:qa-room/${thread.id}`,
      text: "inside thread",
      threadId: thread.id,
    });

    state.reactToMessage({
      messageId: message.id,
      emoji: "eyes",
      senderId: "alice",
    });
    state.editMessage({
      messageId: message.id,
      text: "inside thread (edited)",
    });
    state.deleteMessage({
      messageId: message.id,
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      id: thread.id,
      conversationId: "qa-room",
      title: "QA thread",
    });
    expect(snapshot.messages[0]).toMatchObject({
      id: message.id,
      text: "inside thread (edited)",
      deleted: true,
      reactions: [{ emoji: "eyes", senderId: "alice" }],
    });
  });

  it("waits for a text match and rejects on timeout", async () => {
    const state = createQaBusState();
    const pending = state.waitFor({
      kind: "message-text",
      textIncludes: "needle",
      timeoutMs: 500,
    });

    setTimeout(() => {
      state.addOutboundMessage({
        to: "dm:alice",
        text: "haystack + needle",
      });
    }, 20);

    const matched = await pending;
    expect("text" in matched && matched.text).toContain("needle");

    await expect(
      state.waitFor({
        kind: "message-text",
        textIncludes: "missing",
        timeoutMs: 20,
      }),
    ).rejects.toThrow("qa-bus wait timeout");
  });

  it("keeps account-scoped cursor waits blocked on unrelated account traffic", async () => {
    const state = createQaBusState();
    const pending = state.waitForCursorAdvance(0, 500, (snapshot) => {
      return snapshot.events.some((event) => event.accountId === "acct-a" && event.cursor > 0);
    });

    state.addInboundMessage({
      accountId: "acct-b",
      conversation: { id: "other", kind: "direct" },
      senderId: "acct-b-user",
      text: "unrelated",
    });

    const beforeMatch = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 20)),
    ]);
    expect(beforeMatch).toBe("still-waiting");

    state.addInboundMessage({
      accountId: "acct-a",
      conversation: { id: "target", kind: "direct" },
      senderId: "acct-a-user",
      text: "matched",
    });

    await expect(pending).resolves.toBeUndefined();
  });

  it("wakes default-account cursor waits when accountId is omitted", async () => {
    const state = createQaBusState();
    const pending = state.waitForCursorAdvance(0, 500, (snapshot) => {
      return snapshot.events.some((event) => event.accountId === "default" && event.cursor > 0);
    });

    state.addInboundMessage({
      conversation: { id: "target", kind: "direct" },
      senderId: "default-user",
      text: "matched",
    });

    await expect(pending).resolves.toBeUndefined();
  });

  it("preserves inline attachments and lets search match attachment metadata", () => {
    const state = createQaBusState();

    const outbound = state.addOutboundMessage({
      to: "dm:alice",
      text: "artifact attached",
      attachments: [
        {
          id: "image-1",
          kind: "image",
          mimeType: "image/png",
          fileName: "qa-screenshot.png",
          altText: "QA dashboard screenshot",
          contentBase64: "aGVsbG8=",
        },
      ],
    });

    const readback = state.readMessage({ messageId: outbound.id });
    expect(readback.attachments).toHaveLength(1);
    expect(readback.attachments?.[0]).toMatchObject({
      kind: "image",
      fileName: "qa-screenshot.png",
      altText: "QA dashboard screenshot",
    });

    const byFilename = state.searchMessages({
      query: "screenshot",
    });
    expect(byFilename.some((message) => message.id === outbound.id)).toBe(true);

    const byAltText = state.searchMessages({
      query: "dashboard",
    });
    expect(byAltText.some((message) => message.id === outbound.id)).toBe(true);
  });
});
