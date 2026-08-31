import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  deliveryContextFromSession,
  getSessionEntry,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
// Matrix tests cover handler plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

// Core owns the shared gate (DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS); plugins
// cannot import it, so mirror the value here for start-boundary assertions.
const PROGRESS_DRAFT_START_DELAY_MS = 1_500;

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendTypingMatrixMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareMatrixSingleTextMock = vi.hoisted(() =>
  vi.fn((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  }),
);
const resolveMatrixMentionsForBodyMock = vi.hoisted(() =>
  vi.fn(async ({ body }: { body: string }) => {
    const userIds = Array.from(body.matchAll(/@[A-Za-z0-9._=/-]+:[^\s`<]+/g), (match) => match[0]);
    return {
      ...(body.includes("@room") ? { room: true } : {}),
      ...(userIds.length > 0 ? { user_ids: userIds } : {}),
    };
  }),
);
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: getGlobalHookRunnerMock,
  };
});

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: resolveMatrixMentionsForBodyMock,
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: sendTypingMatrixMock,
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

function waitForMatrixState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

async function writeMatrixSessionMeta(
  storePath: string,
  sessionKey: string,
  origin: {
    chatType: "direct" | "group";
    from: string;
    to: string;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
  },
): Promise<void> {
  const existing = getSessionEntry({ storePath, sessionKey }) ?? {
    sessionId: `sess-${sessionKey}`,
    updatedAt: Date.now(),
  };
  const existingOrigin = sessionDeliveryOrigin(existing) ?? {};
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      ...existing,
      delivery: normalizeSessionDeliveryState({
        context: deliveryContextFromSession(existing),
        origin: {
          ...existingOrigin,
          provider: "matrix",
          surface: "matrix",
          accountId: "ops",
          ...origin,
        },
      }),
    },
  });
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(null);
  prepareMatrixSingleTextMock.mockReset().mockImplementation((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  });
  resolveMatrixMentionsForBodyMock.mockClear();
  sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "evt", roomId: "!room" });
  sendTypingMatrixMock.mockReset().mockResolvedValue(undefined);
  deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
});

afterEach(() => {
  vi.useRealTimers();
});

function createReactionHarness(params?: {
  cfg?: unknown;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  storeAllowFrom?: string[];
  targetSender?: string;
  isDirectMessage?: boolean;
  senderName?: string;
  client?: NonNullable<Parameters<typeof createMatrixHandlerTestHarness>[0]>["client"];
}) {
  return createMatrixHandlerTestHarness({
    cfg: params?.cfg,
    dmPolicy: params?.dmPolicy,
    allowFrom: params?.allowFrom,
    readAllowFromStore: vi.fn(async () => params?.storeAllowFrom ?? []),
    client: {
      getEvent: async () => ({ sender: params?.targetSender ?? "@bot:example.org" }),
      ...params?.client,
    },
    isDirectMessage: params?.isDirectMessage,
    getMemberDisplayName: async () => params?.senderName ?? "sender",
  });
}

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function mockCalls(mock: unknown, label: string): Array<Array<unknown>> {
  const mockState = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock;
  if (!mockState) {
    throw new Error(`${label}.mock was missing`);
  }
  const calls = mockState.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`${label}.mock.calls was not an array`);
  }
  return calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const call = mockCalls(mock, label).at(callIndex);
  if (!call) {
    throw new Error(`${label} call ${callIndex} was missing`);
  }
  return call[argIndex];
}

function lastCallArg(mock: unknown, argIndex: number, label: string) {
  const calls = mockCalls(mock, label);
  return callArg(mock, calls.length - 1, argIndex, label);
}

function singleTextMessageBody(callIndex = 0) {
  return callArg(sendSingleTextMessageMatrixMock, callIndex, 1, "single text message body");
}

function expectMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const matched = mockCalls(mock, "mock calls").some(([value]) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => Object.is(record[key], expected));
  });
  expect(matched).toBe(true);
}

function expectNoticeSent(mock: unknown) {
  const message = requireRecord(callArg(mock, 0, 1, "notice content"), "notice content");
  expect(message.msgtype).toBe("m.notice");
  expect(String(message.body)).toContain("channels.matrix.dm.sessionScope");
}

function expectRuntimeErrorContaining(mock: unknown, text: string) {
  const matched = mockCalls(mock, "runtime error").some(([message]) =>
    String(message).includes(text),
  );
  expect(matched).toBe(true);
}

function findMockCall(mock: unknown, label: string, predicate: (call: Array<unknown>) => boolean) {
  const call = mockCalls(mock, label).find(predicate);
  if (!call) {
    throw new Error(`${label} was missing`);
  }
  return call;
}

function expectMatrixEdit(roomId: string, eventId: string, body: string) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit call for ${eventId}`,
    ([room, editedEventId, editedBody]) =>
      room === roomId && editedEventId === eventId && editedBody === body,
  );
  requireRecord(call[3], "edit options");
}

function expectFinalizedPreviewEdit(eventId: string, text: string) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit call for ${eventId}`,
    ([room, editedEventId, body]) =>
      room === "!room:example.org" && editedEventId === eventId && body === text,
  );
  const options = requireRecord(call[3], "edit options");
  expect(options.extraContent).toEqual({ [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true });
}

function expectEditLiveFlag(eventId: string, text: string, expected: boolean | undefined) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit live flag call for ${eventId}`,
    ([room, editedEventId, body]) =>
      room === "!room:example.org" && editedEventId === eventId && body === text,
  );
  const options = requireRecord(call[3], "edit options");
  if (expected === undefined) {
    expect(Object.hasOwn(options, "live")).toBe(false);
  } else {
    expect(options.live).toBe(expected);
  }
}

function expectDeliveredMediaReply() {
  const payload = requireRecord(
    lastCallArg(deliverMatrixRepliesMock, 0, "deliver replies payload"),
    "deliver replies payload",
  );
  const replies = requireArray(payload.replies, "deliver replies");
  const reply = requireRecord(replies[0], "media reply");
  expect(reply.mediaUrl).toBe("https://example.com/image.png");
  expect(reply.text).toBeUndefined();
}

function createMockMatrixDeliveryResult(messageId = "$reply1", content = "delivered") {
  return {
    messageIds: [messageId],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content,
  };
}

describe("matrix monitor handler pairing account scope", () => {
  it("keeps inbound log previews UTF-16 well-formed at the limit", async () => {
    const logVerboseMessage = vi.fn();
    const { handler } = createMatrixHandlerTestHarness({ logVerboseMessage });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event-preview",
        body: `${"x".repeat(199)}🚀tail`,
      }),
    );

    expect(logVerboseMessage).toHaveBeenCalledWith(
      `matrix inbound: room=!room:example.org from=@user:example.org preview="${"x".repeat(199)}"`,
    );
  });

  it("logs final delivery from the settled receipt instead of legacy counters", async () => {
    const logVerboseMessage = vi.fn();
    const { handler } = createMatrixHandlerTestHarness({
      logVerboseMessage,
      dispatchInboundMessage: async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
        settledReceipt: {
          anyVisibleDelivered: true,
          counts: {
            tool: {
              delivered: 0,
              deliveredNotVisible: 0,
              cancelled: 0,
              failedBeforeSend: 0,
              failedAfterSend: 0,
            },
            block: {
              delivered: 0,
              deliveredNotVisible: 0,
              cancelled: 0,
              failedBeforeSend: 0,
              failedAfterSend: 0,
            },
            final: {
              delivered: 1,
              deliveredNotVisible: 0,
              cancelled: 0,
              failedBeforeSend: 0,
              failedAfterSend: 0,
            },
          },
        },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$settled-final",
        body: "hello",
      }),
    );

    expect(logVerboseMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^matrix: delivered 1 reply to /),
    );
  });

  it("caches account-scoped allowFrom store reads on hot path", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    sendMessageMatrixMock.mockClear();

    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      dmPolicy: "pairing",
      buildPairingReply: () => "pairing",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event1",
        body: "@room hello",
        mentions: { room: true },
      }),
    );

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event2",
        body: "@room hello again",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
  });

  it("refreshes the account-scoped allowFrom cache after its ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      const { handler } = createMatrixHandlerTestHarness({
        readAllowFromStore,
        dmPolicy: "pairing",
        buildPairingReply: () => "pairing",
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          eventId: id,
          body: "@room hello",
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(readAllowFromStore).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_001);
      await handler("!room:example.org", makeEvent("$event3"));

      expect(readAllowFromStore).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse account-scoped allowFrom cache while the process clock is invalid", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const nowSpy = vi.spyOn(Date, "now");
    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      dmPolicy: "pairing",
      buildPairingReply: () => "pairing",
    });
    const makeEvent = (id: string): MatrixRawEvent =>
      createMatrixTextMessageEvent({
        eventId: id,
        body: "@room hello",
        mentions: { room: true },
      });

    try {
      nowSpy.mockReturnValue(Number.NaN);
      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));

      expect(readAllowFromStore).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not cache account-scoped allowFrom reads when cache expiry overflows", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const nowSpy = vi.spyOn(Date, "now");
    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      dmPolicy: "pairing",
      buildPairingReply: () => "pairing",
    });
    const makeEvent = (id: string): MatrixRawEvent =>
      createMatrixTextMessageEvent({
        eventId: id,
        body: "@room hello",
        mentions: { room: true },
      });

    try {
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));

      expect(readAllowFromStore).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("pins direct-message main route updates to the configured owner", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      cfg: {
        channels: {
          matrix: {
            dm: { allowFrom: ["@owner:example.org"] },
          },
        },
      },
      dmPolicy: "allowlist",
      allowFrom: ["@owner:example.org"],
      allowFromResolvedEntries: [{ input: "@owner:example.org", id: "@owner:example.org" }],
      isDirectMessage: true,
    });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        eventId: "$owner-dm",
        sender: "@owner:example.org",
        body: "hello",
      }),
    );

    const inbound = requireRecord(
      callArg(recordInboundSession, 0, 0, "record inbound session"),
      "record inbound session",
    );
    const route = requireRecord(inbound.updateLastRoute, "last route update");
    expect(route.channel).toBe("matrix");
    expect(route.to).toBe("room:!dm:example.org");
    const ownerPin = requireRecord(route.mainDmOwnerPin, "main DM owner pin");
    expect(ownerPin.ownerRecipient).toBe("@owner:example.org");
    expect(ownerPin.senderRecipient).toBe("@owner:example.org");
  });

  it("uses live dmScope when deciding whether to pin main DM route updates", async () => {
    const startupCfg = {
      session: { dmScope: "main" },
      channels: {
        matrix: {
          dm: { allowFrom: ["@owner:example.org"] },
        },
      },
    };
    const liveCfg = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        matrix: {
          dm: { allowFrom: ["@owner:example.org"] },
        },
      },
    };
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      cfg: startupCfg,
      liveCfg,
      dmPolicy: "allowlist",
      allowFrom: ["@owner:example.org"],
      allowFromResolvedEntries: [{ input: "@owner:example.org", id: "@owner:example.org" }],
      isDirectMessage: true,
    });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        eventId: "$owner-dm-live-scope",
        sender: "@owner:example.org",
        body: "hello",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const inbound = requireRecord(
      callArg(recordInboundSession, 0, 0, "record inbound session"),
      "record inbound session",
    );
    const route = requireRecord(inbound.updateLastRoute, "last route update");
    expect(route.channel).toBe("matrix");
    expect(route.to).toBe("room:!dm:example.org");
    expect(route.mainDmOwnerPin).toBeUndefined();
  });

  it("sends pairing reminders for pending requests with cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      sendMessageMatrixMock.mockClear();

      const { handler } = createMatrixHandlerTestHarness({
        readAllowFromStore,
        dmPolicy: "pairing",
        buildPairingReply: () => "Pairing code: ABCDEFGH",
        isDirectMessage: true,
        getMemberDisplayName: async () => "sender",
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          eventId: id,
          body: "hello",
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
      const pairingReminder = callArg(sendMessageMatrixMock, 0, 1, "pairing reminder");
      expect(typeof pairingReminder).toBe("string");
      expect(pairingReminder).toContain("Pairing request is still pending approval.");

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await handler("!room:example.org", makeEvent("$event3"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses account-scoped pairing store reads and upserts for dm pairing", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "ABCDEFGH", created: false }));

    const { handler } = createMatrixHandlerTestHarness({
      readAllowFromStore,
      upsertPairingRequest,
      dmPolicy: "pairing",
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
      dropPreStartupMessages: true,
      needsRoomAliasesForConfig: false,
      dispatchInboundMessage: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event1",
        body: "hello",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "matrix",
      env: process.env,
      accountId: "ops",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "matrix",
      id: "@user:example.org",
      accountId: "ops",
      meta: { name: "sender" },
    });
  });

  it("passes accountId into route resolution for inbound dm messages", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));

    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event2",
        body: "hello",
        mentions: { room: true },
      }),
    );

    expectMockCallWithFields(resolveAgentRoute, { channel: "matrix", accountId: "ops" });
  });

  it("does not enqueue delivered text messages into system events", async () => {
    const dispatchInboundMessage = vi.fn(async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }));
    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      dispatchInboundMessage,
      isDirectMessage: true,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$event-system-preview",
        body: "hello from matrix",
        mentions: { room: true },
      }),
    );

    expect(dispatchInboundMessage).toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      accountConfig: { botLoopProtection: { windowSeconds: 120, cooldownSeconds: 240 } },
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": {
          requireMention: false,
          botLoopProtection: { maxEventsPerWindow: 3 },
        },
      },
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-on",
        sender: "@ops:example.org",
        body: "hello from bot",
        originServerTs: 123_456,
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload.GroupRequireMention).toBe(false);
    expect(runPrepared.mock.calls[0]?.[0].botLoopProtection).toEqual({
      scopeId: "ops",
      conversationId: "!room:example.org",
      senderId: "@ops:example.org",
      receiverId: "@bot:example.org",
      config: { maxEventsPerWindow: 3, windowSeconds: 120, cooldownSeconds: 240 },
      defaultsConfig: undefined,
      defaultEnabled: true,
      nowMs: 123_456,
    });
  });

  it.each<{
    name: string;
    eventId: string;
    sender: string;
    body: string;
    accepted: boolean;
    accountAllowBots?: boolean | "mentions";
    mentions?: { user_ids: string[] };
    roomAllowBots?: boolean;
    isDirectMessage?: boolean;
    verifyRoute?: boolean;
  }>([
    {
      name: "drops room messages from configured Matrix bot accounts when allowBots is off",
      eventId: "$bot-off",
      sender: "@ops:example.org",
      body: "hello from bot",
      accepted: false,
    },
    {
      name: "does not treat unconfigured Matrix users as bots when allowBots is off",
      eventId: "$non-bot",
      sender: "@alice:example.org",
      body: "hello from human",
      accepted: true,
      verifyRoute: true,
    },
    {
      name: 'drops configured Matrix bot room messages without a mention when allowBots="mentions"',
      eventId: "$bot-mentions-off",
      sender: "@ops:example.org",
      body: "hello from bot",
      accountAllowBots: "mentions" as const,
      accepted: false,
    },
    {
      name: 'accepts configured Matrix bot room messages with a mention when allowBots="mentions"',
      eventId: "$bot-mentions-on",
      sender: "@ops:example.org",
      body: "hello @bot",
      mentions: { user_ids: ["@bot:example.org"] },
      accountAllowBots: "mentions" as const,
      accepted: true,
    },
    {
      name: 'accepts configured Matrix bot DMs without a mention when allowBots="mentions"',
      eventId: "$bot-dm-mentions",
      sender: "@ops:example.org",
      body: "hello from dm bot",
      accountAllowBots: "mentions" as const,
      isDirectMessage: true,
      accepted: true,
    },
    {
      name: "lets room-level allowBots override a permissive account default",
      eventId: "$bot-room-override",
      sender: "@ops:example.org",
      body: "hello from bot",
      accountAllowBots: true,
      roomAllowBots: false,
      accepted: false,
    },
  ])("$name", async (scenario) => {
    const isDirectMessage = scenario.isDirectMessage ?? false;
    const roomId = isDirectMessage ? "!dm:example.org" : "!room:example.org";
    const { handler, resolveAgentRoute, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage,
      ...(scenario.accountAllowBots === undefined
        ? {}
        : { accountAllowBots: scenario.accountAllowBots }),
      configuredBotUserIds: new Set(["@ops:example.org"]),
      ...(isDirectMessage
        ? {}
        : {
            roomsConfig: {
              "!room:example.org": {
                requireMention: false,
                ...(scenario.roomAllowBots === undefined
                  ? {}
                  : { allowBots: scenario.roomAllowBots }),
              },
            },
          }),
      ...(scenario.accountAllowBots === "mentions" && !isDirectMessage
        ? { mentionRegexes: [/@bot/i] }
        : {}),
      getMemberDisplayName: async () => (scenario.verifyRoute ? "human" : "ops-bot"),
    });

    await handler(
      roomId,
      createMatrixTextMessageEvent({
        eventId: scenario.eventId,
        sender: scenario.sender,
        body: scenario.body,
        ...(scenario.mentions ? { mentions: scenario.mentions } : {}),
      }),
    );

    if (scenario.accepted) {
      expect(recordInboundSession).toHaveBeenCalled();
      if (scenario.verifyRoute) {
        expect(resolveAgentRoute).toHaveBeenCalled();
      }
      return;
    }
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("blocks room control commands from DM-only paired senders", async () => {
    const readAllowFromStore = vi.fn(async () => ["@user:example.org"]);
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        isDirectMessage: false,
        readAllowFromStore,
        roomsConfig: {
          "!room:example.org": { requireMention: false },
        },
        shouldHandleTextCommands: () => true,
        hasControlCommand: () => true,
        cfg: {
          commands: {
            useAccessGroups: true,
          },
        },
        getMemberDisplayName: async () => "sender",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$dm-only-room-command",
        body: "/config",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(finalizeInboundContext).not.toHaveBeenCalled();
    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("blocks room control commands from configured DM-only senders", async () => {
    const hasControlCommand = vi.fn((text?: string) => text === "/new");
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        isDirectMessage: false,
        roomsConfig: {
          "!room:example.org": { requireMention: false },
        },
        shouldHandleTextCommands: () => true,
        hasControlCommand,
        cfg: {
          commands: {
            useAccessGroups: true,
          },
          channels: {
            matrix: {
              dm: { allowFrom: ["@observer:example.org"] },
              groupAllowFrom: ["@driver:example.org"],
            },
          },
        },
        groupPolicy: "open",
        getMemberDisplayName: async () => "observer",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$dm-configured-room-command",
        sender: "@observer:example.org",
        body: "@bot:example.org /new",
      }),
    );

    expect(callArg(hasControlCommand, 0, 0, "control command")).toBe("/new");
    requireRecord(callArg(hasControlCommand, 0, 1, "control command"), "control command context");
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(finalizeInboundContext).not.toHaveBeenCalled();
  });

  it("strips the Matrix self user id before room slash command detection", async () => {
    const hasControlCommand = vi.fn((text?: string) => text === "/new");
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        isDirectMessage: false,
        groupAllowFrom: ["@user:example.org"],
        mentionRegexes: [],
        shouldHandleTextCommands: () => true,
        hasControlCommand,
        getMemberDisplayName: async () => "sender",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$mxid-command",
        body: "@bot:example.org /new",
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(callArg(hasControlCommand, 0, 0, "control command")).toBe("/new");
    requireRecord(callArg(hasControlCommand, 0, 1, "control command"), "control command context");
    expect(finalizeInboundContext).not.toHaveBeenCalled();
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it.each([
    { body: "hello", isControlCommand: false, expectedDispatches: 0 },
    { body: "/new", isControlCommand: true, expectedDispatches: 1 },
  ])(
    "keeps require-mention decision for unmentioned room text $body",
    async ({ body, isControlCommand, expectedDispatches }) => {
      const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
        cfg: { channels: { matrix: { groupAllowFrom: ["@user:example.org"] } } },
        isDirectMessage: false,
        groupAllowFrom: ["@user:example.org"],
        mentionRegexes: [],
        shouldHandleTextCommands: () => true,
        hasControlCommand: (text?: string) => isControlCommand && text === body,
        getMemberDisplayName: async () => "sender",
      });

      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({
          eventId: `$unmentioned-${isControlCommand ? "command" : "text"}`,
          body,
        }),
      );

      expect(finalizeInboundContext).toHaveBeenCalledTimes(expectedDispatches);
    },
  );

  it.each([
    { label: "full Matrix user ID", body: "hello @bot:example.org" },
    { label: "colon-delimited full Matrix user ID", body: "@bot:example.org: help" },
    { label: "Unicode-whitespace-colon-delimited full ID", body: "@bot:example.org:\u2003help" },
    { label: "localpart shorthand", body: "hello @bot" },
  ])("processes native plain-text $label without configured mention patterns", async ({ body }) => {
    const getMemberDisplayName = vi.fn(async () => "sender");
    const { handler, recordInboundSession, runPrepared } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [],
      getMemberDisplayName,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$native-plain-text-mention",
        body,
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(runPrepared.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      AccountId: "ops",
      WasMentioned: true,
    });
    expect(getMemberDisplayName).not.toHaveBeenCalledWith("!room:example.org", "@bot:example.org");
  });

  it.each([
    { label: "another homeserver", body: "hello @bot:evil.example" },
    { label: "an unexpected homeserver port", body: "@bot:example.org:8448: help" },
    { label: "an invisible full-ID command separator", body: "@bot:example.org:\ufeffhelp" },
    { label: "a room-alias full-ID command collision", body: "#@bot:example.org: help" },
    { label: "a longer Unicode localpart", body: "hello @boté" },
    { label: "a historical exclamation localpart", body: "hello @bot!evil:evil.example" },
    { label: "a historical percent localpart", body: "hello @bot%evil:evil.example" },
    { label: "an exclamation-only historical account", body: "hello @bot!" },
    { label: "a percent-only historical account", body: "hello @bot%" },
    { label: "a Markdown-only historical account", body: "hello @bot**" },
    { label: "an attached Markdown-wrapped account", body: "hello evil**@bot" },
  ])("rejects forged plain-text native mentions targeting $label", async ({ body }) => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$foreign-native-mention",
        body,
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("processes room messages mentioned via displayName in formatted_body", async () => {
    const recordInboundSession = vi.fn(async () => {});
    const { handler } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getMemberDisplayName: async () => "Tom Servo",
      recordInboundSession,
    });

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        eventId: "$display-name-mention",
        content: {
          msgtype: "m.text",
          body: "Tom Servo: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:example.org">Tom Servo</a>: hello',
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("processes room messages mentioned via @displayName in Unicode formatted_body", async () => {
    const recordInboundSession = vi.fn(async () => {});
    const { handler } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getMemberDisplayName: async () => "欢欢",
      recordInboundSession,
    });

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        eventId: "$unicode-display-name-mention",
        content: {
          msgtype: "m.text",
          body: "@欢欢 please reply",
          formatted_body: '<a href="https://matrix.to/#/@bot:example.org">@欢欢</a> please reply',
          "m.mentions": { user_ids: ["@bot:example.org"] },
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("processes room messages mentioned via bracketed @displayName in formatted_body", async () => {
    const recordInboundSession = vi.fn(async () => {});
    const { handler } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getMemberDisplayName: async () => "Display Name",
      recordInboundSession,
    });

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        eventId: "$bracketed-display-name-mention",
        content: {
          msgtype: "m.text",
          body: "@[Display Name] please reply",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:example.org">@[Display Name]</a> please reply',
          "m.mentions": { user_ids: ["@bot:example.org"] },
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("does not fetch self displayName for plain-text room mentions", async () => {
    const getMemberDisplayName = vi.fn(async () => "Tom Servo");
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [/\btom servo\b/i],
      getMemberDisplayName,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$plain-text-mention",
        body: "Tom Servo: hello",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalledWith("!room:example.org", "@bot:example.org");
  });

  it("drops forged metadata-only mentions before session recording", async () => {
    const { handler, recordInboundSession, resolveAgentRoute } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$spoofed-mention",
        body: "hello there",
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });

  it("drops root events that carry a bundled replacement relation", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$edited-root",
        body: "@bot please reply",
        mentions: { user_ids: ["@bot:example.org"] },
        unsigned: {
          "m.relations": {
            "m.replace": {
              event_id: "$edit",
            },
          },
        },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("skips media downloads for unmentioned group media messages", async () => {
    const downloadContent = vi.fn(async () => Buffer.from("image"));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        downloadContent,
      },
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName,
      getRoomInfo,
    });

    await handler("!room:example.org", {
      type: EventType.RoomMessage,
      sender: "@user:example.org",
      event_id: "$media1",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.image",
        body: "",
        url: "mxc://example.org/media",
        info: {
          mimetype: "image/png",
          size: 5,
        },
      },
    } as MatrixRawEvent);

    expect(downloadContent).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
  });

  it("skips poll snapshot fetches for unmentioned group poll responses", async () => {
    const getEvent = vi.fn(async () => ({
      event_id: "$poll",
      sender: "@user:example.org",
      type: "m.poll.start",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    }));
    const getRelations = vi.fn(async () => ({
      events: [],
      nextBatch: null,
      prevBatch: null,
    }));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        getEvent,
        getRelations,
      },
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      getMemberDisplayName,
      getRoomInfo,
    });

    await handler("!room:example.org", {
      type: "m.poll.response",
      sender: "@user:example.org",
      event_id: "$poll-response-1",
      origin_server_ts: Date.now(),
      content: {
        "m.poll.response": {
          answers: ["a1"],
        },
        "m.relates_to": {
          rel_type: "m.reference",
          event_id: "$poll",
        },
      },
    } as MatrixRawEvent);

    expect(getEvent).not.toHaveBeenCalled();
    expect(getRelations).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
  });

  it("records thread starter context for inbound thread replies", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: "$root",
              sender: "@alice:example.org",
              body: "Root topic",
            }),
        },
        isDirectMessage: false,
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
        mentions: { room: true },
      }),
    );

    const context = requireRecord(
      callArg(finalizeInboundContext, 0, 0, "finalized context"),
      "finalized context",
    );
    expect(context.MessageThreadId).toBe("$root");
    expect(context.ParentSessionKey).toBe("agent:ops:main");
    expect(context.ThreadStarterBody).toBe("Matrix thread root $root from Alice:\nRoot topic");
    expectMockCallWithFields(recordInboundSession, { sessionKey: "agent:ops:main:thread:$root" });
  });

  it("keeps threaded DMs flat when dm threadReplies is off", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        threadReplies: "always",
        dmThreadReplies: "off",
        isDirectMessage: true,
        client: {
          getEvent: async (_roomId, eventId) =>
            eventId === "$root"
              ? createMatrixTextMessageEvent({
                  eventId: "$root",
                  sender: "@alice:example.org",
                  body: "Root topic",
                })
              : ({ sender: "@bot:example.org" } as never),
        },
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
      });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
      }),
    );

    const context = requireRecord(
      callArg(finalizeInboundContext, 0, 0, "finalized context"),
      "finalized context",
    );
    expect(context.MessageThreadId).toBeUndefined();
    expect(context.ReplyToId).toBe("$root");
    expect(context.ThreadStarterBody).toBe("Matrix thread root $root from Alice:\nRoot topic");
    expectMockCallWithFields(recordInboundSession, { sessionKey: "agent:ops:main" });
  });

  it("posts a one-time notice when another Matrix DM room already owns the shared DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm1",
          body: "follow up",
        }),
      );

      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      expectNoticeSent(sendNotice);

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm2",
          body: "again",
        }),
      );

      expect(sendNotice).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for the shared-session notice before dispatching the DM reply", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-order-"));
    const storePath = path.join(tempDir, "sessions.json");
    let resolveNotice: ((value: string) => void) | undefined;
    const noticeSent = new Promise<string>((resolve) => {
      resolveNotice = resolve;
    });
    const sendNotice = vi.fn(() => noticeSent);
    const dispatchInboundMessage = vi.fn(async () => ({
      counts: { block: 0, final: 0, tool: 0 },
      queuedFinal: false,
    }));

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        dispatchInboundMessage,
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      const handled = handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm1",
          body: "follow up",
        }),
      );

      await waitForMatrixState(() => {
        expect(sendNotice).toHaveBeenCalledTimes(1);
      });
      expect(dispatchInboundMessage).not.toHaveBeenCalled();

      resolveNotice?.("$notice");
      await handled;

      expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks flat DM collision notices against the current DM session key", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-flat-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:matrix:direct:@user:example.org", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        resolveAgentRoute: () => ({
          agentId: "ops",
          channel: "matrix",
          accountId: "ops",
          sessionKey: "agent:ops:matrix:direct:@user:example.org",
          mainSessionKey: "agent:ops:main",
          matchedBy: "binding.account" as const,
        }),
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm-flat-1",
          body: "follow up",
        }),
      );

      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      expectNoticeSent(sendNotice);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks threaded DM collision notices against the parent DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-thread-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        threadReplies: "always",
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
          getEvent: async (_roomId, eventId) =>
            eventId === "$root"
              ? createMatrixTextMessageEvent({
                  eventId: "$root",
                  sender: "@alice:example.org",
                  body: "Root topic",
                })
              : ({ sender: "@bot:example.org" } as never),
        },
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$reply1",
          body: "follow up",
          relatesTo: {
            rel_type: "m.thread",
            event_id: "$root",
            "m.in_reply_to": { event_id: "$root" },
          },
        }),
      );

      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      expectNoticeSent(sendNotice);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the shared-session notice after user-target outbound metadata overwrites latest room fields", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-stable-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@other:example.org",
        to: "room:@other:example.org",
        nativeDirectUserId: "@user:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm1",
          body: "follow up",
        }),
      );

      expect(callArg(sendNotice, 0, 0, "send notice")).toBe("!dm:example.org");
      expectNoticeSent(sendNotice);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the shared-session notice when the prior Matrix session metadata is not a DM", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-room-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "group",
        from: "matrix:channel:!group:example.org",
        to: "room:!group:example.org",
        nativeChannelId: "!group:example.org",
      });

      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm1",
          body: "follow up",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the shared-session notice when Matrix DMs are isolated per room", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-room-scope-"));
    const storePath = path.join(tempDir, "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:ops:main",
      entry: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "matrix",
            to: "room:!other:example.org",
            accountId: "ops",
          },
        }),
      },
    });
    const sendNotice = vi.fn(async () => "$notice");

    try {
      const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        dmSessionScope: "per-room",
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm1",
          body: "follow up",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
      expectMockCallWithFields(recordInboundSession, {
        sessionKey: "agent:ops:matrix:channel:!dm:example.org",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the shared-session notice when a Matrix DM is explicitly bound", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-bound-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:bound:session-1",
      entry: {
        sessionId: "sess-bound",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "matrix",
            to: "room:!other:example.org",
            accountId: "ops",
          },
        }),
      },
    });
    const sendNotice = vi.fn(async () => "$notice");
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "!dm:example.org"
          ? {
              bindingId: "ops:!dm:example.org",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "!dm:example.org",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch,
    });

    try {
      const { handler } = createMatrixHandlerTestHarness({
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        client: {
          sendMessage: sendNotice,
        },
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          eventId: "$dm-bound-1",
          body: "follow up",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
      expect(touch).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps stable room ids as routing metadata without using them as the display channel", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getRoomInfo: async () => ({
        name: "Ops Room",
        canonicalAlias: "#spoofed:example.org",
        altAliases: ["#alt:example.org"],
      }),
      getMemberDisplayName: async () => "sender",
      dispatchInboundMessage: async () => ({
        queuedFinal: false,
        counts: { final: 0, block: 0, tool: 0 },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$group1",
        body: "@room hello",
        mentions: { room: true },
      }),
    );

    const finalized = requireRecord(
      lastCallArg(finalizeInboundContext, 0, "finalized context"),
      "finalized context",
    );
    expect(finalized.ChatId).toBe("!room:example.org");
    expect(finalized.NativeChannelId).toBe("!room:example.org");
    expect(finalized.GroupChannel).toBeUndefined();
    expect(finalized.GroupSubject).toBe("Ops Room");
    expect(finalized.GroupId).toBe("!room:example.org");
  });

  it("routes bound Matrix threads to the target session key", async () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example:$root",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "$root",
                parentConversationId: "!room:example",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch,
    });
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              eventId: "$root",
              sender: "@alice:example.org",
              body: "Root topic",
            }),
        },
        isDirectMessage: false,
        getMemberDisplayName: async () => "sender",
      });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        eventId: "$reply1",
        body: "@room follow up",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
        mentions: { room: true },
      }),
    );
    const context = requireRecord(
      callArg(finalizeInboundContext, 0, 0, "finalized context"),
      "finalized context",
    );
    expect(context.ParentSessionKey).toBeUndefined();

    expectMockCallWithFields(recordInboundSession, { sessionKey: "agent:bound:session-1" });
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh bound Matrix thread bindings for room messages dropped before routing", async () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example:$root",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "$root",
                parentConversationId: "!room:example",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch,
    });
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@alice:example.org",
            body: "Root topic",
          }),
      },
      isDirectMessage: false,
      getMemberDisplayName: async () => "sender",
    });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        eventId: "$reply-no-mention",
        body: "follow up without mention",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
        },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("does not enqueue system events for delivered text replies", async () => {
    const enqueueSystemEvent = vi.fn();
    const { handler } = createMatrixHandlerTestHarness({
      enqueueSystemEvent,
      isDirectMessage: false,
      dispatchInboundMessage: async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$message1",
        sender: "@user:example.org",
        body: "hello there",
        mentions: { room: true },
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues system events for reactions on bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness();

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction1",
        targetEventId: "$msg1",
        key: "👍",
      }),
    );

    expectMockCallWithFields(resolveAgentRoute, { channel: "matrix", accountId: "ops" });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by sender on msg $msg1",
      {
        sessionKey: "agent:ops:main",
        contextKey: "matrix:reaction:add:!room:example.org:$msg1:@user:example.org:👍",
      },
    );
  });

  it("routes reaction notifications for bound thread messages to the bound session", async () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example.org:$root",
              targetSessionKey: "agent:bound:session-1",
              targetKind: "session",
              conversation: {
                channel: "matrix",
                accountId: "ops",
                conversationId: "$root",
                parentConversationId: "!room:example.org",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: {
                boundBy: "user-1",
              },
            }
          : null,
      touch: vi.fn(),
    });

    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$reply1",
            sender: "@bot:example.org",
            body: "follow up",
            relatesTo: {
              rel_type: "m.thread",
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
            },
          }),
      },
      isDirectMessage: false,
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-thread",
        targetEventId: "$reply1",
        key: "🎯",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🎯 by sender on msg $reply1",
      {
        sessionKey: "agent:bound:session-1",
        contextKey: "matrix:reaction:add:!room:example.org:$reply1:@user:example.org:🎯",
      },
    );
  });

  it("keeps threaded DM reaction notifications on the flat session when dm threadReplies is off", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            threadReplies: "always",
            dm: { allowFrom: ["*"], threadReplies: "off" },
          },
        },
      },
      isDirectMessage: true,
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$reply1",
            sender: "@bot:example.org",
            body: "follow up",
            relatesTo: {
              rel_type: "m.thread",
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
            },
          }),
      },
    });

    await handler(
      "!dm:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-thread",
        targetEventId: "$reply1",
        key: "🎯",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🎯 by sender on msg $reply1",
      {
        sessionKey: "agent:ops:main",
        contextKey: "matrix:reaction:add:!dm:example.org:$reply1:@user:example.org:🎯",
      },
    );
  });

  it("routes thread-root reaction notifications to the thread session when threadReplies is always", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            threadReplies: "always",
          },
        },
      },
      isDirectMessage: false,
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$root",
            sender: "@bot:example.org",
            body: "start thread",
          }),
      },
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-root",
        targetEventId: "$root",
        key: "🧵",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🧵 by sender on msg $root",
      {
        sessionKey: "agent:ops:main:thread:$root",
        contextKey: "matrix:reaction:add:!room:example.org:$root:@user:example.org:🧵",
      },
    );
  });

  it("ignores reactions that do not target bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness({
      targetSender: "@other:example.org",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction2",
        targetEventId: "$msg2",
        key: "👀",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("does not create pairing requests for unauthorized dm reactions", async () => {
    const { handler, enqueueSystemEvent, upsertPairingRequest } = createReactionHarness({
      dmPolicy: "pairing",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction3",
        targetEventId: "$msg3",
        key: "🔥",
      }),
    );

    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("honors account-scoped reaction notification overrides", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            reactionNotifications: "own",
            accounts: {
              ops: {
                reactionNotifications: "off",
              },
            },
          },
        },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction4",
        targetEventId: "$msg4",
        key: "✅",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops pre-startup dm messages on cold start", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));
    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      startupMs: 1_000,
      startupGraceMs: 0,
      dropPreStartupMessages: true,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$old-cold-start",
        body: "hello",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("replays pre-startup dm messages when persisted sync state exists", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "ops",
      channel: "matrix",
      accountId: "ops",
      sessionKey: "agent:ops:main",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
    }));
    const { handler } = createMatrixHandlerTestHarness({
      resolveAgentRoute,
      isDirectMessage: true,
      startupMs: 1_000,
      startupGraceMs: 0,
      dropPreStartupMessages: false,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$old-resume",
        body: "hello",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });
});

