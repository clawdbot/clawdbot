import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesShortIdState,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
} from "./monitor-reply-cache.js";
import { buildBlueBubblesChatContextFromTarget } from "./targets.js";

describe("resolveBlueBubblesMessageId chat-scoped short-id guard", () => {
  beforeEach(() => {
    _resetBlueBubblesShortIdState();
  });

  afterEach(() => {
    _resetBlueBubblesShortIdState();
  });

  function seedMessage(args: {
    accountId: string;
    messageId: string;
    chatGuid?: string;
    chatIdentifier?: string;
    chatId?: number;
  }) {
    return rememberBlueBubblesReplyCache({
      accountId: args.accountId,
      messageId: args.messageId,
      chatGuid: args.chatGuid,
      chatIdentifier: args.chatIdentifier,
      chatId: args.chatId,
      timestamp: Date.now(),
    });
  }

  it("returns the cached uuid when the short id resolves within the same chatGuid", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    const resolved = resolveBlueBubblesMessageId(entry.shortId, {
      requireKnownShortId: true,
      chatContext: { chatGuid: "iMessage;+;chat240698944142298252" },
    });

    expect(resolved).toBe("uuid-in-group");
  });

  it("throws when a short id points at a message in a different chatGuid", () => {
    const groupEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    // Agent tries to react in a DM but passes a short id that was allocated
    // for a group message. Should throw instead of silently letting BB
    // server route the tapback to the group (or worse, to an old DM that
    // happens to share the short id slot).
    expect(() =>
      resolveBlueBubblesMessageId(groupEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("rejects empty chat context for privileged callers (fail-closed cross-chat scope)", () => {
    seedMessage({
      accountId: "default",
      messageId: "uuid-no-ctx",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    // Empty context = caller could not derive any chat hint. The previous
    // behavior (fail-open) let a short id resolve without a chat scope —
    // but short ids are global across all chats, so an action call without
    // chat context could silently apply to the wrong conversation. Now
    // requireKnownShortId callers must pass at least one identifier
    // (chatGuid / chatIdentifier / chatId).
    expect(() =>
      resolveBlueBubblesMessageId("1", {
        requireKnownShortId: true,
        chatContext: {},
      }),
    ).toThrow(/requires a chat scope/);
  });

  it("falls back to chatIdentifier comparison when the caller has no chatGuid", () => {
    const dmEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-dm-1",
      chatIdentifier: "+8618621181874",
    });

    expect(
      resolveBlueBubblesMessageId(dmEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621181874" },
      }),
    ).toBe("uuid-dm-1");

    expect(() =>
      resolveBlueBubblesMessageId(dmEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621185125" },
      }),
    ).toThrow(/different chat/);
  });

  it("catches a handle-only caller against a cached entry that carries chatGuid", () => {
    // Real-world failure mode: inbound webhooks populate cached entries with
    // chatGuid (group or DM). A caller that only resolved a handle supplies
    // ctx.chatIdentifier without ctx.chatGuid. The guard must still catch
    // the mismatch so a group short-id cannot slip through when the call is
    // for a DM, which is exactly how group reactions were leaking into DMs.
    const groupEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
      chatIdentifier: "chat240698944142298252",
    });

    expect(() =>
      resolveBlueBubblesMessageId(groupEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("falls back to chatId comparison when neither chatGuid nor chatIdentifier is available", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-with-id",
      chatId: 42,
    });

    expect(
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatId: 42 },
      }),
    ).toBe("uuid-with-id");

    expect(() =>
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatId: 99 },
      }),
    ).toThrow(/different chat/);
  });

  it("passes a full uuid through unchanged when not in the reply cache", () => {
    // Cache miss falls through. Callers supplying a GUID that the cache
    // hasn't observed get the input back so fresh-from-the-wire GUIDs
    // (e.g. from a `find` API call) still work.
    const resolved = resolveBlueBubblesMessageId("1E7E6B6A-0000-4C6C-BCA7-000000000001", {
      requireKnownShortId: true,
      chatContext: { chatGuid: "iMessage;+;anything" },
    });
    expect(resolved).toBe("1E7E6B6A-0000-4C6C-BCA7-000000000001");
  });

  it("passes a full uuid through unchanged when caller supplies no chat context", () => {
    // Belt-and-braces: even when the cache knows the GUID, callers that
    // can't supply any chat hint at all (legacy tool invocations) fall
    // through to preserve prior behavior.
    seedMessage({
      accountId: "default",
      messageId: "uuid-known",
      chatGuid: "iMessage;+;chat240698944142298252",
    });
    expect(resolveBlueBubblesMessageId("uuid-known")).toBe("uuid-known");
    expect(resolveBlueBubblesMessageId("uuid-known", { chatContext: {} })).toBe("uuid-known");
  });

  it("accepts a full uuid that points at a same-chat cached entry", () => {
    seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    const resolved = resolveBlueBubblesMessageId("uuid-in-group", {
      chatContext: { chatGuid: "iMessage;+;chat240698944142298252" },
    });
    expect(resolved).toBe("uuid-in-group");
  });

  it("REJECTS a full uuid that points at a different chat in the cache", () => {
    // Candidate-1 regression: the previous implementation only ran the
    // cross-chat guard on numeric short ids. After the short-id guard
    // landed, agents that retried with a full GUID (because the short id
    // got rejected) silently bypassed the check. Group GUIDs reused in
    // DM tool calls again leaked group reactions into DMs.
    seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    expect(() =>
      resolveBlueBubblesMessageId("uuid-in-group", {
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("uuid-path error message hints at fixing the chat target, not the id format", () => {
    // The short-id error tells the agent to retry with the full GUID.
    // For UUID input that's already failed, advising "use the full GUID"
    // would be wrong — the agent already supplied one. Make the
    // remediation hint differ so a retrying agent is steered toward
    // fixing the chat target.
    seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    try {
      resolveBlueBubblesMessageId("uuid-in-group", {
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      });
      expect.fail("expected cross-chat guard to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Chat identifiers redacted in error message (PII / log-stream hardening).
      expect(message).toContain("chatGuid=<redacted>");
      expect(message).not.toContain("iMessage;+;chat240698944142298252");
      expect(message).not.toContain("iMessage;-;+8618621181874");
      expect(message).toContain("correct chat target");
      expect(message).not.toContain("Retry with the full message GUID");
    }
  });

  it("applies the chatIdentifier fallback to full uuid input as well", () => {
    // Same handle-only-caller scenario as the short-id case: a tool
    // invocation might only resolve the chatIdentifier (the bare handle).
    // The guard must catch GUID reuse across mismatched chatIdentifiers
    // even when the caller has no chatGuid hint.
    seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
      chatIdentifier: "chat240698944142298252",
    });

    expect(() =>
      resolveBlueBubblesMessageId("uuid-in-group", {
        chatContext: { chatIdentifier: "+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("reports the conflicting chats in the error message for debugability", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    try {
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      });
      expect.fail("expected cross-chat guard to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Chat identifiers redacted in error message (PII / log-stream hardening).
      expect(message).toContain("chatGuid=<redacted>");
      expect(message).not.toContain("iMessage;+;chat240698944142298252");
      expect(message).not.toContain("iMessage;-;+8618621181874");
      expect(message).toContain("full message GUID");
    }
  });

  it("still throws requireKnownShortId for unknown numeric inputs", () => {
    expect(() =>
      resolveBlueBubblesMessageId("999", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;anything" },
      }),
    ).toThrow(/no longer available/);
  });

  it("accepts same-chat short ids when the caller's target uses a non-canonical handle format", () => {
    // Real-world: a cached entry carries the BlueBubbles-normalized handle
    // (`+15551234567`) as its chatIdentifier. A tool call like
    // `react to: "imessage:(555) 123-4567"` has to project into the same
    // chatIdentifier before the guard compares — otherwise the raw handle
    // `(555) 123-4567` would fail the mismatch check against the cached
    // `+15551234567` and legitimate same-chat reactions/replies would be
    // blocked.
    const dmEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-dm-handle",
      chatIdentifier: "+15551234567",
    });
    const cachedChatIdentifier = dmEntry.chatIdentifier;

    for (const target of ["imessage:+15551234567", "sms:+15551234567", "+15551234567"]) {
      const ctx = buildBlueBubblesChatContextFromTarget(target);
      expect(ctx.chatIdentifier, `ctx.chatIdentifier for ${target}`).toBe(cachedChatIdentifier);
      expect(
        resolveBlueBubblesMessageId(dmEntry.shortId, {
          requireKnownShortId: true,
          chatContext: ctx,
        }),
        `resolve for ${target}`,
      ).toBe("uuid-dm-handle");
    }

    // Mixed-case email handle: cached as lowercase; caller supplies mixed
    // case. Still resolves.
    const emailEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-email",
      chatIdentifier: "user@example.com",
    });
    const emailCtx = buildBlueBubblesChatContextFromTarget("imessage:User@Example.COM");
    expect(emailCtx.chatIdentifier).toBe("user@example.com");
    expect(
      resolveBlueBubblesMessageId(emailEntry.shortId, {
        requireKnownShortId: true,
        chatContext: emailCtx,
      }),
    ).toBe("uuid-email");
  });
});
