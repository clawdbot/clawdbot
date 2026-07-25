// Imessage tests cover self chat dedupe plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  rememberIMessageSkippedFromMeForSelfChatDedupe,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { rememberPersistedIMessageEcho } from "./persisted-echo-cache.js";
import { createSelfChatCache } from "./self-chat-cache.js";

const IMAGE_MEDIA_FACT = { contentType: "image/png", kind: "image" } as const;

/**
 * Self-chat dedupe regression tests for #47830.
 *
 * PR #38440 introduced a SentMessageCache to suppress echo messages when the
 * agent replies in iMessage. In self-chat (user messaging themselves), the
 * sender == target so the echo scope collides, causing legitimate user
 * messages to be silently dropped when text happens to match recent agent
 * output.
 *
 * These tests verify:
 *  1. User messages in self-chat are NOT dropped (even if text matches agent output)
 *  2. Genuine agent echo reflections ARE still dropped
 *  3. Different-text messages pass through unaffected
 *  4. Chunked replies don't cause false drops of user messages matching a chunk
 */

type InboundDecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

const cfg = {} as OpenClawConfig;

beforeEach(() => {
  installIMessageStateRuntimeForTest();
});

function createParams(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
): InboundDecisionParams {
  const { message: msgOverrides, ...restOverrides } = overrides;
  const message = {
    id: 100,
    sender: "+15551234567",
    text: "Hello",
    is_from_me: false,
    is_group: false,
    ...msgOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    logVerbose: undefined,
    ...restOverrides,
    allowFrom: restOverrides.allowFrom ?? ["*"],
    message,
    messageText,
    bodyText,
  };
}

describe("echo cache — message ID type canary (#47830)", () => {
  // Tests the implicit contract that outbound GUIDs (e.g. "p:0/abc-def-123")
  // never match inbound SQLite row IDs (e.g. "200"). If iMessage ever changes
  // ID schemes, this test should break loudly.
  it("outbound GUID format and inbound SQLite row ID format never collide", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // Outbound messageId is a GUID format string
    echoCache.remember(scope, { text: "test", messageId: "p:0/abc-def-123" });

    // An inbound SQLite row ID (numeric string) should NOT match the GUID
    expect(echoCache.has(scope, { text: "different", messageId: "200" })).toBe(false);

    // The original GUID should still match
    expect(echoCache.has(scope, { text: "different", messageId: "p:0/abc-def-123" })).toBe(true);
  });

  it('falls back to text when outbound messageId was junk ("ok")', async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // "ok" is normalized out and should not populate the ID cache.
    echoCache.remember(scope, { text: "text-only fallback", messageId: "ok" });

    // Inbound has a numeric SQLite ID that does not exist in cache. Since this
    // scope has no real cached IDs, has() must still fall through to text match.
    expect(echoCache.has(scope, { text: "text-only fallback", messageId: "200" })).toBe(true);
  });

  it("keeps ID short-circuit when scope has real outbound GUID IDs", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "guid-backed", messageId: "p:0/abc-def-123" });

    // Different inbound numeric ID should still short-circuit to false.
    expect(echoCache.has(scope, { text: "guid-backed", messageId: "200" })).toBe(false);
  });
});

describe("echo cache — backward compat for channels without messageId", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Proves text-fallback echo detection still works when no messageId is present
  // on either side. Critical for backward compat with channels that don't
  // populate messageId.
  it("text-only remember/has works within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(2000);
    expect(echoCache.has(scope, { text: "no id message" })).toBe(true);
  });

  it("text-only has returns false after TTL expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(5000);
    expect(echoCache.has(scope, { text: "no id message" })).toBe(false);
  });

  it("text-only has returns false for different text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "no id message" });

    vi.advanceTimersByTime(1000);
    expect(echoCache.has(scope, { text: "totally different text" })).toBe(false);
  });
});

