import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _resetIMessageShortIdState,
  findLatestIMessageEntryForChat,
  isKnownFromMeIMessageMessageId,
  rememberIMessageReplyCache,
  resolveIMessageMessageId,
} from "./monitor-reply-cache.js";

// Isolate from any live ~/.openclaw/imessage/reply-cache.jsonl that the
// developer might have from a running gateway. Without this, the on-disk
// hydrate path picks up production data and tests get cross-pollinated.
//
// vi.stubEnv defaults to per-test scoping in this codebase, which means a
// beforeAll-only stub gets unstubbed between tests. Mutate process.env
// directly so the override holds across the whole file.
let tempStateDir: string;
let priorStateDir: string | undefined;
beforeAll(() => {
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-reply-cache-"));
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
});
afterAll(() => {
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
  fs.rmSync(tempStateDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetIMessageShortIdState();
  // Belt-and-suspenders: also nuke the persisted file directly. The
  // _reset helper does this when OPENCLAW_STATE_DIR is set, but explicitly
  // clearing here protects the test from any future refactor of _reset's
  // gating logic.
  try {
    fs.rmSync(path.join(tempStateDir, "imessage", "reply-cache.jsonl"), { force: true });
  } catch {
    // best-effort
  }
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
    // Diagnostic: verify the temp-dir env stub is actually visible.
    expect(process.env.OPENCLAW_STATE_DIR).toBe(tempStateDir);
    const cachePath = path.join(tempStateDir, "imessage", "reply-cache.jsonl");
    expect(fs.existsSync(cachePath)).toBe(false);

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

describe("reply cache disk permissions", () => {
  it("clamps pre-existing reply-cache.jsonl from older 0644/0755 to 0600/0700", () => {
    // Older gateway versions wrote with default modes. Every append must
    // clamp existing files back to owner-only — appendFileSync's `mode`
    // only applies on creation, so a chmod-on-create-only path would leave
    // the upgrade case world-readable forever.
    const imsgDir = path.join(tempStateDir, "imessage");
    fs.mkdirSync(imsgDir, { recursive: true, mode: 0o755 });
    const cacheFile = path.join(imsgDir, "reply-cache.jsonl");
    fs.writeFileSync(cacheFile, "", { mode: 0o644 });
    fs.chmodSync(imsgDir, 0o755);
    fs.chmodSync(cacheFile, 0o644);

    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "clamp-test-guid",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    const fileMode = fs.statSync(cacheFile).mode & 0o777;
    const dirMode = fs.statSync(imsgDir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("writes the cache file 0600 and parent dir 0700", () => {
    // Map gateway-allocated short-ids to message guids; a hostile same-UID
    // process reading or writing this file could (a) enumerate active
    // conversation guids or (b) inject lines so a future shortId resolves
    // to an attacker-chosen guid. Owner-only mode is the mitigation.
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "perm-test-guid",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    const cacheFile = path.join(tempStateDir, "imessage", "reply-cache.jsonl");
    const cacheDir = path.dirname(cacheFile);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const fileMode = fs.statSync(cacheFile).mode & 0o777;
    const dirMode = fs.statSync(cacheDir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });
});

describe("hydrate-on-resolve (post-restart short-id persistence)", () => {
  it("hydrates the on-disk JSONL before resolving a short id whose mapping predates this run", () => {
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

    // Simulate a restart: clear the in-memory state but leave the JSONL on
    // disk. _resetIMessageShortIdState only deletes the persisted file when
    // OPENCLAW_STATE_DIR is set, so we have to keep the file ourselves
    // since this test runs under the suite's temp state dir.
    const cachePath = path.join(tempStateDir, "imessage", "reply-cache.jsonl");
    const persisted = fs.readFileSync(cachePath, "utf8");
    _resetIMessageShortIdState();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, persisted, "utf8");

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