describe("matrix monitor handler live allowlist reload", () => {
  type MatrixHandler = ReturnType<typeof createMatrixHandlerTestHarness>["handler"];

  const createDispatchInboundMessage = () =>
    vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));

  const sendLiveAllowlistMessage = async (
    handler: MatrixHandler,
    params: {
      eventId: string;
      sender: string;
      body: string;
      roomId?: string;
      mentions?: MatrixRawEvent["content"]["m.mentions"];
    },
  ) => {
    await handler(
      params.roomId ?? "!dm:example.org",
      createMatrixTextMessageEvent({
        eventId: params.eventId,
        sender: params.sender,
        body: params.body,
        ...(params.mentions ? { mentions: params.mentions } : {}),
      }),
    );
  };

  const isLiveNameMatchingEnabled = (cfg: unknown): boolean => {
    const matrix = (cfg as { channels?: { matrix?: { dangerouslyAllowNameMatching?: boolean } } })
      .channels?.matrix;
    return matrix?.dangerouslyAllowNameMatching === true;
  };
  type LiveNameMatchingResolveParams = {
    cfg: unknown;
    entries?: ReadonlyArray<string | number>;
  };
  const countLiveAllowlistCallsForEntries = (
    calls: Array<[LiveNameMatchingResolveParams]>,
    entries: string[],
  ): number =>
    calls.filter(
      ([params]) => JSON.stringify((params.entries ?? []).map(String)) === JSON.stringify(entries),
    ).length;

  it("accepts a DM sender added to live dm.allowFrom", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: [] as string[] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: [],
      allowFromResolvedEntries: [],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-add-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).not.toHaveBeenCalled();

    cfg.channels.matrix.dm.allowFrom = ["@alice:example.org"];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-add-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks a DM sender removed from live dm.allowFrom", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["@alice:example.org"] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: ["@alice:example.org"],
      allowFromResolvedEntries: [{ input: "@alice:example.org", id: "@alice:example.org" }],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-remove-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.dm.allowFrom = [];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-remove-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks a DM sender after live wildcard removal", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["*"] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: ["*"],
      allowFromResolvedEntries: [],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-wildcard-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.dm.allowFrom = [];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-wildcard-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("uses account-scoped live dm.allowFrom overrides", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          dm: { allowFrom: ["@base:example.org"] },
          accounts: {
            ops: {
              dm: { allowFrom: ["@alice:example.org"] },
            },
          },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      accountId: "ops",
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: ["@alice:example.org"],
      allowFromResolvedEntries: [{ input: "@alice:example.org", id: "@alice:example.org" }],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-account-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.accounts.ops.dm.allowFrom = [];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-account-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps startup-resolved display names only while the raw input remains configured", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          dangerouslyAllowNameMatching: true,
          dm: { allowFrom: ["Alice"] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: ["@alice:example.org"],
      allowFromResolvedEntries: [{ input: "Alice", id: "@alice:example.org" }],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-name-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.dm.allowFrom = [];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-name-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts a DM sender added as a live-resolved display name", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const resolveLiveUserAllowlist = vi.fn(
      async (params: { entries?: ReadonlyArray<string | number> }) => {
        const entries = (params.entries ?? []).map(String);
        return entries.includes("Alice") ? ["@alice:example.org"] : [];
      },
    );
    const cfg = {
      channels: {
        matrix: {
          dangerouslyAllowNameMatching: true,
          dm: { allowFrom: [] as string[] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: [],
      allowFromResolvedEntries: [],
      dispatchInboundMessage,
      resolveLiveUserAllowlist,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).not.toHaveBeenCalled();

    cfg.channels.matrix.dm.allowFrom = ["Alice"];
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    const liveAllowlistRequest = requireRecord(
      lastCallArg(resolveLiveUserAllowlist, 0, "live allowlist request"),
      "live allowlist request",
    );
    expect(liveAllowlistRequest.accountId).toBe("ops");
    expect(liveAllowlistRequest.entries).toEqual(["Alice"]);
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached live display-name allowlists when name matching is disabled", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const resolveLiveUserAllowlist = vi.fn(async (params: LiveNameMatchingResolveParams) =>
      isLiveNameMatchingEnabled(params.cfg) ? ["@alice:example.org"] : [],
    );
    const cfg = {
      channels: {
        matrix: {
          dangerouslyAllowNameMatching: true,
          dm: { allowFrom: ["Alice"] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: [],
      allowFromResolvedEntries: [],
      dispatchInboundMessage,
      resolveLiveUserAllowlist,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-disable-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.dangerouslyAllowNameMatching = false;
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-disable-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(countLiveAllowlistCallsForEntries(resolveLiveUserAllowlist.mock.calls, ["Alice"])).toBe(
      2,
    );
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached live display-name allowlists when name matching is enabled", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const resolveLiveUserAllowlist = vi.fn(async (params: LiveNameMatchingResolveParams) =>
      isLiveNameMatchingEnabled(params.cfg) ? ["@alice:example.org"] : [],
    );
    const cfg = {
      channels: {
        matrix: {
          dangerouslyAllowNameMatching: false,
          dm: { allowFrom: ["Alice"] },
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      dmPolicy: "allowlist",
      isDirectMessage: true,
      allowFrom: [],
      allowFromResolvedEntries: [],
      dispatchInboundMessage,
      resolveLiveUserAllowlist,
    });

    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-enable-before",
      sender: "@alice:example.org",
      body: "hello",
    });
    expect(dispatchInboundMessage).not.toHaveBeenCalled();

    cfg.channels.matrix.dangerouslyAllowNameMatching = true;
    await sendLiveAllowlistMessage(handler, {
      eventId: "$dm-live-name-enable-after",
      sender: "@alice:example.org",
      body: "hello again",
    });

    expect(countLiveAllowlistCallsForEntries(resolveLiveUserAllowlist.mock.calls, ["Alice"])).toBe(
      2,
    );
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks a room sender removed from live groupAllowFrom while the group list remains configured", async () => {
    const dispatchInboundMessage = createDispatchInboundMessage();
    const cfg = {
      channels: {
        matrix: {
          groupAllowFrom: ["@alice:example.org", "@bob:example.org"],
        },
      },
    };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      isDirectMessage: false,
      groupPolicy: "allowlist",
      roomsConfig: { "*": {} },
      groupAllowFrom: ["@alice:example.org", "@bob:example.org"],
      groupAllowFromResolvedEntries: [
        { input: "@alice:example.org", id: "@alice:example.org" },
        { input: "@bob:example.org", id: "@bob:example.org" },
      ],
      dispatchInboundMessage,
    });

    await sendLiveAllowlistMessage(handler, {
      roomId: "!room:example.org",
      eventId: "$group-remove-before",
      sender: "@alice:example.org",
      body: "@room hello",
      mentions: { room: true },
    });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);

    cfg.channels.matrix.groupAllowFrom = ["@bob:example.org"];
    await sendLiveAllowlistMessage(handler, {
      roomId: "!room:example.org",
      eventId: "$group-remove-after",
      sender: "@alice:example.org",
      body: "@room hello again",
      mentions: { room: true },
    });

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe("matrix monitor handler durable inbound dedupe", () => {
  it("skips replayed inbound events before session recording", async () => {
    const inboundDeduper = {
      claim: vi.fn(async () => ({ kind: "duplicate" as const })),
    };
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      inboundDeduper,
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$dup",
        body: "hello",
      }),
    );

    expect(inboundDeduper.claim).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$dup",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("commits inbound events only after queued replies finish delivering", async () => {
    const callOrder: string[] = [];
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return true;
    });
    const release = vi.fn(() => {
      callOrder.push("release");
    });
    const inboundDeduper = {
      claim: vi.fn(async () => {
        callOrder.push("claim");
        return {
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        };
      }),
    };
    const recordInboundSession = vi.fn(async () => {
      callOrder.push("record");
    });
    const dispatchInboundMessage = vi.fn(async () => {
      callOrder.push("dispatch");
      return {
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      };
    });
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      recordInboundSession,
      dispatchInboundMessage,
      createReplyDispatcherWithTyping: () => ({
        dispatcher: {
          markComplete: () => {
            callOrder.push("mark-complete");
          },
          waitForIdle: async () => {
            callOrder.push("wait-for-idle");
          },
        },
        replyOptions: {},
        markDispatchIdle: () => {
          callOrder.push("dispatch-idle");
        },
        markRunComplete: () => {
          callOrder.push("run-complete");
        },
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$commit-order",
        body: "hello",
      }),
    );

    expect(callOrder).toEqual([
      "claim",
      "record",
      "dispatch",
      "mark-complete",
      "wait-for-idle",
      "run-complete",
      "dispatch-idle",
      "commit",
    ]);
    expect(release).not.toHaveBeenCalled();
  });

  it("commits a claimed event when bot loop protection suppresses dispatch", async () => {
    const commit = vi.fn(async () => true);
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        handle: { keys: ["test"] as const, commit, release },
      })),
    };
    const runPrepared = vi.fn(
      async (turn: { ctxPayload: Record<string, unknown>; routeSessionKey: string }) => ({
        admission: { kind: "drop" as const, reason: "bot-loop-protection" as const },
        dispatched: false as const,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.routeSessionKey,
      }),
    );
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      inboundDeduper,
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      runPrepared,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-loop-drop",
        sender: "@ops:example.org",
        body: "hello from bot",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a claimed event when reply dispatch fails before completion", async () => {
    const commit = vi.fn(async () => true);
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        handle: { keys: ["test"] as const, commit, release },
      })),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        throw new Error("disk failed");
      }),
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$release-on-error",
        body: "hello",
      }),
    );

    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expectRuntimeErrorContaining(runtime.error, "matrix handler failed");
  });

  it("sends one durable threaded notice and commits replay after restart tombstone rejection", async () => {
    const callOrder: string[] = [];
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return true;
    });
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => {
        callOrder.push("claim");
        return {
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        };
      }),
    };
    const runtime = { error: vi.fn() };
    const dispatchInboundMessage = vi.fn(async () => {
      callOrder.push("dispatch");
      throw Object.assign(new Error("session ended during restart recovery"), {
        code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
      });
    });
    sendMessageMatrixMock.mockImplementationOnce(async () => {
      callOrder.push("notice");
      return { messageId: "$notice", roomId: "!room:example.org" };
    });
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      isDirectMessage: false,
      roomsConfig: { "!room:example.org": { requireMention: false } },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            eventId: "$thread-root",
            sender: "@alice:example.org",
            body: "Thread root",
          }),
      },
      dispatchInboundMessage,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$tombstone-event",
        body: "continue",
        relatesTo: {
          rel_type: "m.thread",
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
        },
      }),
    );

    expect(dispatchInboundMessage).toHaveBeenCalledOnce();
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(callArg(sendMessageMatrixMock, 0, 0, "notice room")).toBe("!room:example.org");
    expect(String(callArg(sendMessageMatrixMock, 0, 1, "notice body"))).toContain(
      "Send /new or /reset",
    );
    expect(callArg(sendMessageMatrixMock, 0, 2, "notice options")).toMatchObject({
      accountId: "ops",
      replyToId: "$thread-root",
      threadId: "$thread-root",
      deliveryQueueId: "matrix:restart-recovery-tombstone:ops:!room:example.org:$tombstone-event",
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      extraContent: { msgtype: "m.notice" },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["claim", "record", "dispatch", "notice", "commit"]);
  });

  it("releases replay for retry when the restart tombstone notice cannot be sent", async () => {
    const commit = vi.fn(async () => true);
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        handle: { keys: ["test"] as const, commit, release },
      })),
    };
    const runtime = { error: vi.fn() };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("homeserver unavailable"));
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => {
        throw Object.assign(new Error("session ended during restart recovery"), {
          code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
        });
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$tombstone-notice-failed",
        body: "continue",
      }),
    );

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expectRuntimeErrorContaining(
      runtime.error,
      "failed completing restart-recovery tombstone notice",
    );
  });

  it("keeps replay committed when queued final delivery fails after a generic error", async () => {
    const commit = vi.fn(async () => true);
    const release = vi.fn();
    const inboundDeduper = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        handle: { keys: ["test"] as const, commit, release },
      })),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
      createReplyDispatcherWithTyping: (params) => ({
        dispatcher: {
          markComplete: () => {},
          waitForIdle: async () => {
            params?.onError?.(new Error("send failed"), { kind: "final" });
          },
        },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$release-on-final-delivery-error",
        body: "hello",
      }),
    );

    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expectRuntimeErrorContaining(runtime.error, "matrix final reply failed");
  });

  it.each(["tool", "block"] as const)(
    "keeps replay committed when queued %s delivery fails after a generic error and no final reply exists",
    async (kind) => {
      const commit = vi.fn(async () => true);
      const release = vi.fn();
      const inboundDeduper = {
        claim: vi.fn(async () => ({
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        })),
      };
      const runtime = {
        error: vi.fn(),
      };
      const { handler } = createMatrixHandlerTestHarness({
        inboundDeduper,
        runtime: runtime as never,
        dispatchInboundMessage: vi.fn(async () => ({
          queuedFinal: false,
          counts: {
            final: 0,
            block: kind === "block" ? 1 : 0,
            tool: kind === "tool" ? 1 : 0,
          },
        })),
        createReplyDispatcherWithTyping: (params) => ({
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {
              params?.onError?.(new Error("send failed"), { kind });
            },
          },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        }),
      });

      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({
          eventId: `$release-on-${kind}-delivery-error`,
          body: "hello",
        }),
      );

      expect(commit).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expectRuntimeErrorContaining(runtime.error, `matrix ${kind} reply failed`);
    },
  );

  it("commits a claimed event when dispatch completes without a final reply", async () => {
    const callOrder: string[] = [];
    const commit = vi.fn(async () => {
      callOrder.push("commit");
      return true;
    });
    const release = vi.fn(() => {
      callOrder.push("release");
    });
    const inboundDeduper = {
      claim: vi.fn(async () => {
        callOrder.push("claim");
        return {
          kind: "claimed" as const,
          handle: { keys: ["test"] as const, commit, release },
        };
      }),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      dispatchInboundMessage: vi.fn(async () => {
        callOrder.push("dispatch");
        return {
          queuedFinal: false,
          counts: { final: 0, block: 0, tool: 0 },
        };
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$no-final",
        body: "hello",
      }),
    );

    expect(callOrder).toEqual(["claim", "record", "dispatch", "commit"]);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      audioAsVoice?: boolean;
      spokenText?: string;
      ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
      isCompactionNotice?: boolean;
      isError?: boolean;
      replyToId?: string;
    },
    info: { kind: string },
  ) => Promise<unknown>;
  type ReplyOpts = {
    onReplyStart?: () => Promise<void> | void;
    onPartialReply?: (payload: { text: string }) => void;
    onBlockReplyQueued?: (
      payload: {
        text?: string;
        isCompactionNotice?: boolean;
      },
      context?: { assistantMessageIndex?: number },
    ) => Promise<void> | void;
    onAssistantMessageStart?: () => void;
    onQueuedFollowupAdmitted?: () => Promise<void> | void;
    suppressDefaultToolProgressMessages?: boolean;
    onToolStart?: (payload: {
      itemId?: string;
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }) => Promise<void>;
    onItemEvent?: (payload: {
      itemId?: string;
      toolCallId?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      kind?: string;
      phase?: string;
      status?: string;
    }) => Promise<void>;
    onPlanUpdate?: (payload: {
      phase: string;
      explanation?: string;
      steps?: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
    }) => Promise<void>;
    onApprovalEvent?: (payload: { phase?: string; command?: string }) => Promise<void>;
    onCommandOutput?: (payload: {
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      name?: string;
      exitCode?: number;
      status?: string;
      title?: string;
    }) => Promise<void>;
    onPatchSummary?: (payload: {
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      name?: string;
      summary?: string;
      title?: string;
      added?: string[];
      modified?: string[];
      deleted?: string[];
    }) => Promise<void>;
    disableBlockStreaming?: boolean;
  };

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    accountConfig?: import("../../types.js").MatrixConfig;
  }) {
    let capturedDeliver: DeliverFn | undefined;
    let capturedOnError: ((error: unknown, info: { kind: string }) => void) | undefined;
    let capturedReplyOpts: ReplyOpts | undefined;
    let resolveCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });
    const notifyCaptured = () => {
      if (capturedDeliver && capturedReplyOpts) {
        resolveCaptured?.();
      }
    };
    // Gate that keeps the handler's model run alive until the test releases it.
    let resolveRunGate: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      resolveRunGate = resolve;
    });

    sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    const logVerboseMessage = vi.fn();

    const { handler } = createMatrixHandlerTestHarness({
      streaming: opts?.streaming ?? "quiet",
      accountConfig: opts?.accountConfig,
      previewToolProgressEnabled: opts?.previewToolProgressEnabled ?? false,
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      replyToMode: opts?.replyToMode ?? "off",
      client: { redactEvent: redactEventMock },
      logVerboseMessage,
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        capturedDeliver = params?.deliver as DeliverFn | undefined;
        capturedOnError = params?.onError as typeof capturedOnError;
        notifyCaptured();
        return {
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {},
          },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        notifyCaptured();
        // Block until the test is done exercising callbacks.
        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const dispatch = async () => {
      // Start handler without awaiting — it blocks on runGate.
      const handlerDone = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );
      await captured;
      return {
        deliver: capturedDeliver!,
        onError: capturedOnError!,
        opts: capturedReplyOpts!,
        // Release the run gate and wait for the handler to finish
        // (including the finally block that stops the draft stream).
        finish: async () => {
          resolveRunGate?.();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock, logVerboseMessage };
  }

  it("records a failed block typing restart without replaying the accepted delivery", async () => {
    const acceptedDelivery = createMockMatrixDeliveryResult("$accepted", "Already delivered block");
    const { dispatch, logVerboseMessage } = createStreamingHarness({ streaming: "off" });
    deliverMatrixRepliesMock.mockResolvedValueOnce(acceptedDelivery);
    sendTypingMatrixMock.mockRejectedValueOnce(new Error("typing unavailable"));
    const { deliver, finish } = await dispatch();

    await expect(deliver({ text: "Already delivered block" }, { kind: "block" })).resolves.toBe(
      acceptedDelivery,
    );

    expect(deliverMatrixRepliesMock).toHaveBeenCalledOnce();
    expect(sendTypingMatrixMock).toHaveBeenCalledExactlyOnceWith(
      "!room:example.org",
      true,
      undefined,
      expect.anything(),
    );
    const expectedDiagnostic =
      "matrix typing action=start failed target=!room:example.org: Error: typing unavailable";
    await waitForMatrixState(() =>
      expect(
        logVerboseMessage.mock.calls.filter(([message]) => message === expectedDiagnostic),
      ).toHaveLength(1),
    );

    await finish();
  });

  it("shares first-reply state between tool and final Matrix deliveries", async () => {
    const { dispatch } = createStreamingHarness({ replyToMode: "first", streaming: "off" });
    const { deliver, finish } = await dispatch();

    await deliver({ text: "tool result", replyToId: "$msg1" }, { kind: "tool" });
    await deliver({ text: "final result" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(2);
    const toolDelivery = requireRecord(
      callArg(deliverMatrixRepliesMock, 0, 0, "Matrix tool reply"),
      "Matrix tool reply",
    );
    const finalDelivery = requireRecord(
      callArg(deliverMatrixRepliesMock, 1, 0, "Matrix final reply"),
      "Matrix final reply",
    );
    expect(toolDelivery.hasRepliedRef).toEqual({ value: false });
    expect(finalDelivery.hasRepliedRef).toBe(toolDelivery.hasRepliedRef);

    await finish();
  });

  it("finalizes a single quiet-preview block in place when block streaming is enabled", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    const result = await deliver({ text: "Single block" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expectFinalizedPreviewEdit("$draft1", "Single block");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messageIds: ["$draft1"],
      visibleReplySent: true,
      content: "Single block",
      receipt: { primaryPlatformMessageId: "$draft1" },
    });
    await finish();
  });

  it("settles finalized previews with provider-prepared content", async () => {
    prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: `prepared:${text.trim()}`,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    }));
    const { dispatch } = createStreamingHarness({ streaming: "quiet" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Raw preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    const result = await deliver({ text: "Raw final" }, { kind: "final" });

    expect(result).toMatchObject({
      messageIds: ["$draft1"],
      content: "prepared:Raw final",
    });
    await finish();
  });

  it("settles reused media previews with provider-prepared content", async () => {
    prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: `prepared:${text.trim()}`,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    }));
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Raw caption" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    const result = await deliver(
      { text: "Raw caption", mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    );

    expect(result).toMatchObject({
      messageIds: ["$draft1", "$reply1"],
      content: "prepared:Raw caption\ndelivered",
    });
    await finish();
  });

  it("preserves provider previews for observer-only hooks", async () => {
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "message_sent"),
    });
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    await deliver({ text: "Visible preview" }, { kind: "final" });

    expectEditLiveFlag("$draft1", "Visible preview", false);
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
    { label: "message_sending", hooks: ["message_sending"] },
    {
      label: "both modifying hooks",
      hooks: ["reply_payload_sending", "message_sending"],
    },
  ])("suppresses provider previews when $label is registered", async ({ hooks }) => {
    const registered = new Set(hooks);
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
    });
    const { dispatch } = createStreamingHarness({
      previewToolProgressEnabled: true,
      streaming: "progress",
    });
    const { deliver, opts, finish } = await dispatch();

    expect(opts.onPartialReply).toBeUndefined();
    expect(opts.onToolStart).toBeUndefined();
    expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
    await deliver({ text: "Durable final" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("streams tool progress into the Matrix draft preview when enabled", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      previewToolProgressEnabled: true,
    });
    const { deliver, opts, finish } = await dispatch();

    expect(opts.suppressDefaultToolProgressMessages).toBe(true);
    await opts.onToolStart?.({ name: "read_file" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toMatch(/\n`🧩 Read File`$/);

    await deliver({ text: "Done" }, { kind: "final" });

    expectFinalizedPreviewEdit("$draft1", "Done");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("replaces Matrix plan snapshots and keeps the explanation", async () => {
    vi.useFakeTimers();
    let finish: (() => Promise<void>) | undefined;
    try {
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        previewToolProgressEnabled: true,
        accountConfig: {
          streaming: { mode: "progress", progress: { label: false } },
        } as never,
      });
      const streaming = await dispatch();
      const { opts } = streaming;
      finish = streaming.finish;

      await opts.onPlanUpdate?.({
        phase: "update",
        explanation: "Initial plan",
        steps: [{ step: "Inspect", status: "in_progress" }],
      });
      await waitForMatrixState(() => {
        expect(singleTextMessageBody()).toBe("`Initial plan`\n\n`▸ Inspect`");
      });

      await opts.onPlanUpdate?.({
        phase: "update",
        explanation: "Revised plan",
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
        ],
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(editMessageMatrixMock).toHaveBeenCalled();
      expect(lastCallArg(editMessageMatrixMock, 2, "Matrix plan edit body")).toBe(
        "`Revised plan`\n\n`✅ Inspect`\n`▸ Patch`",
      );
    } finally {
      try {
        await finish?.();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("uses resolved Matrix account progress maxLines for draft text", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Pearling",
            maxLines: 1,
          },
        },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onReplyStart?.();
    await opts.onItemEvent?.({ progressText: "first" });
    await opts.onItemEvent?.({ progressText: "second" });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toBe("- `second`");
    await finish();
    vi.useRealTimers();
  });

  it("keeps truncated Matrix tool progress UTF-16 safe", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: { label: false, maxLineChars: 500 },
        },
      } as never,
    });
    const { opts, finish } = await dispatch();
    const progressPrefix = "x".repeat(298);

    const progressText = `${progressPrefix}🎉tail`;
    await opts.onItemEvent?.({ progressText });
    await opts.onItemEvent?.({ progressText });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toBe(`- \`${progressPrefix}...\``);
    await finish();
    vi.useRealTimers();
  });

  it("suppresses terminal progress callbacks without their terminal phase", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
    });
    const { opts, finish } = await dispatch();

    await opts.onApprovalEvent?.({ command: "must stay hidden" });
    await opts.onCommandOutput?.({ title: "must stay hidden", exitCode: 0 });
    await opts.onPatchSummary?.({ summary: "must stay hidden" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
    vi.useRealTimers();
  });

  it("replaces recovered Matrix command progress instead of leaving stale failed text", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.({
      itemId: "command-1",
      kind: "command",
      name: "exec",
      phase: "end",
      status: "failed",
      progressText: "run openclaw cron -> run jq (agent) failed",
    });
    await opts.onItemEvent?.({
      itemId: "command-1",
      kind: "command",
      name: "exec",
      phase: "end",
      status: "failed",
      progressText: "run openclaw cron -> run jq (agent) failed",
    });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("failed");

    await opts.onCommandOutput?.({
      itemId: "command-1",
      toolCallId: "call-1",
      phase: "end",
      name: "exec",
      status: "completed",
      exitCode: 0,
    });

    await finish();
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      expect.stringContaining("Exec"),
      expect.any(Object),
    );
    const recoveredEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
      ([, eventId, body]) => eventId === "$draft1" && typeof body === "string",
    );
    expect(recoveredEdit?.[2]).not.toContain("completed");
    expect(recoveredEdit?.[2]).not.toContain("failed");
    expect(recoveredEdit?.[2]).not.toContain("run openclaw cron -> run jq");
    vi.useRealTimers();
  });

  it("keeps Matrix tool progress free of terminal status text", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onToolStart?.({
      itemId: "fc-call-2",
      toolCallId: "call-2",
      name: "exec",
      phase: "start",
      args: { command: "npm install" },
    });
    await opts.onToolStart?.({
      itemId: "fc-call-2",
      toolCallId: "call-2",
      name: "exec",
      phase: "update",
      args: { command: "npm install" },
    });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("Exec");

    await opts.onItemEvent?.({
      itemId: "fc-call-2",
      toolCallId: "call-2",
      kind: "command",
      name: "exec",
      phase: "update",
      progressText: "install dependencies",
    });

    await opts.onCommandOutput?.({
      itemId: "fc-call-2-output",
      toolCallId: "call-2",
      phase: "end",
      name: "exec",
      status: "completed",
      exitCode: 0,
    });

    await finish();
    const completedEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
      ([, eventId, body]) =>
        eventId === "$draft1" && typeof body === "string" && body.includes("completed"),
    );
    expect(completedEdit).toBeUndefined();
    expect(singleTextMessageBody()).toContain("Exec");
    vi.useRealTimers();
  });

  it("replaces Matrix patch progress when the patch summary completes", async () => {
    vi.useFakeTimers();
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: { mode: "progress", progress: { label: "Working" } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.({
      itemId: "patch:call-3",
      toolCallId: "call-3",
      kind: "patch",
      name: "apply_patch",
      phase: "update",
      progressText: "updating Matrix progress handling",
    });
    await opts.onItemEvent?.({
      itemId: "patch:call-3",
      toolCallId: "call-3",
      kind: "patch",
      name: "apply_patch",
      phase: "update",
      progressText: "updating Matrix progress handling",
    });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(singleTextMessageBody()).toContain("updating Matrix progress handling");

    await opts.onPatchSummary?.({
      itemId: "patch:call-3",
      toolCallId: "call-3",
      phase: "end",
      name: "apply_patch",
      modified: ["extensions/matrix/src/matrix/monitor/handler.ts"],
      summary: "1 file modified",
    });

    await finish();
    const patchEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
      ([, eventId, body]) =>
        eventId === "$draft1" && typeof body === "string" && body.includes("1 file modified"),
    );
    expect(patchEdit?.[2]).not.toContain("updating Matrix progress handling");
    vi.useRealTimers();
  });

  it("keeps Matrix tool progress mentions inside code formatting", async () => {
    const { dispatch } = createStreamingHarness({
      previewToolProgressEnabled: true,
      streaming: "partial",
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.({
      progressText: "@room ping @alice:example.org [label](https://example.org)",
    });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toMatch(
      /\n- `@room ping @alice:example\.org \[label\]\(https:\/\/example\.org\)`$/,
    );
    await finish();
  });

  it("leaves Matrix tool progress on the default tool delivery path when disabled", async () => {
    const { dispatch } = createStreamingHarness({
      previewToolProgressEnabled: false,
    });
    const { opts, finish } = await dispatch();

    expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
    expect(opts.onToolStart).toBeUndefined();
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it("suppresses standalone Matrix tool progress in progress mode when draft lines are disabled", async () => {
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: false,
    });
    const { opts, finish } = await dispatch();

    expect(opts.suppressDefaultToolProgressMessages).toBe(true);
    expect(opts.onToolStart).toBeUndefined();
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it("does not create a blank Matrix progress draft when label and lines are disabled", async () => {
    const { dispatch } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: false,
      accountConfig: {
        streaming: { mode: "progress", progress: { label: false, toolProgress: false } },
      } as never,
    });
    const { opts, finish } = await dispatch();

    await opts.onItemEvent?.({ progressText: "tool one" });
    await opts.onItemEvent?.({ progressText: "tool two" });

    expect(opts.suppressDefaultToolProgressMessages).toBe(true);
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    { name: "plain text", payload: { text: "Single block" } },
    { name: "blank-only media", payload: { text: "Single block", mediaUrls: ["   "] } },
  ])("finalizes unchanged partial drafts for $name", async ({ payload }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    const draftOptions = requireRecord(
      callArg(sendSingleTextMessageMatrixMock, 0, 2, "draft options"),
      "draft options",
    );
    expect(draftOptions.msgtype).not.toBe("m.notice");
    expect(draftOptions.includeMentions).toBe(false);

    await deliver(payload, { kind: "final" });

    // MSC4357: even when text is unchanged, a finalize edit is sent to clear
    // the live marker so supporting clients stop the streaming animation.
    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expectEditLiveFlag("$draft1", "Single block", false);
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    {
      name: "delivers the normal final before redacting unchanged Matrix mention previews",
      finalText: "hello @alice:example.org",
    },
    {
      name: "delivers the normal final before redacting changed Matrix mention previews",
      finalText: "hello @alice:example.org!",
    },
  ])("$name", async ({ finalText }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "hello @alice:example.org" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await deliver({ text: finalText }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    const deliverParams = requireRecord(
      callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
      "deliver replies params",
    );
    const replies = requireArray(deliverParams.replies, "delivered replies");
    expect(requireRecord(replies[0], "delivered reply").text).toBe(finalText);
    await finish();
  });

  it("keeps the draft preview and sends media-only for TTS supplement finals", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Spoken answer" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    const result = await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    );

    expectEditLiveFlag("$draft1", "Spoken answer", false);
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(
        callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
        "deliver replies params",
      ).replies,
    ).toEqual([
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
    expect(result).toMatchObject({
      messageIds: ["$draft1", "$reply1"],
      visibleReplySent: true,
      content: "Spoken answer\ndelivered",
      receipt: { primaryPlatformMessageId: "$draft1" },
    });
    await finish();
  });

  it("preserves a finalized draft receipt when the following media send fails", async () => {
    const { dispatch } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Spoken answer" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));

    const error = await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Spoken answer",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("falls back with visible text when TTS supplement live finalization fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Spoken answer" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));
    await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    );

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(
        callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
        "deliver replies params",
      ).replies,
    ).toEqual([
      {
        text: "Spoken answer",
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
    await finish();
  });

  it("preserves a surviving draft receipt when redaction and media delivery fail", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));
    const error = await deliver(
      { mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("preserves a surviving draft receipt when final-edit fallback also fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
    const error = await deliver({ text: "Final text" }, { kind: "final" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("preserves a surviving draft receipt when generic fallback delivery fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
    const error = await deliver({ text: "Something failed", isError: true } as never, {
      kind: "final",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])("retains a visible draft when $branch replacement throws", async ({ payload, failEdit }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    if (failEdit) {
      editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    }
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));

    const error = await deliver(payload, { kind: "final" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
      },
    });
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "retains a visible draft when $branch replacement reports no visible event",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockResolvedValueOnce({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });

      const result = await deliver(payload, { kind: "final" });
      await finish();

      expect(result).toMatchObject({
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
      });
      expect(redactEventMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "redacts a visible draft only after complete $branch replacement",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }

      const result = await deliver(payload, { kind: "final" });

      expect(result).toMatchObject({ messageIds: ["$reply1"], visibleReplySent: true });
      expect(deliverMatrixRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
        redactEventMock.mock.invocationCallOrder[0]!,
      );
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
      await finish();
      expect(redactEventMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "combines a visible draft with accepted $branch replacement prefixes",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockRejectedValueOnce(
        createChannelPartialDeliveryError(new Error("second replacement event failed"), {
          ...createMockMatrixDeliveryResult("$accepted-prefix", "Accepted prefix"),
          visibleReplySent: true as const,
        }),
      );

      const error = await deliver(payload, { kind: "final" }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          messageIds: ["$draft1", "$accepted-prefix"],
          visibleReplySent: true,
          content: "Visible preview\nAccepted prefix",
        },
      });
      expect(redactEventMock).not.toHaveBeenCalled();
      await finish();
      expect(redactEventMock).not.toHaveBeenCalled();
    },
  );

  it("reports both visible events when post-replacement redaction fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));

    const result = await deliver({ text: "Something failed", isError: true }, { kind: "final" });

    expect(result).toMatchObject({
      messageIds: ["$draft1", "$reply1"],
      visibleReplySent: true,
      content: "Visible preview\ndelivered",
    });
    await finish();
    expect(redactEventMock).toHaveBeenCalledTimes(1);
  });

  it.each(
    (["retained", "consumed"] as const).flatMap((priorDisposition) =>
      (["block", "followup"] as const).flatMap((boundary) =>
        (["complete", "unfinished"] as const).map((outcome) => ({
          priorDisposition,
          boundary,
          outcome,
        })),
      ),
    ),
  )(
    "settles $priorDisposition then $boundary draft generations through $outcome",
    async ({ priorDisposition, boundary, outcome }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, onError, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "First generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (priorDisposition === "retained") {
        deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));
      }
      if (boundary === "block") {
        await opts.onBlockReplyQueued?.({ text: "First generation" });
      }
      const firstDelivery = deliver(
        { text: "First replacement", isError: true },
        { kind: boundary === "block" ? "block" : "final" },
      );
      if (priorDisposition === "retained") {
        await firstDelivery.catch(() => undefined);
      } else {
        await firstDelivery;
      }
      if (boundary === "followup") {
        await opts.onQueuedFollowupAdmitted?.();
      } else {
        if (priorDisposition === "retained") {
          onError(new Error("replacement failed"), { kind: "block" });
        }
        opts.onAssistantMessageStart?.();
      }

      sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
        messageId: "$draft2",
        roomId: "!room",
      });
      opts.onPartialReply?.({ text: "Next generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
      });
      if (outcome === "complete") {
        await deliver({ text: "Second replacement", isError: true }, { kind: "final" });
      }
      await finish();

      const redactedEventIds = mockCalls(redactEventMock, "redactEvent").map(
        ([, eventId]) => eventId,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft1")).toHaveLength(
        priorDisposition === "consumed" ? 1 : 0,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft2")).toHaveLength(1);
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(outcome === "complete" ? 2 : 1);
      if (outcome === "complete") {
        expect(deliverMatrixRepliesMock.mock.invocationCallOrder[1]).toBeLessThan(
          redactEventMock.mock.invocationCallOrder.at(-1)!,
        );
      }
    },
  );

  it("falls back with visible text when TTS supplement preview has no event id", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, finish } = await dispatch();

    await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
      { kind: "final" },
    );

    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(
        callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
        "deliver replies params",
      ).replies,
    ).toEqual([
      {
        text: "Spoken answer",
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
    await finish();
  });

  it("keeps already-delivered TTS supplements audio-only without a draft preview", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "off",
    });
    const { deliver, finish } = await dispatch();

    await deliver(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      },
      { kind: "final" },
    );

    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(
        callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
        "deliver replies params",
      ).replies,
    ).toEqual([
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      },
    ]);
    await finish();
  });

  it("still edits partial preview-first drafts when the final text changes", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await deliver({ text: "Single block" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expectEditLiveFlag("$draft1", "Single block", undefined);
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("preserves completed blocks by rotating to a new quiet preview", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Block one" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Block one" }, { kind: "block" });

    expectFinalizedPreviewEdit("$draft1", "Block one");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();

    opts.onAssistantMessageStart?.();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    opts.onPartialReply?.({ text: "Block two" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });

    await deliver({ text: "Block two" }, { kind: "final" });

    expectFinalizedPreviewEdit("$draft2", "Block two");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("queues late partials behind block-boundary rotation", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    opts.onPartialReply?.({ text: "AlphaBeta" });

    // The next block must not update the previous block's draft while the
    // prior block delivery is still draining.
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();

    await deliver({ text: "Alpha" }, { kind: "block" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });
    expect(singleTextMessageBody(1)).toBe("Beta");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(
      () => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );

    opts.onPartialReply?.({ text: "AlphaBeta" });
    await waitForMatrixState(
      () => {
        expectMatrixEdit("!room:example.org", "$draft1", "AlphaBeta");
      },
      { interval: 1 },
    );

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await waitForMatrixState(
      () => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      },
      { interval: 1 },
    );
    expect(singleTextMessageBody()).toBe("Beta");
    expectMatrixEdit("!room:example.org", "$draft1", "Alpha");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("falls back to deliverMatrixReplies when final edit fails", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Hello" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));

    await deliver({ text: "Hello world" }, { kind: "block" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("does not reset draft stream after final delivery", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = createStreamingHarness();
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Hello" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      // Final delivery — stream should stay stopped.
      await deliver({ text: "Hello" }, { kind: "final" });

      // Further partial updates should NOT create new messages.
      sendSingleTextMessageMatrixMock.mockClear();
      opts.onPartialReply?.({ text: "Ghost" });

      await vi.advanceTimersByTimeAsync(50);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      await finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh Matrix draft for queued followups after the primary final", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = createStreamingHarness();
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Primary answer" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      await deliver({ text: "Primary answer" }, { kind: "final" });

      sendSingleTextMessageMatrixMock.mockClear();
      sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });

      await opts.onQueuedFollowupAdmitted?.();
      opts.onPartialReply?.({ text: "Queued followup answer" });
      await vi.advanceTimersByTimeAsync(50);

      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toBe("Queued followup answer");
      await finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts fresh progress drafts for queued followups after the primary final", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        previewToolProgressEnabled: true,
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onToolStart?.({ name: "read_file" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);

      await deliver({ text: "Primary answer" }, { kind: "final" });

      sendSingleTextMessageMatrixMock.mockClear();
      sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });

      await opts.onQueuedFollowupAdmitted?.();
      await opts.onToolStart?.({ name: "exec" });
      // Mirrors DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS: the followup draft must
      // wait out a fresh gate instead of inheriting the primary turn's timer.
      await vi.advanceTimersByTimeAsync(PROGRESS_DRAFT_START_DELAY_MS - 1);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toMatch(/`🛠️ Exec`$/);
      await finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets draft block offsets on assistant message start", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    // Block 1: stream and deliver.
    opts.onPartialReply?.({ text: "Block one" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    await deliver({ text: "Block one" }, { kind: "block" });

    // Tool call delivered (bypasses draft stream).
    await deliver({ text: "tool result" }, { kind: "tool" });

    // New assistant message starts — payload.text will reset upstream.
    opts.onAssistantMessageStart?.();

    // Block 2: partial text starts fresh (no stale offset).
    sendSingleTextMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });

    opts.onPartialReply?.({ text: "Block two" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // The draft stream should have received "Block two", not empty string.
    const sentBody = singleTextMessageBody();
    expect(sentBody).toBe("Block two");
    await finish();
  });

  it("preserves queued block boundaries across assistant message start", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Beta" });

    await waitForMatrixState(() => {
      expectMatrixEdit("!room:example.org", "$draft1", "Beta");
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expectMatrixEdit("!room:example.org", "$draft1", "Alpha");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Beta");

    await deliver({ text: "Beta" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("queues late block boundaries against the source assistant message", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    opts.onAssistantMessageStart?.();
    await opts.onBlockReplyQueued?.({ text: "Alpha" }, { assistantMessageIndex: 1 });
    opts.onPartialReply?.({ text: "Beta" });

    await waitForMatrixState(() => {
      expectMatrixEdit("!room:example.org", "$draft1", "Beta");
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expectMatrixEdit("!room:example.org", "$draft1", "Alpha");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Beta");

    await deliver({ text: "Beta" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps queued block boundaries ordered while Matrix deliveries drain", async () => {
    const { dispatch } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Alpha");

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    opts.onPartialReply?.({ text: "AlphaBeta" });
    await opts.onBlockReplyQueued?.({ text: "Beta" });
    opts.onPartialReply?.({ text: "AlphaBetaGamma" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Beta");
    expectFinalizedPreviewEdit("$draft1", "Alpha");

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft3",
      roomId: "!room",
    });
    await deliver({ text: "Beta" }, { kind: "block" });

    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(singleTextMessageBody()).toBe("Gamma");
    expectFinalizedPreviewEdit("$draft2", "Beta");

    await finish();
  });

  it("stops quiet draft stream on handler error and cleans a draft accepted during shutdown", async () => {
    vi.useFakeTimers();
    try {
      let resolveDraftSend: ((value: { messageId: string; roomId: string }) => void) | undefined;
      sendSingleTextMessageMatrixMock.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDraftSend = resolve;
          }),
      );
      editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
      deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
      const redactEventMock = vi.fn(async () => "$redacted");

      let capturedReplyOpts: ReplyOpts | undefined;

      const { handler } = createMatrixHandlerTestHarness({
        streaming: "quiet",
        client: { redactEvent: redactEventMock },
        createReplyDispatcherWithTyping: () => ({
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        }),
        dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
          capturedReplyOpts = args?.replyOptions;
          // Simulate streaming then model error.
          capturedReplyOpts?.onPartialReply?.({ text: "partial" });
          throw new Error("model timeout");
        }) as never,
      });

      // Handler should not throw (outer catch absorbs it).
      const handlerPromise = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      resolveDraftSend?.({ messageId: "$draft1", roomId: "!room" });
      await handlerPromise;

      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");

      // After handler exits, draft stream timer must not fire.
      sendSingleTextMessageMatrixMock.mockClear();
      editMessageMatrixMock.mockClear();
      await vi.advanceTimersByTimeAsync(50);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains visible live drafts when generation aborts mid-stream", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    let capturedReplyOpts: ReplyOpts | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: () => ({
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      }),
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        capturedReplyOpts?.onPartialReply?.({ text: "partial" });
        await waitForMatrixState(() => {
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
        });
        throw new Error("model timeout");
      }) as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );

    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no media", payload: {} },
    { name: "blank-only media", payload: { mediaUrls: ["   "] } },
  ])("cleans up empty final drafts with $name", async ({ payload }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    deliverMatrixRepliesMock.mockResolvedValue({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    await deliver(payload, { kind: "final" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(redactEventMock).not.toHaveBeenCalled();

    await finish();

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
  });

  it("skips compaction notices in draft finalization", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Streaming" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Compaction notice should bypass draft path and go to normal delivery.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Compacting...", isCompactionNotice: true }, { kind: "block" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    // Edit should NOT have been called for the compaction notice.
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    {
      name: "an implicit reply with reply mode first",
      replyToMode: "first" as const,
      payload: { text: "Final text", replyToId: "$different_msg" },
    },
    {
      name: "an explicit reply tag with reply mode off",
      replyToMode: "off" as const,
      payload: { text: "Final text", replyToId: "$different_msg", replyToTag: true },
    },
  ])(
    "redacts stale draft when $name targets a different event",
    async ({ replyToMode, payload }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode });
      const { deliver, opts, finish } = await dispatch();

      // Simulate streaming: partial reply creates draft message.
      opts.onPartialReply?.({ text: "Partial reply" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      // Final delivery carries a different replyToId than the draft's.
      deliverMatrixRepliesMock.mockClear();
      await deliver(payload, { kind: "final" });

      expect(editMessageMatrixMock).not.toHaveBeenCalled();
      // Draft should be redacted since it can't change reply relation.
      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
      // Final answer delivered via normal path.
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      await finish();
    },
  );

  it("finalizes the existing draft when an implicit reply is suppressed by off mode", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode: "off" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text", replyToId: "$suppressed_implicit" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledOnce();
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    await finish();
  });

  it("redacts stale draft when final payload intentionally drops reply threading", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode: "first" });
    const { deliver, opts, finish } = await dispatch();

    // A tool payload can consume the first reply slot upstream while draft
    // streaming for the next assistant block still starts from the original
    // reply target.
    await deliver({ text: "tool result", replyToId: "$msg1" }, { kind: "tool" });
    opts.onAssistantMessageStart?.();

    opts.onPartialReply?.({ text: "Partial reply" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("redacts stale draft for media-only finals", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("does not create a throwaway draft for fast media-only finals", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, finish } = await dispatch();

    await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("does not create a throwaway draft for fast error finals", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, finish } = await dispatch();

    await deliver({ text: "Something failed", isError: true } as never, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("redacts existing drafts for text error finals and uses normal delivery", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Something failed", isError: true } as never, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it.each([
    { name: "a singular attachment", mediaUrls: undefined },
    { name: "a singular fallback after blank plural entries", mediaUrls: ["   "] },
  ])("reuses partial-draft captions for $name", async ({ mediaUrls }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "screenshot ready" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver(
      {
        text: "screenshot ready",
        mediaUrl: "https://example.com/image.png",
        mediaUrls,
      },
      { kind: "final" },
    );

    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expectEditLiveFlag("$draft1", "screenshot ready", false);
    expect(redactEventMock).not.toHaveBeenCalled();
    expectDeliveredMediaReply();
    await finish();
  });

  it("finalizes quiet drafts before reusing unchanged media captions", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "quiet" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "screenshot ready" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver(
      {
        text: "screenshot ready",
        mediaUrl: "https://example.com/image.png",
      },
      { kind: "final" },
    );

    expectFinalizedPreviewEdit("$draft1", "screenshot ready");
    expect(redactEventMock).not.toHaveBeenCalled();
    expectDeliveredMediaReply();
    await finish();
  });

  it("redacts unchanged media-caption previews before normal final delivery for Matrix mentions", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "@room screenshot ready" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver(
      {
        text: "@room screenshot ready",
        mediaUrl: "https://example.com/image.png",
      },
      { kind: "final" },
    );

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    const deliverParams = requireRecord(
      callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
      "deliver replies params",
    );
    const replies = requireArray(deliverParams.replies, "delivered replies");
    const reply = requireRecord(replies[0], "delivered reply");
    expect(reply.text).toBe("@room screenshot ready");
    expect(reply.mediaUrl).toBe("https://example.com/image.png");
    await finish();
  });

  it("redacts stale draft and sends the final once when a later preview exceeds the event limit", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "1234" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    prepareMatrixSingleTextMock.mockImplementation((text: string) => {
      const trimmedText = text.trim();
      return {
        trimmedText,
        convertedText: trimmedText,
        singleEventLimit: 5,
        fitsInSingleEvent: trimmedText.length <= 5,
      };
    });

    opts.onPartialReply?.({ text: "123456" });
    await deliver({ text: "123456" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    await finish();
  });
});

describe("matrix monitor handler block streaming config", () => {
  it.each<{
    name: string;
    streaming: "off" | "partial" | "quiet";
    blockStreamingEnabled?: boolean;
    disableBlockStreaming: boolean;
  }>([
    {
      name: "keeps final-only delivery when draft streaming is off by default",
      streaming: "off",
      disableBlockStreaming: true,
    },
    {
      name: "keeps block streaming disabled when partial previews are on and block streaming is off",
      streaming: "partial",
      disableBlockStreaming: true,
    },
    {
      name: "keeps block streaming disabled when quiet previews are on and block streaming is off",
      streaming: "quiet",
      disableBlockStreaming: true,
    },
    {
      name: "allows shared block streaming when partial previews and block streaming are both enabled",
      streaming: "partial",
      blockStreamingEnabled: true,
      disableBlockStreaming: false,
    },
    {
      name: "uses shared block streaming when explicitly enabled for Matrix",
      streaming: "off",
      blockStreamingEnabled: true,
      disableBlockStreaming: false,
    },
  ])("$name", async ({ streaming, blockStreamingEnabled, disableBlockStreaming }) => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming,
      ...(blockStreamingEnabled === undefined ? {} : { blockStreamingEnabled }),
      dispatchInboundMessage: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
        },
      ) as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );

    expect(capturedDisableBlockStreaming).toBe(disableBlockStreaming);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