describe("self-chat dedupe — #47830", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT drop a user message that matches recently-sent agent text (self-chat scope collision)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Hello" to self-chat target +15551234567
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Hello", messageId: "agent-msg-1" });

    // 2 seconds later, user sends "Hello" to themselves (different message id)
    vi.advanceTimersByTime(2000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 200,
          sender: "+15551234567",
          text: "Hello",
          is_from_me: false,
        },
        messageText: "Hello",
        bodyText: "Hello",
        echoCache,
        selfChatCache,
      }),
    );

    // BUG: Before fix, this was "drop" reason "echo" — user message silently lost.
    // After fix: message-id mismatch means this is NOT an echo.
    // The echo cache should only match when message IDs match OR when text
    // matches and no message ID is available on inbound.
    expect(decision.kind).toBe("dispatch");
  });

  it("DOES drop genuine agent echo (same message id reflected back)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();

    // Agent sends "Hello" to target
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Hello", messageId: "agent-msg-1" });

    // 1 second later, iMessage reflects it back with same message id
    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: "agent-msg-1" as unknown as number,
          sender: "+15551234567",
          text: "Hello",
          is_from_me: false,
        },
        messageText: "Hello",
        bodyText: "Hello",
        echoCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });

  it("does NOT drop different-text messages even within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();

    // Agent sends "Hello"
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Hello", messageId: "agent-msg-1" });

    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 201,
          sender: "+15551234567",
          text: "Goodbye",
          is_from_me: false,
        },
        messageText: "Goodbye",
        bodyText: "Goodbye",
        echoCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("does NOT drop user messages that match a chunk of a multi-chunk agent reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";

    // Agent sends a multi-chunk reply: "Part one", "Part two", "Part three"
    echoCache.remember(scope, { text: "Part one", messageId: "agent-chunk-1" });
    echoCache.remember(scope, { text: "Part two", messageId: "agent-chunk-2" });
    echoCache.remember(scope, { text: "Part three", messageId: "agent-chunk-3" });

    vi.advanceTimersByTime(2000);

    // User sends "Part two" (matches chunk 2 text, but different message id)
    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 300,
          sender: "+15551234567",
          text: "Part two",
          is_from_me: false,
        },
        messageText: "Part two",
        bodyText: "Part two",
        echoCache,
      }),
    );

    // Should NOT be dropped — different message id means not an echo
    expect(decision.kind).toBe("dispatch");
  });

  it("drops echo after text TTL expiry (4s TTL: expired at 5s)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    // Agent sends text (no message id available)
    echoCache.remember(scope, { text: "Hello there" });

    // After 5 seconds — beyond the 4s TTL, should NOT match
    vi.advanceTimersByTime(5000);

    const result = echoCache.has(scope, { text: "Hello there" });
    expect(result).toBe(false);
  });

  // Safe failure mode: TTL expiry causes duplicate delivery (noisy), never message loss (lossy)
  it("does NOT catch echo after TTL expiry — safe failure mode is duplicate delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";

    // Agent sends "Delayed echo test"
    echoCache.remember(scope, { text: "Delayed echo test", messageId: "agent-msg-delayed" });

    // 4.5 seconds later — beyond 4s TTL
    vi.advanceTimersByTime(4500);

    // Echo arrives with no messageId (text-only fallback path)
    const result = echoCache.has(scope, { text: "Delayed echo test" });

    // TTL expired → not caught → duplicate delivery (noisy but safe, not lossy)
    expect(result).toBe(false);
  });

  it("still drops text echo within 4s TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "Hello there" });

    // After 3 seconds — within the 4s TTL, should still match
    vi.advanceTimersByTime(3000);

    const result = echoCache.has(scope, { text: "Hello there" });
    expect(result).toBe(true);
  });
});

