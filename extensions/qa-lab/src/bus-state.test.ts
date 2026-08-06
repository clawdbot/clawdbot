// Qa Lab tests cover bus state plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";

describe("qa-bus state", () => {
  it("roundtrips canonical target kinds and rejects non-canonical prefix casing", () => {
    const state = createQaBusState();
    const direct = state.addOutboundMessage({ to: "dm:CaseSensitive", text: "direct" });
    const channel = state.addOutboundMessage({ to: "channel:CaseSensitive", text: "channel" });
    const group = state.addOutboundMessage({ to: "group:CaseSensitive", text: "group" });
    const thread = state.addOutboundMessage({
      to: "thread:CaseSensitive/ThreadCase",
      text: "thread",
    });

    expect(direct.conversation).toEqual({ id: "CaseSensitive", kind: "direct" });
    expect(channel.conversation).toEqual({ id: "CaseSensitive", kind: "channel" });
    expect(group.conversation).toEqual({ id: "CaseSensitive", kind: "group" });
    expect(thread.conversation).toEqual({ id: "CaseSensitive", kind: "channel" });
    expect(thread.threadId).toBe("ThreadCase");
    expect(() =>
      state.addOutboundMessage({ to: "CHANNEL:CaseSensitive", text: "invalid" }),
    ).toThrow("qa-channel target prefixes must be lowercase");
  });

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

  it("records provider-native inbound IDs before indexing and publishing messages", () => {
    const state = createQaBusState();
    const providerMessageId = "$provider-event:matrix.test";

    const inbound = state.addInboundMessage(
      {
        conversation: { id: "qa-room", kind: "group" },
        senderId: "alice",
        text: "provider-native identity",
      },
      providerMessageId,
    );
    const snapshot = state.getSnapshot();

    expect(inbound.id).toBe(providerMessageId);
    expect(snapshot.messages[0]?.id).toBe(providerMessageId);
    expect(snapshot.events[0]).toMatchObject({
      kind: "inbound-message",
      message: { id: providerMessageId },
    });
    expect(state.poll().events[0]).toMatchObject({
      kind: "inbound-message",
      message: { id: providerMessageId },
    });
    expect(state.readMessage({ messageId: providerMessageId })).toMatchObject({
      id: providerMessageId,
      text: "provider-native identity",
    });
  });

  it("keeps identical provider-native message IDs isolated by account", () => {
    const state = createQaBusState();
    const messageId = "42";

    for (const accountId of ["account-a", "account-b"]) {
      state.addInboundMessage(
        {
          accountId,
          conversation: { id: `${accountId}-room`, kind: "group" },
          senderId: accountId,
          text: `${accountId} original`,
        },
        messageId,
      );
    }

    const snapshot = state.getSnapshot();
    expect(snapshot.messages.map((message) => [message.accountId, message.id])).toEqual([
      ["account-a", messageId],
      ["account-b", messageId],
    ]);
    expect(snapshot.events.map((event) => event.accountId)).toEqual(["account-a", "account-b"]);

    for (const accountId of ["account-a", "account-b"]) {
      expect(state.readMessage({ accountId, messageId })).toMatchObject({
        accountId,
        id: messageId,
        text: `${accountId} original`,
      });
      expect(state.searchMessages({ accountId })).toEqual([
        expect.objectContaining({ accountId, id: messageId }),
      ]);
      expect(state.poll({ accountId }).events).toEqual([
        expect.objectContaining({ accountId, message: expect.objectContaining({ id: messageId }) }),
      ]);
    }

    state.editMessage({ accountId: "account-a", messageId, text: "account-a edited" });
    state.reactToMessage({ accountId: "account-b", messageId, emoji: "eyes" });
    expect(state.readMessage({ accountId: "account-a", messageId })).toMatchObject({
      text: "account-a edited",
      reactions: [],
    });
    expect(state.readMessage({ accountId: "account-b", messageId })).toMatchObject({
      text: "account-b original",
      reactions: [expect.objectContaining({ emoji: "eyes" })],
    });
  });

  it("rejects ambiguous provider-native IDs instead of selecting the wrong conversation", () => {
    const state = createQaBusState();
    const accountId = "account-a";
    const messageId = "42";

    for (const conversationId of ["first-room", "second-room"]) {
      state.addInboundMessage(
        {
          accountId,
          conversation: { id: conversationId, kind: "group" },
          senderId: "alice",
          text: `${conversationId} original`,
        },
        messageId,
      );
    }

    const originalSnapshot = state.getSnapshot();
    expect(originalSnapshot.messages.map((message) => message.conversation.id)).toEqual([
      "first-room",
      "second-room",
    ]);
    expect(originalSnapshot.events.map((event) => event.accountId)).toEqual([accountId, accountId]);
    for (const conversationId of ["first-room", "second-room"]) {
      expect(state.searchMessages({ accountId, conversationId })).toEqual([
        expect.objectContaining({
          id: messageId,
          conversation: expect.objectContaining({ id: conversationId }),
        }),
      ]);
    }

    const ambiguousMessage = "qa-bus message id is ambiguous for selected account: 42";
    expect(() => state.readMessage({ accountId, messageId })).toThrow(ambiguousMessage);
    expect(() => state.editMessage({ accountId, messageId, text: "wrong conversation" })).toThrow(
      ambiguousMessage,
    );
    expect(() => state.reactToMessage({ accountId, messageId, emoji: "eyes" })).toThrow(
      ambiguousMessage,
    );
    expect(() => state.deleteMessage({ accountId, messageId })).toThrow(ambiguousMessage);
    expect(state.getSnapshot()).toEqual(originalSnapshot);
  });

  it("normalizes the dm ingress alias before channel routing", () => {
    const state = createQaBusState();

    const inbound = state.addInboundMessage({
      conversation: { id: "alice", kind: "dm" as never },
      senderId: "alice",
      text: "hello",
    });

    expect(inbound.conversation).toEqual({ id: "alice", kind: "direct" });
    expect(state.getSnapshot().conversations).toEqual([
      expect.objectContaining({ id: "alice", kind: "direct" }),
    ]);
  });

  it("rejects unknown inbound conversation kinds instead of treating them as groups", () => {
    const state = createQaBusState();

    expect(() =>
      state.addInboundMessage({
        conversation: { id: "alice", kind: "private" as never },
        senderId: "alice",
        text: "hello",
      }),
    ).toThrow("invalid qa-channel conversation kind: private");
  });

  it("creates threads and mutates message state", () => {
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
    expect(snapshot.threads[0]?.id).toBe(thread.id);
    expect(snapshot.threads[0]?.conversationId).toBe("qa-room");
    expect(snapshot.threads[0]?.title).toBe("QA thread");
    expect(snapshot.messages[0]?.id).toBe(message.id);
    expect(snapshot.messages[0]?.text).toBe("inside thread (edited)");
    expect(snapshot.messages[0]?.deleted).toBe(true);
    expect(snapshot.messages[0]?.reactions).toHaveLength(1);
    expect(snapshot.messages[0]?.reactions[0]?.emoji).toBe("eyes");
    expect(snapshot.messages[0]?.reactions[0]?.senderId).toBe("alice");
    expect(typeof snapshot.messages[0]?.reactions[0]?.timestamp).toBe("number");
  });

  it("keeps deleted messages inspectable but removes them from mutations and search", () => {
    const state = createQaBusState();
    const live = state.addOutboundMessage({ to: "channel:qa-room", text: "needle live" });
    const deleted = state.addOutboundMessage({ to: "channel:qa-room", text: "needle deleted" });

    state.deleteMessage({ messageId: deleted.id });
    const cursorAfterDelete = state.getSnapshot().cursor;

    expect(state.readMessage({ messageId: deleted.id }).deleted).toBe(true);
    expect(state.getSnapshot().messages.map((message) => message.id)).toEqual([
      live.id,
      deleted.id,
    ]);
    expect(state.searchMessages({ query: "needle", limit: 1 })).toEqual([
      expect.objectContaining({ id: live.id }),
    ]);

    expect(() =>
      state.editMessage({ messageId: deleted.id, text: "edited after deletion" }),
    ).toThrow("qa-bus message was deleted");
    expect(() => state.reactToMessage({ messageId: deleted.id, emoji: "eyes" })).toThrow(
      "qa-bus message was deleted",
    );
    expect(() => state.deleteMessage({ messageId: deleted.id })).toThrow(
      "qa-bus message was deleted",
    );
    expect(state.getSnapshot().cursor).toBe(cursorAfterDelete);
  });

  it("adds each sender and emoji reaction at most once", () => {
    const state = createQaBusState();
    const message = state.addOutboundMessage({ to: "channel:qa-room", text: "react once" });

    state.reactToMessage({ messageId: message.id, emoji: "eyes", senderId: " alice " });
    const cursorAfterReaction = state.getSnapshot().cursor;

    const repeated = state.reactToMessage({
      messageId: message.id,
      emoji: "eyes",
      senderId: "alice",
    });
    expect(repeated.reactions).toHaveLength(1);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction);

    state.reactToMessage({ messageId: message.id, emoji: "eyes", senderId: "bob" });
    state.reactToMessage({ messageId: message.id, emoji: "wave", senderId: "alice" });
    expect(state.readMessage({ messageId: message.id }).reactions).toEqual([
      expect.objectContaining({ emoji: "eyes", senderId: "alice" }),
      expect.objectContaining({ emoji: "eyes", senderId: "bob" }),
      expect.objectContaining({ emoji: "wave", senderId: "alice" }),
    ]);
    expect(state.getSnapshot().cursor).toBe(cursorAfterReaction + 2);
  });

  it("keeps owned threads scoped to their account, channel, and conversation", () => {
    const state = createQaBusState();
    const thread = state.createThread({
      accountId: "account-a",
      conversationId: "qa-room",
      title: "Owned thread",
    });
    const originalSnapshot = state.getSnapshot();

    expect(() =>
      state.addOutboundMessage({
        accountId: "account-b",
        to: `thread:qa-room/${thread.id}`,
        text: "cross-account reply",
      }),
    ).toThrow("qa-bus thread not found in selected account and conversation");
    expect(() =>
      state.addOutboundMessage({
        accountId: "account-a",
        to: `thread:other-room/${thread.id}`,
        text: "wrong-room reply",
      }),
    ).toThrow("qa-bus thread not found in selected account and conversation");
    for (const kind of ["direct", "group"] as const) {
      expect(() =>
        state.addInboundMessage({
          accountId: "account-a",
          conversation: { id: "qa-room", kind },
          senderId: "alice",
          text: "wrong-kind reply",
          threadId: thread.id,
        }),
      ).toThrow("qa-bus thread not found in selected account and conversation");
    }
    expect(state.getSnapshot()).toEqual(originalSnapshot);

    const reply = state.addOutboundMessage({
      accountId: "account-a",
      to: `thread:qa-room/${thread.id}`,
      text: "owned reply",
    });
    const external = state.addOutboundMessage({
      accountId: "account-b",
      to: "thread:other-room/external-thread",
      text: "externally observed reply",
    });
    expect(reply.threadId).toBe(thread.id);
    expect(external.threadId).toBe("external-thread");
  });

  it("rejects cross-account message reads and mutations", () => {
    const state = createQaBusState();
    const message = state.addOutboundMessage({
      accountId: "account-a",
      to: "channel:qa-room",
      text: "account-owned",
    });

    expect(() => state.readMessage({ accountId: "account-b", messageId: message.id })).toThrow(
      "qa-bus message not found",
    );
    expect(() =>
      state.reactToMessage({
        accountId: "account-b",
        messageId: message.id,
        emoji: "eyes",
      }),
    ).toThrow("qa-bus message not found");
    expect(() =>
      state.editMessage({
        accountId: "account-b",
        messageId: message.id,
        text: "foreign edit",
      }),
    ).toThrow("qa-bus message not found");
    expect(() => state.deleteMessage({ accountId: "account-b", messageId: message.id })).toThrow(
      "qa-bus message not found",
    );

    const unchanged = state.readMessage({ accountId: "account-a", messageId: message.id });
    expect(unchanged.text).toBe("account-owned");
    expect(unchanged.deleted).not.toBe(true);
    expect(unchanged.reactions).toEqual([]);
  });

  it("keeps message conversation identity isolated by account and kind", () => {
    const state = createQaBusState();
    const directA = state.addInboundMessage({
      accountId: "account-a",
      conversation: { id: "shared", kind: "direct", title: "Direct A" },
      senderId: "alice",
      text: "direct a",
    });
    const channelA = state.addOutboundMessage({
      accountId: "account-a",
      to: "channel:shared",
      text: "channel a",
    });
    const directB = state.addInboundMessage({
      accountId: "account-b",
      conversation: { id: "shared", kind: "direct", title: "Direct B" },
      senderId: "bob",
      text: "direct b",
    });

    expect(
      state.readMessage({ accountId: "account-a", messageId: directA.id }).conversation,
    ).toEqual({ id: "shared", kind: "direct", title: "Direct A" });
    expect(
      state.readMessage({ accountId: "account-a", messageId: channelA.id }).conversation,
    ).toEqual({ id: "shared", kind: "channel" });
    expect(
      state.readMessage({ accountId: "account-b", messageId: directB.id }).conversation,
    ).toEqual({ id: "shared", kind: "direct", title: "Direct B" });
    expect(state.getSnapshot().conversations).toEqual(
      expect.arrayContaining([
        { accountId: "account-a", id: "shared", kind: "direct", title: "Direct A" },
        { accountId: "account-a", id: "shared", kind: "channel" },
        { accountId: "account-b", id: "shared", kind: "direct", title: "Direct B" },
      ]),
    );
  });

  it("applies kind and root-thread search scope before limiting results", () => {
    const state = createQaBusState();
    const root = state.addOutboundMessage({
      to: "channel:shared",
      text: "needle root",
    });
    const direct = state.addOutboundMessage({
      to: "dm:shared",
      text: "needle direct",
    });
    for (let index = 0; index < 25; index += 1) {
      state.addOutboundMessage({
        to: `thread:shared/thread-${String(index)}`,
        text: `needle thread ${String(index)}`,
      });
    }

    expect(
      state
        .searchMessages({
          query: "needle",
          conversationId: "shared",
          conversationKind: "channel",
          threadId: null,
          limit: 2,
        })
        .map((message) => message.id),
    ).toEqual([root.id]);
    expect(
      state
        .searchMessages({
          query: "needle",
          conversationId: "shared",
          conversationKind: "direct",
          threadId: null,
          limit: 2,
        })
        .map((message) => message.id),
    ).toEqual([direct.id]);
    expect(state.searchMessages({ conversationId: "", limit: 2 })).toEqual([]);
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

  it("ignores deleted message matches until a visible replacement arrives", async () => {
    const state = createQaBusState();
    const deleted = state.addOutboundMessage({
      to: "dm:alice",
      text: "QA-VISIBLE-REPLACEMENT",
    });
    state.deleteMessage({ messageId: deleted.id });

    await expect(
      state.waitFor({
        direction: "outbound",
        kind: "message-text",
        textIncludes: "QA-VISIBLE-REPLACEMENT",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("qa-bus wait timeout after 10ms");

    const pending = state.waitFor({
      direction: "outbound",
      kind: "message-text",
      textIncludes: "QA-VISIBLE-REPLACEMENT",
      timeoutMs: 100,
    });
    const replacement = state.addOutboundMessage({
      to: "dm:alice",
      text: "QA-VISIBLE-REPLACEMENT",
    });

    await expect(pending).resolves.toMatchObject({ id: replacement.id, direction: "outbound" });
  });

  it("caps oversized wait timers", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const state = createQaBusState();
      const pendingMessage = state.waitFor({
        kind: "message-text",
        textIncludes: "missing",
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      const pendingCursor = state.waitForCursorAdvance(0, Number.MAX_SAFE_INTEGER);

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);

      pendingMessage.catch(() => undefined);
      pendingCursor.catch(() => undefined);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
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
      new Promise((resolve) => {
        setTimeout(() => resolve("still-waiting"), 20);
      }),
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
    const attachment = readback.attachments?.[0];
    expect(attachment?.kind).toBe("image");
    expect(attachment?.fileName).toBe("qa-screenshot.png");
    expect(attachment?.altText).toBe("QA dashboard screenshot");

    const byFilename = state.searchMessages({
      query: "screenshot",
    });
    expect(byFilename.map((message) => message.id)).toContain(outbound.id);

    const byAltText = state.searchMessages({
      query: "dashboard",
    });
    expect(byAltText.map((message) => message.id)).toContain(outbound.id);
  });

  it("preserves sanitized tool-call traces on bus messages", () => {
    const state = createQaBusState();

    const outbound = state.addOutboundMessage({
      to: "dm:alice",
      text: "used a tool",
      toolCalls: [
        {
          name: "exec",
          arguments: {
            command: "pwd",
            apiToken: "secret-token",
          },
        },
      ],
    });

    const readback = state.readMessage({ messageId: outbound.id });
    expect(readback.toolCalls).toEqual([
      {
        name: "exec",
        arguments: {
          command: "[redacted]",
          apiToken: "[redacted]",
        },
      },
    ]);
    expect(state.searchMessages({ query: "exec" }).map((message) => message.id)).toContain(
      outbound.id,
    );

    const readbackArguments = readback.toolCalls?.[0]?.arguments;
    if (!readbackArguments) {
      throw new Error("expected tool-call arguments");
    }
    readbackArguments.command = "mutated";
    expect(state.readMessage({ messageId: outbound.id }).toolCalls?.[0]?.arguments?.command).toBe(
      "[redacted]",
    );
  });
});
