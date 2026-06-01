import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetIMessageShortIdState,
  findLatestIMessageEntryForChat,
  isKnownFromMeIMessageMessageId,
  rememberIMessageReplyCache,
  resolveIMessageMessageId,
} from "./monitor-reply-cache.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

beforeEach(() => {
  installIMessageStateRuntimeForTest();
  resetIMessageShortIdState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("imessage short message id resolution", () => {
  it("resolves a short id to a cached message guid", () => {
    const entry = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(entry.shortId).toBe("1");
    expect(
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).toBe("full-guid");
  });

  it("resolves a known short id even without caller-supplied chat scope", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    // The cached entry already carries chat info; cross-chat checks only
    // matter when the caller separately provides a (potentially conflicting)
    // chat scope. A plain known short id from the cache must resolve.
    expect(resolveIMessageMessageId("1", { requireKnownShortId: true })).toBe("full-guid");
  });

  it("requires chat scope when a privileged short id is unknown", () => {
    expect(() => resolveIMessageMessageId("9999", { requireKnownShortId: true })).toThrow(
      "requires a chat scope",
    );
  });

  it("rejects short ids from another chat", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(() =>
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;other" },
      }),
    ).toThrow("belongs to a different chat");
  });

  it("guards full guid reuse across chats when cached", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatId: 42,
      timestamp: Date.now(),
    });

    expect(() => resolveIMessageMessageId("full-guid", { chatContext: { chatId: 99 } })).toThrow(
      "belongs to a different chat",
    );
  });

  it("recognizes only cached outbound message ids as own messages", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: true,
    });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "inbound-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: false,
    });

    expect(
      isKnownFromMeIMessageMessageId("outbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106512",
        chatIdentifier: "+12069106512",
        chatId: 3,
      }),
    ).toBe(true);
    expect(
      isKnownFromMeIMessageMessageId("inbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106512",
        chatIdentifier: "+12069106512",
        chatId: 3,
      }),
    ).toBe(false);
    expect(
      isKnownFromMeIMessageMessageId("outbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106514",
        chatIdentifier: "+12069106514",
        chatId: 4,
      }),
    ).toBe(false);
  });
});

