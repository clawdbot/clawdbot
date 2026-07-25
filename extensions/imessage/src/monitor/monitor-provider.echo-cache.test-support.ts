// Imessage test support covers monitor provider.echo cache plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIMessagePluginStateSyncStoreForTest,
  installIMessageFailingStateRuntimeForTest,
  installIMessageStateRuntimeForTest,
} from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
  IMESSAGE_SENT_ECHOES_NAMESPACE,
  IMESSAGE_SENT_ECHOES_TTL_MS,
  hasPersistedIMessageEcho,
  rememberPersistedIMessageEcho,
  resolveIMessageSentEchoEntryKey,
} from "./persisted-echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches delayed reflected echoes with leading attributedBody corruption markers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      cache.has("acct:imessage:+1555", {
        text: "\uFFFD\uFFFE\uFFFF\uFEFFDelayed echo reply",
      }),
    ).toBe(true);
  });

  it("matches delayed reflected echoes with leading NUL corruption markers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      cache.has("acct:imessage:+1555", {
        text: "\u0000\u0000Delayed echo reply",
      }),
    ).toBe(true);
  });

  it("keeps attributedBody corruption cleanup leading-only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(
      cache.has("acct:imessage:+1555", {
        text: "Delayed \uFFFD echo reply",
      }),
    ).toBe(false);
    expect(cache.has("acct:imessage:+1555", { text: "Delayed\techo reply" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { text: "Delayed\necho reply" })).toBe(false);
  });

  it("keeps NUL corruption cleanup leading-only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "Delayed echo reply" });

    expect(cache.has("acct:imessage:+1555", { text: "Delayed\u0000echo reply" })).toBe(false);
  });

  it("matches a delayed reflected echo with leading corruption markers via the persisted cache", () => {
    // The persisted 12h cache is the only matcher once the 4s in-memory text TTL expires, so it
    // must strip leading attributedBody corruption markers exactly like the in-memory key (#93511).
    const scope = "acct:imessage:+1555";
    const markers = String.fromCharCode(0x0000, 0xfffd, 0xfffe, 0xffff, 0xfeff);
    rememberPersistedIMessageEcho({ scope, text: "Delayed echo reply" });

    expect(hasPersistedIMessageEcho({ scope, text: "Delayed echo reply" })).toBe(true);
    expect(hasPersistedIMessageEcho({ scope, text: `${markers}Delayed echo reply` })).toBe(true);
    // Leading-only: a mid-string marker stays distinct.
    expect(
      hasPersistedIMessageEcho({ scope, text: `Delayed${String.fromCharCode(0x0000)}echo reply` }),
    ).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    // Text fallback stays short to avoid suppressing legitimate repeated user text.
    vi.advanceTimersByTime(6_000);

    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });

  it("matches persisted echoes written before the monitor cache is created", () => {
    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "OpenClaw imsg live test",
      messageId: "guid-1",
    });
    const cache = createSentMessageCache();

    expect(cache.has("acct:imessage:+1555", { text: "OpenClaw imsg live test" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "OpenClaw imsg live test" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "guid-1" })).toBe(true);
  });

  it("persists text-only and id-only echoes without undefined fields", () => {
    const scope = "acct:imessage:+1555";
    rememberPersistedIMessageEcho({ scope, text: "text-only" });
    rememberPersistedIMessageEcho({ scope, messageId: "id-only" });

    const cache = createSentMessageCache();

    expect(cache.has(scope, { text: "text-only" })).toBe(true);
    expect(cache.has(scope, { messageId: "id-only" })).toBe(true);
  });

  it("does not match persisted media when both message ids differ", () => {
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    rememberPersistedIMessageEcho({ scope, media, messageId: "guid-agent-image" });

    expect(hasPersistedIMessageEcho({ scope, media, messageId: "guid-user-image" })).toBe(false);
    expect(
      hasPersistedIMessageEcho({
        scope,
        media: { contentType: "image/jpeg", kind: "image" },
      }),
    ).toBe(true);
  });

  it("matches persisted media through the primary sent-message cache", () => {
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    rememberPersistedIMessageEcho({ scope, media, pending: true });

    const cache = createSentMessageCache();
    expect(cache.has(scope, { media })).toBe(false);
    expect(cache.has(scope, { media }, { includePendingText: true })).toBe(true);
  });

  it("does not use id-backed in-memory media after a different message id", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";
    const media = { contentType: "image/png", kind: "image" as const };
    const cache = createSentMessageCache();
    cache.remember(scope, { media, messageId: "guid-agent-image" });

    expect(
      cache.has(scope, { media, messageId: "guid-user-image" }, { skipIdShortCircuit: true }),
    ).toBe(false);
    vi.advanceTimersByTime(1);
    cache.remember(scope, { media });
    expect(
      cache.has(scope, { media, messageId: "guid-user-image" }, { skipIdShortCircuit: true }),
    ).toBe(true);
  });

  it("keeps short-lived pending persisted echoes out of generic text matching", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";

    rememberPersistedIMessageEcho({ scope, text: "pending-send", ttlMs: 1_000, pending: true });
    expect(hasPersistedIMessageEcho({ scope, text: "pending-send" })).toBe(false);
    expect(
      hasPersistedIMessageEcho({ scope, text: "pending-send", includePendingText: true }),
    ).toBe(true);

    vi.advanceTimersByTime(1_001);
    expect(
      hasPersistedIMessageEcho({ scope, text: "pending-send", includePendingText: true }),
    ).toBe(false);
  });

  it("refreshes persisted echoes written after an earlier empty lookup", () => {
    const cache = createSentMessageCache();
    const scope = "acct:imessage:+1555";
    expect(cache.has(scope, { messageId: "guid-late" })).toBe(false);

    const entry = { scope, messageId: "guid-late", timestamp: Date.now() };
    createIMessagePluginStateSyncStoreForTest({
      namespace: IMESSAGE_SENT_ECHOES_NAMESPACE,
      maxEntries: IMESSAGE_SENT_ECHOES_MAX_ENTRIES,
    }).register(resolveIMessageSentEchoEntryKey(entry), entry, {
      ttlMs: IMESSAGE_SENT_ECHOES_TTL_MS,
    });

    expect(cache.has(scope, { messageId: "guid-late" })).toBe(true);
  });

  it("drops the in-memory mirror on persisted read failure so expired echoes do not match", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const scope = "acct:imessage:+1555";

    rememberPersistedIMessageEcho({ scope, text: "stale echo" });
    expect(hasPersistedIMessageEcho({ scope, text: "stale echo" })).toBe(true);

    vi.advanceTimersByTime(IMESSAGE_SENT_ECHOES_TTL_MS + 1);
    installIMessageFailingStateRuntimeForTest();

    expect(hasPersistedIMessageEcho({ scope, text: "stale echo" })).toBe(false);
  });

  it("retains entries written hours earlier so a reconnect re-emit still sees own outbound rows", () => {
    // The persisted-echo TTL must outlive the inbound replay guard window so
    // an own-outbound row that imsg re-emits after a bridge reconnect is still
    // recognized as the agent's echo, not re-ingested as an external send.
    // Regression guard for the echo-cache retention window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    rememberPersistedIMessageEcho({
      scope: "acct:imessage:+1555",
      text: "agent reply from before the gap",
      messageId: "guid-pre-gap",
    });

    // Advance 3 hours — past the legacy 2-min TTL but well within the 12 h
    // retention required by the maxAgeMinutes=720 clamp.
    vi.setSystemTime(new Date("2026-05-08T15:00:00Z"));
    const cache = createSentMessageCache();
    expect(cache.has("acct:imessage:+1555", { text: "agent reply from before the gap" })).toBe(
      true,
    );
    expect(cache.has("acct:imessage:+1555", { messageId: "guid-pre-gap" })).toBe(true);
  });
});
