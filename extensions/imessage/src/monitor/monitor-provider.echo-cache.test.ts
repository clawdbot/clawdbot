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
  resetPersistedIMessageEchoCacheForTest,
  resolveIMessageSentEchoEntryKey,
} from "./persisted-echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    resetPersistedIMessageEchoCacheForTest();
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

    resetPersistedIMessageEchoCacheForTest({ clearPersistent: false });
    const cache = createSentMessageCache();

    expect(cache.has(scope, { text: "text-only" })).toBe(true);
    expect(cache.has(scope, { messageId: "id-only" })).toBe(true);
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

  it("retains entries written hours earlier so catchup replay sees own outbound rows", () => {
    // Catchup's default maxAgeMinutes is 120 (2h). The persisted-echo TTL must
    // be >= that window, otherwise the agent's own outbound rows from before
    // a gateway gap fall out of dedupe before catchup re-feeds the inbound
    // rows around them — and the agent's replies to itself land back in the
    // inbound pipeline as if they were external sends. Regression guard for
    // the echo-cache retention extension that ships with #78649.
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