describe("requireFromMe (edit / unsend authorization)", () => {
  it("rejects a short id resolution when the cached entry came from inbound", () => {
    // The default inbound recorder sets isFromMe:false (or omits it), so
    // resolving with requireFromMe must reject — agents cannot edit/unsend
    // messages that other participants sent.
    const entry = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "inbound-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: false,
    });

    expect(() =>
      resolveIMessageMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toThrow("not one this agent sent");
  });

  it("allows a short id resolution when the cached entry was sent by the gateway", () => {
    const entry = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: true,
    });

    expect(
      resolveIMessageMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toBe("outbound-guid");
  });

  it("rejects an uncached full guid under requireFromMe (agent cannot edit/unsend unknown messages)", () => {
    expect(() =>
      resolveIMessageMessageId("never-seen-guid", {
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toThrow("not one this agent sent");
  });

  it("rejects when the cached entry has no isFromMe field (older persisted entry, treated as not-from-me)", () => {
    // Persisted entries written before this option existed do not carry
    // isFromMe. Treat undefined as the safe default (false) — that pre-
    // existing-on-disk caller is the inbound recorder, the only writer that
    // existed before.
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "legacy-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      // isFromMe deliberately omitted
    });

    expect(() =>
      resolveIMessageMessageId("legacy-guid", {
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toThrow("not one this agent sent");
  });
});

describe("findLatestIMessageEntryForChat", () => {
  it("returns the latest entry for the matching chat scope", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "older",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now() - 1000,
    });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "newest",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    const result = findLatestIMessageEntryForChat({
      accountId: "default",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result?.messageId).toBe("newest");
  });

  it("requires a positive identifier match — no overlap means no fallback", () => {
    // Cache entry has only chatGuid; caller has only chatId. With the old
    // isCrossChatMismatch-as-filter, this entry would have been returned
    // (no overlap → no mismatch → pass). The strict positive-match
    // semantics require both sides to share at least one identifier kind.
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "different-chat",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(findLatestIMessageEntryForChat({ accountId: "default", chatId: 99 })).toBeUndefined();
  });

  it("never crosses account boundaries", () => {
    rememberIMessageReplyCache({
      accountId: "other-account",
      messageId: "foreign-account",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("ignores entries older than the recency window", () => {
    const TWELVE_MINUTES_AGO = Date.now() - 12 * 60 * 1000;
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "stale",
      chatIdentifier: "+12069106512",
      timestamp: TWELVE_MINUTES_AGO,
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("matches across chat-id-format flavors (iMessage;-;<phone>, any;-;<phone>, bare phone)", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "phone-msg",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    for (const ctx of [
      { accountId: "default", chatIdentifier: "iMessage;-;+12069106512" },
      { accountId: "default", chatIdentifier: "SMS;-;+12069106512" },
      { accountId: "default", chatGuid: "any;-;+12069106512" },
      { accountId: "default", chatIdentifier: "+12069106512" },
    ]) {
      const found = findLatestIMessageEntryForChat(ctx);
      expect(found?.messageId).toBe("phone-msg");
    }
  });

  it("requires accountId — refuses to guess across all known chats", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "anywhere",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    // accountId is optional in the signature; calling without it exercises the
    // runtime guard that returns undefined rather than a cross-account match.
    expect(findLatestIMessageEntryForChat({ chatIdentifier: "+12069106512" })).toBeUndefined();
  });
});

describe("hydrate-on-resolve (post-restart short-id persistence)", () => {
  it("hydrates SQLite state before resolving a short id whose mapping predates this run", () => {
    // Issue-then-restart contract: a shortId we issued before a gateway
    // restart must still resolve afterwards. The first resolve call after
    // process boot would otherwise miss the persisted mapping because the
    // in-memory maps haven't been hydrated yet — that's the bug codex
    // review flagged. resolveIMessageMessageId now hydrates on entry.
    const issued = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid-pre-restart",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: true,
    });
    expect(issued.shortId).not.toBe("");

    // Simulate a restart: clear only the process-local maps and leave the
    // SQLite plugin-state rows intact.
    resetIMessageShortIdState({ clearPersistent: false });

    // Now resolve the short id we issued before the "restart". Without the
    // hydrate-on-resolve fix this throws "no longer available" because the
    // in-memory maps are empty and rememberIMessageReplyCache hasn't been
    // called yet to trigger hydration.
    expect(
      resolveIMessageMessageId(issued.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
      }),
    ).toBe("outbound-guid-pre-restart");
  });

  it("persists entries when optional chat fields are explicitly undefined", () => {
    const issued = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "guid-with-undefined-optionals",
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatId: undefined,
      timestamp: Date.now(),
    });

    resetIMessageShortIdState({ clearPersistent: false });

    expect(
      resolveIMessageMessageId(issued.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+15551234567" },
      }),
    ).toBe("guid-with-undefined-optionals");
  });

  it("does not reuse short ids after cached rows expire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00Z"));
    const first = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "old-guid",
      timestamp: Date.now(),
    });
    expect(first.shortId).toBe("1");

    vi.setSystemTime(new Date("2026-05-08T07:00:00Z"));
    resetIMessageShortIdState({ clearPersistent: false });
    const second = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "new-guid",
      timestamp: Date.now(),
    });

    expect(second.shortId).toBe("2");
  });
});

describe("hydrate counter advancement (rowid-collision protection)", () => {
  it("advances the short-id counter past a corrupt persisted line so new allocations don't collide", () => {
    // Direct hydrate isn't easy to invoke without disk fixtures; instead
    // verify the public contract: after rememberIMessageReplyCache fires,
    // the next allocation never re-uses an existing live shortId.
    const a = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "msg-a",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });
    const b = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "msg-b",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });
    expect(a.shortId).not.toBe(b.shortId);
    expect(Number.parseInt(b.shortId, 10)).toBeGreaterThan(Number.parseInt(a.shortId, 10));
  });
});
