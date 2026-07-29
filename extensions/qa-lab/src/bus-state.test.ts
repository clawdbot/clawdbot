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