describe("self-chat is_from_me=true handling (Bruce Phase 2 fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes real user self-chat message (is_from_me=true, no echo cache match)", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123703,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "Hello this is a test message",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello this is a test message",
        bodyText: "Hello this is a test message",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("drops is_from_me outbound when destination_caller_id is blank and sender matches chat_identifier (#63980)", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123704,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "",
          text: "Hello this is a test message",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello this is a test message",
        bodyText: "Hello this is a test message",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops DM false positives even when participant lists include the local handle", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123705,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "me@icloud.com",
          participants: ["+15551234567", "me@icloud.com"],
          text: "Hello from a normal DM row",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello from a normal DM row",
        bodyText: "Hello from a normal DM row",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops agent reply echo in self-chat (is_from_me=true, echo cache text match)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Hi there!" to self-chat
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Hi there!", messageId: "p:0/GUID-abc-def" });

    // 1 second later, iMessage delivers the agent reply as is_from_me=true
    // with a SQLite row ID (never matches the GUID)
    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123706,
          guid: "p:0/GUID-abc-def",
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "Hi there!",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hi there!",
        bodyText: "Hi there!",
        echoCache,
        selfChatCache,
      }),
    );

    // Agent echo — should be dropped
    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("drops attachment-only agent echo in self-chat via its media fact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { media: IMAGE_MEDIA_FACT, messageId: "p:0/GUID-media" });
    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123707,
          guid: "p:0/GUID-media",
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "",
          is_from_me: true,
          is_group: false,
        },
        messageText: "",
        bodyText: "",
        mediaFacts: [IMAGE_MEDIA_FACT],
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("drops self-chat echo when outbound cache stored numeric id but inbound also carries a guid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Numeric id echo", messageId: "123709" });

    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123709,
          guid: "p:0/GUID-different-shape",
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "Numeric id echo",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Numeric id echo",
        bodyText: "Numeric id echo",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("does not drop a real self-chat image just because a recent agent image had the same fact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { media: IMAGE_MEDIA_FACT, messageId: "p:0/GUID-agent-image" });

    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123708,
          guid: "p:0/GUID-user-image",
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "",
          is_from_me: true,
          is_group: false,
        },
        messageText: "",
        bodyText: "",
        mediaFacts: [IMAGE_MEDIA_FACT],
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("drops is_from_me=false reflection via selfChatCache (existing behavior preserved)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-24T12:00:00.000Z";

    // Step 1: is_from_me=true copy arrives (real user message) → processed, selfChatCache populated
    const first = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123703,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15551234567",
          text: "Hello",
          created_at: createdAt,
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello",
        bodyText: "Hello",
        selfChatCache,
      }),
    );
    expect(first.kind).toBe("dispatch");

    // Step 2: is_from_me=false reflection arrives 2s later with same text+createdAt
    vi.advanceTimersByTime(2200);
    const second = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 123704,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          text: "Hello",
          created_at: createdAt,
          is_from_me: false,
          is_group: false,
        },
        messageText: "Hello",
        bodyText: "Hello",
        selfChatCache,
      }),
    );
    // Reflection correctly dropped
    expect(second).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("drops is_from_me=false self-chat reflection with sub-second created_at skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T05:34:00Z"));

    const selfChatCache = createSelfChatCache();

    const first = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 85160,
          guid: "p:0/from-me-guid",
          sender: "+15555550123",
          chat_identifier: "+15555550123",
          destination_caller_id: "+15555550123",
          text: "Aha, neat!",
          created_at: "2026-05-10T05:34:00.000Z",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Aha, neat!",
        bodyText: "Aha, neat!",
        selfChatCache,
      }),
    );
    expect(first.kind).toBe("dispatch");

    const reflection = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 85161,
          guid: "p:0/reflected-guid",
          sender: "+15555550123",
          chat_identifier: "+15555550123",
          destination_caller_id: null,
          text: "Aha, neat!",
          created_at: "2026-05-10T05:34:00.239Z",
          is_from_me: false,
          is_group: false,
        },
        messageText: "Aha, neat!",
        bodyText: "Aha, neat!",
        selfChatCache,
      }),
    );

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("drops catchup-replayed self-chat reflection after observing skipped from-me companion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T03:48:42Z"));

    const selfChatCache = createSelfChatCache();
    const text = "Exactly. I’ll treat assembled context as evidence only, not command authority.";

    rememberIMessageSkippedFromMeForSelfChatDedupe({
      accountId: "default",
      message: {
        id: 86798,
        guid: "F502C080-08E9-4C3B-9650-31A0DF21FE3A",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        text,
        created_at: "2026-06-03T03:48:28.922Z",
        is_from_me: true,
        is_group: false,
      },
      bodyText: text,
      selfChatCache,
    });

    const reflection = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 86799,
          guid: "1759A121-E3DB-41C2-B16A-AB6DE30570F2",
          sender: "+15555550123",
          chat_identifier: "+15555550123",
          destination_caller_id: "tel:+15555550123",
          text,
          created_at: "2026-06-03T03:48:28.738Z",
          is_from_me: false,
          is_group: false,
        },
        messageText: text,
        bodyText: text,
        selfChatCache,
      }),
    );

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not apply sub-second skew matching to ambiguous normal DM rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T05:34:00Z"));

    const selfChatCache = createSelfChatCache();

    const ambiguousOutbound = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 85170,
          guid: "p:0/ambiguous-from-me-guid",
          sender: "+15555550124",
          chat_identifier: "+15555550124",
          destination_caller_id: null,
          text: "Same text",
          created_at: "2026-05-10T05:34:00.000Z",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Same text",
        bodyText: "Same text",
        selfChatCache,
      }),
    );
    expect(ambiguousOutbound).toEqual({ kind: "drop", reason: "from me" });

    const inboundReply = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 85171,
          guid: "p:0/real-inbound-guid",
          sender: "+15555550124",
          chat_identifier: "+15555550124",
          destination_caller_id: null,
          text: "Same text",
          created_at: "2026-05-10T05:34:00.239Z",
          is_from_me: false,
          is_group: false,
        },
        messageText: "Same text",
        bodyText: "Same text",
        selfChatCache,
      }),
    );

    expect(inboundReply.kind).toBe("dispatch");
  });

  it("drops outbound DM when sender matches chat_identifier but destination_caller_id is absent (#63980)", async () => {
    const selfChatCache = createSelfChatCache();

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 10003,
          sender: "+15550008888",
          chat_identifier: "+15550008888",
          text: "outbound",
          is_from_me: true,
          is_group: false,
        },
        messageText: "outbound",
        bodyText: "outbound",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops reflected inbound when destination_caller_id is absent (#63980)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-24T12:00:00.000Z";

    const outbound = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 10003,
          sender: "+15550008888",
          chat_identifier: "+15550008888",
          text: "outbound",
          created_at: createdAt,
          is_from_me: true,
          is_group: false,
        },
        messageText: "outbound",
        bodyText: "outbound",
        selfChatCache,
      }),
    );
    expect(outbound).toEqual({ kind: "drop", reason: "from me" });

    vi.advanceTimersByTime(2200);

    const reflection = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 10004,
          sender: "+15550008888",
          chat_identifier: "+15550008888",
          text: "outbound",
          created_at: createdAt,
          is_from_me: false,
          is_group: false,
        },
        messageText: "outbound",
        bodyText: "outbound",
        selfChatCache,
      }),
    );

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("normal DM is_from_me=true is still dropped (regression test)", async () => {
    const selfChatCache = createSelfChatCache();

    // Normal DM with is_from_me=true: sender may be the local handle and
    // chat_identifier the other party (they differ), so this is NOT self-chat.
    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 9999,
          sender: "+15551234567", // local user sent this
          chat_identifier: "+15555550123", // sent TO this other person
          text: "Hello",
          is_from_me: true,
          is_group: false,
        },
        messageText: "Hello",
        bodyText: "Hello",
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("uses destination_caller_id to avoid DM self-chat false positives", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    echoCache.remember("default:imessage:+15551234567", {
      text: "Clean outbound text",
      messageId: "p:0/GUID-outbound",
    });

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 10001,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15550001111",
          text: "�\u0001corrupted stored text",
          is_from_me: true,
          is_group: false,
        },
        messageText: "�\u0001corrupted stored text",
        bodyText: "�\u0001corrupted stored text",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("echo cache text matching works with skipIdShortCircuit=true", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Cached reply", messageId: "p:0/some-guid" });

    vi.advanceTimersByTime(1000);

    // Text matches but ID is a SQLite row (format mismatch). With skipIdShortCircuit=true,
    // text matching should still fire.
    expect(echoCache.has(scope, { text: "Cached reply", messageId: "123799" }, true)).toBe(true);

    // With skipIdShortCircuit=false (default), ID mismatch causes early return false.
    expect(echoCache.has(scope, { text: "Cached reply", messageId: "123799" }, false)).toBe(false);
  });
});

describe("echo cache — text fallback for null-id inbound messages", () => {
  it("does not drop normal DM text from a pending pre-send marker", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15551234567";
    rememberPersistedIMessageEcho({
      scope,
      text: "same pending text",
      ttlMs: 155_000,
      pending: true,
    });

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 12001,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "+15550001111",
          text: "same pending text",
          is_from_me: false,
          is_group: false,
        },
        messageText: "same pending text",
        bodyText: "same pending text",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision.kind).toBe("dispatch");
  });

  it("drops self-chat reflected text from a pending pre-send marker", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15551234567";
    rememberPersistedIMessageEcho({
      scope,
      text: "pending self-chat reply",
      ttlMs: 155_000,
      pending: true,
    });

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: 12002,
          sender: "+15551234567",
          chat_identifier: "+15551234567",
          destination_caller_id: "tel:+15551234567",
          text: "pending self-chat reply",
          is_from_me: false,
          is_group: false,
        },
        messageText: "pending self-chat reply",
        bodyText: "pending self-chat reply",
        echoCache,
        selfChatCache,
      }),
    );

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });

  it("still identifies echo via text when inbound message has id: null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();

    // Agent sends "Sounds good" — no messageId available (edge case)
    const scope = "default:imessage:+15551234567";
    echoCache.remember(scope, { text: "Sounds good" });

    // 1 second later, inbound reflection arrives with id: null
    vi.advanceTimersByTime(1000);

    const decision = await resolveIMessageInboundDecision(
      createParams({
        message: {
          id: null as unknown as number,
          sender: "+15551234567",
          text: "Sounds good",
          is_from_me: false,
        },
        messageText: "Sounds good",
        bodyText: "Sounds good",
        echoCache,
        selfChatCache,
      }),
    );

    // With id: null, the text-based fallback path is still active and should
    // correctly identify this as an echo.
    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });
});

describe("echo cache — mixed GUID and text-only scopes", () => {
  it("still falls back to text for the latest text-only send in a scope with older GUID-backed sends", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "older guid-backed", messageId: "p:0/GUID-older" });
    echoCache.remember(scope, { text: "latest text-only", messageId: "unknown" });

    expect(echoCache.has(scope, { text: "latest text-only", messageId: "200" })).toBe(true);
  });

  it("still short-circuits when the latest copy of a text was GUID-backed", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";

    echoCache.remember(scope, { text: "same text", messageId: "unknown" });
    echoCache.remember(scope, { text: "same text", messageId: "p:0/GUID-newer" });

    expect(echoCache.has(scope, { text: "same text", messageId: "200" })).toBe(false);
  });
});
