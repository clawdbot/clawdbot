import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { createMatrixRoomMessageHandler, MatrixRetryableInboundError } from "./handler.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
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

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: vi.fn(async () => {}),
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

function writeMatrixSessionMeta(
  storePath: string,
  sessionKey: string,
  origin: {
    chatType: "direct" | "group";
    from: string;
    to: string;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
  },
): void {
  const store = fs.existsSync(storePath)
    ? (JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, Record<string, unknown>>)
    : {};
  const existing = store[sessionKey] ?? {
    sessionId: `sess-${Object.keys(store).length + 1}`,
    updatedAt: Date.now(),
  };
  const existingOrigin =
    typeof existing.origin === "object" && existing.origin !== null
      ? (existing.origin as Record<string, unknown>)
      : {};
  store[sessionKey] = {
    ...existing,
    origin: {
      ...existingOrigin,
      provider: "matrix",
      surface: "matrix",
      accountId: "ops",
      ...origin,
    },
  };
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  prepareMatrixSingleTextMock.mockReset().mockImplementation((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  });
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

describe("matrix monitor handler pairing account scope", () => {
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
      const pairingReminder = sendMessageMatrixMock.mock.calls[0]?.[1];
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

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        accountId: "ops",
      }),
    );
  });

  it("does not enqueue delivered text messages into system events", async () => {
    const dispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: true,
      counts: { final: 1, block: 0, tool: 0 },
    }));
    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig,
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

    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops room messages from configured Matrix bot accounts when allowBots is off", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-off",
        sender: "@ops:example.org",
        body: "hello from bot",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-on",
        sender: "@ops:example.org",
        body: "hello from bot",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("does not treat unconfigured Matrix users as bots when allowBots is off", async () => {
    const { handler, resolveAgentRoute, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      getMemberDisplayName: async () => "human",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$non-bot",
        sender: "@alice:example.org",
        body: "hello from human",
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalled();
  });

  it('drops configured Matrix bot room messages without a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-mentions-off",
        sender: "@ops:example.org",
        body: "hello from bot",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it('accepts configured Matrix bot room messages with a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      mentionRegexes: [/@bot/i],
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-mentions-on",
        sender: "@ops:example.org",
        body: "hello @bot",
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it('accepts configured Matrix bot DMs without a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: true,
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-dm-mentions",
        sender: "@ops:example.org",
        body: "hello from dm bot",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("lets room-level allowBots override a permissive account default", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      roomsConfig: {
        "!room:example.org": { requireMention: false, allowBots: false },
      },
      getMemberDisplayName: async () => "ops-bot",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$bot-room-override",
        sender: "@ops:example.org",
        body: "hello from bot",
      }),
    );

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

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$root",
        ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main:thread:$root",
      }),
    );
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

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: undefined,
        ReplyToId: "$root",
        ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("posts a one-time notice when another Matrix DM room already owns the shared DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      writeMatrixSessionMeta(storePath, "agent:ops:main", {
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

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          msgtype: "m.notice",
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
        }),
      );

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

  it("checks flat DM collision notices against the current DM session key", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-flat-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      writeMatrixSessionMeta(storePath, "agent:ops:matrix:direct:@user:example.org", {
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

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          msgtype: "m.notice",
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks threaded DM collision notices against the parent DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-thread-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      writeMatrixSessionMeta(storePath, "agent:ops:main", {
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

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          msgtype: "m.notice",
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the shared-session notice after user-target outbound metadata overwrites latest room fields", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-stable-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      writeMatrixSessionMeta(storePath, "agent:ops:main", {
        chatType: "direct",
        from: "matrix:@user:example.org",
        to: "room:!other:example.org",
        nativeChannelId: "!other:example.org",
      });
      writeMatrixSessionMeta(storePath, "agent:ops:main", {
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

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          msgtype: "m.notice",
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the shared-session notice when the prior Matrix session metadata is not a DM", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-room-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      writeMatrixSessionMeta(storePath, "agent:ops:main", {
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
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "matrix",
            to: "room:!other:example.org",
            accountId: "ops",
          },
        },
      }),
      "utf8",
    );
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
      expect(recordInboundSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:ops:matrix:channel:!dm:example.org",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the shared-session notice when a Matrix DM is explicitly bound", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-bound-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:bound:session-1": {
          sessionId: "sess-bound",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "matrix",
            to: "room:!other:example.org",
            accountId: "ops",
          },
        },
      }),
      "utf8",
    );
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

  it("uses stable room ids instead of room-declared aliases in group context", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      isDirectMessage: false,
      getRoomInfo: async () => ({
        name: "Ops Room",
        canonicalAlias: "#spoofed:example.org",
        altAliases: ["#alt:example.org"],
      }),
      getMemberDisplayName: async () => "sender",
      dispatchReplyFromConfig: async () => ({
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

    const finalized = vi.mocked(finalizeInboundContext).mock.calls.at(-1)?.[0];
    expect(finalized).toEqual(
      expect.objectContaining({
        GroupSubject: "Ops Room",
        GroupId: "!room:example.org",
      }),
    );
    expect(finalized).not.toHaveProperty("GroupChannel");
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
      finalizeInboundContext: (ctx: unknown) => ctx,
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

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:bound:session-1",
      }),
    );
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

    const handler = createMatrixRoomMessageHandler({
      client: {
        getUserId: async () => "@bot:example.org",
      } as never,
      core: {
        channel: {
          pairing: {
            readAllowFromStore: async () => [] as string[],
            upsertPairingRequest: async () => ({ code: "ABCDEFGH", created: false }),
            buildPairingReply: () => "pairing",
          },
          commands: {
            shouldHandleTextCommands: () => false,
          },
          text: {
            hasControlCommand: () => false,
            resolveMarkdownTableMode: () => "preserve",
          },
          routing: {
            resolveAgentRoute: () => ({
              agentId: "ops",
              channel: "matrix",
              accountId: "ops",
              sessionKey: "agent:ops:main",
              mainSessionKey: "agent:ops:main",
              matchedBy: "binding.account",
            }),
          },
          mentions: {
            buildMentionRegexes: () => [],
          },
          session: {
            resolveStorePath: () => "/tmp/session-store",
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: vi.fn(async () => {}),
          },
          reply: {
            resolveEnvelopeFormatOptions: () => ({}),
            formatAgentEnvelope: ({ body }: { body: string }) => body,
            finalizeInboundContext: (ctx: unknown) => ctx,
            createReplyDispatcherWithTyping: () => ({
              dispatcher: {},
              replyOptions: {},
              markDispatchIdle: () => {},
              markRunComplete: () => {},
            }),
            resolveHumanDelayConfig: () => undefined,
            dispatchReplyFromConfig: async () => ({
              queuedFinal: true,
              counts: { final: 1, block: 0, tool: 0 },
            }),
            withReplyDispatcher: async <T>({
              dispatcher,
              run,
              onSettled,
            }: {
              dispatcher: {
                markComplete?: () => void;
                waitForIdle?: () => Promise<void>;
              };
              run: () => Promise<T>;
              onSettled?: () => void | Promise<void>;
            }) => {
              try {
                return await run();
              } finally {
                dispatcher.markComplete?.();
                try {
                  await dispatcher.waitForIdle?.();
                } finally {
                  await onSettled?.();
                }
              }
            },
          },
          reactions: {
            shouldAckReaction: () => false,
          },
        },
        system: {
          enqueueSystemEvent,
        },
      } as never,
      cfg: {} as never,
      accountId: "ops",
      runtime: {
        error: () => {},
      } as never,
      logger: {
        info: () => {},
        warn: () => {},
      } as never,
      logVerboseMessage: () => {},
      allowFrom: [],
      groupPolicy: "open",
      replyToMode: "off",
      threadReplies: "inbound",
      streaming: "off",
      blockStreamingEnabled: false,
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 8_000,
      mediaMaxBytes: 10_000_000,
      historyLimit: 0,
      startupMs: 0,
      startupGraceMs: 0,
      directTracker: {
        isDirectMessage: async () => false,
      },
      dropPreStartupMessages: true,
      getRoomInfo: async () => ({ altAliases: [] }),
      getMemberDisplayName: async () => "sender",
      needsRoomAliasesForConfig: false,
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

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        accountId: "ops",
      }),
    );
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
            dm: { threadReplies: "off" },
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

describe("matrix monitor handler durable inbound dedupe", () => {
  it("skips replayed inbound events before session recording", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => false),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      inboundDeduper,
      dispatchReplyFromConfig: vi.fn(async () => ({
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

    expect(inboundDeduper.claimEvent).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$dup",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });

  it("commits inbound events only after queued replies finish delivering", async () => {
    const callOrder: string[] = [];
    const inboundDeduper = {
      claimEvent: vi.fn(() => {
        callOrder.push("claim");
        return true;
      }),
      commitEvent: vi.fn(async () => {
        callOrder.push("commit");
      }),
      releaseEvent: vi.fn(() => {
        callOrder.push("release");
      }),
    };
    const recordInboundSession = vi.fn(async () => {
      callOrder.push("record");
    });
    const dispatchReplyFromConfig = vi.fn(async () => {
      callOrder.push("dispatch");
      return {
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      };
    });
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      recordInboundSession,
      dispatchReplyFromConfig,
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
      "run-complete",
      "mark-complete",
      "wait-for-idle",
      "dispatch-idle",
      "commit",
    ]);
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });

  it("releases a claimed event when reply dispatch fails before completion", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => true),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
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
      dispatchReplyFromConfig: vi.fn(async () => ({
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

    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$release-on-error",
    });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("matrix handler failed"));
  });

  it("keeps replay committed when queued final delivery fails after a generic error", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => true),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      dispatchReplyFromConfig: vi.fn(async () => ({
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

    expect(inboundDeduper.commitEvent).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$release-on-final-delivery-error",
    });
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("matrix final reply failed"),
    );
  });

  it.each(["tool", "block"] as const)(
    "keeps replay committed when queued %s delivery fails after a generic error and no final reply exists",
    async (kind) => {
      const inboundDeduper = {
        claimEvent: vi.fn(() => true),
        commitEvent: vi.fn(async () => undefined),
        releaseEvent: vi.fn(),
      };
      const runtime = {
        error: vi.fn(),
      };
      const { handler } = createMatrixHandlerTestHarness({
        inboundDeduper,
        runtime: runtime as never,
        dispatchReplyFromConfig: vi.fn(async () => ({
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

      expect(inboundDeduper.commitEvent).toHaveBeenCalledWith({
        roomId: "!room:example.org",
        eventId: `$release-on-${kind}-delivery-error`,
      });
      expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(`matrix ${kind} reply failed`),
      );
    },
  );

  it("releases a claimed event when queued final delivery fails with an explicit retryable error", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => true),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      runtime: runtime as never,
      dispatchReplyFromConfig: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
      createReplyDispatcherWithTyping: (params) => ({
        dispatcher: {
          markComplete: () => {},
          waitForIdle: async () => {
            params?.onError?.(new MatrixRetryableInboundError("retry send"), { kind: "final" });
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
        eventId: "$retryable-final-delivery-error",
        body: "hello",
      }),
    );

    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
      roomId: "!room:example.org",
      eventId: "$retryable-final-delivery-error",
    });
  });

  it.each(["tool", "block"] as const)(
    "releases a claimed event when queued %s delivery fails with an explicit retryable error and no final reply exists",
    async (kind) => {
      const inboundDeduper = {
        claimEvent: vi.fn(() => true),
        commitEvent: vi.fn(async () => undefined),
        releaseEvent: vi.fn(),
      };
      const { handler } = createMatrixHandlerTestHarness({
        inboundDeduper,
        dispatchReplyFromConfig: vi.fn(async () => ({
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
              params?.onError?.(new MatrixRetryableInboundError("retry send"), { kind });
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
          eventId: `$retryable-${kind}-delivery-error`,
          body: "hello",
        }),
      );

      expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
      expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
        roomId: "!room:example.org",
        eventId: `$retryable-${kind}-delivery-error`,
      });
    },
  );

  it("commits a claimed event when dispatch completes without a final reply", async () => {
    const callOrder: string[] = [];
    const inboundDeduper = {
      claimEvent: vi.fn(() => {
        callOrder.push("claim");
        return true;
      }),
      commitEvent: vi.fn(async () => {
        callOrder.push("commit");
      }),
      releaseEvent: vi.fn(() => {
        callOrder.push("release");
      }),
    };
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
      dispatchReplyFromConfig: vi.fn(async () => {
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
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      isCompactionNotice?: boolean;
      replyToId?: string;
    },
    info: { kind: string },
  ) => Promise<void>;
  type ReplyOpts = {
    onPartialReply?: (payload: { text: string }) => void;
    onBlockReplyQueued?: (
      payload: {
        text?: string;
        isCompactionNotice?: boolean;
      },
      context?: { assistantMessageIndex?: number },
    ) => Promise<void> | void;
    onAssistantMessageStart?: () => void;
    disableBlockStreaming?: boolean;
  };

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet";
  }) {
    let capturedDeliver: DeliverFn | undefined;
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
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(true);

    const redactEventMock = vi.fn(async () => "$redacted");

    const { handler } = createMatrixHandlerTestHarness({
      streaming: opts?.streaming ?? "quiet",
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      replyToMode: opts?.replyToMode ?? "off",
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        capturedDeliver = params?.deliver as DeliverFn | undefined;
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
      dispatchReplyFromConfig: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        notifyCaptured();
        // Block until the test is done exercising callbacks.
        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
      withReplyDispatcher: async <T>(params: {
        dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
        run: () => Promise<T>;
        onSettled?: () => void | Promise<void>;
      }) => {
        const result = await params.run();
        await params.onSettled?.();
        return result;
      },
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
        opts: capturedReplyOpts!,
        // Release the run gate and wait for the handler to finish
        // (including the finally block that stops the draft stream).
        finish: async () => {
          resolveRunGate?.();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock };
  }

  it("finalizes a single quiet-preview block in place when block streaming is enabled", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Single block" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Single block",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps partial preview-first finalization on the existing draft when text is unchanged", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "Single block",
      expect.not.objectContaining({
        msgtype: "m.notice",
        includeMentions: false,
      }),
    );

    await deliver({ text: "Single block" }, { kind: "final" });

    // MSC4357: even when text is unchanged, a finalize edit is sent to clear
    // the live marker so supporting clients stop the streaming animation.
    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Single block",
      expect.objectContaining({ live: false }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("still edits partial preview-first drafts when the final text changes", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await deliver({ text: "Single block" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Single block",
      expect.not.objectContaining({ live: false }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("preserves completed blocks by rotating to a new quiet preview", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Block one" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Block one" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Block one",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();

    opts.onAssistantMessageStart?.();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    opts.onPartialReply?.({ text: "Block two" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });

    await deliver({ text: "Block two" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft2",
      "Block two",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("queues late partials behind block-boundary rotation", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
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

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[1]?.[1]).toBe("Beta");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    opts.onPartialReply?.({ text: "AlphaBeta" });
    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "AlphaBeta",
        expect.anything(),
      );
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("falls back to deliverMatrixReplies when final edit fails", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Hello" });
    await vi.waitFor(() => {
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
      await vi.waitFor(() => {
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

  it("resets draft block offsets on assistant message start", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    // Block 1: stream and deliver.
    opts.onPartialReply?.({ text: "Block one" });
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // The draft stream should have received "Block two", not empty string.
    const sentBody = sendSingleTextMessageMatrixMock.mock.calls[0]?.[1];
    expect(sentBody).toBeTruthy();
    await finish();
  });

  it("preserves queued block boundaries across assistant message start", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Beta" });

    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "Beta",
        expect.anything(),
      );
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");

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
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    opts.onAssistantMessageStart?.();
    await opts.onBlockReplyQueued?.({ text: "Alpha" }, { assistantMessageIndex: 1 });
    opts.onPartialReply?.({ text: "Beta" });

    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "Beta",
        expect.anything(),
      );
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");

    await deliver({ text: "Beta" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps queued block boundaries ordered while Matrix deliveries drain", async () => {
    const { dispatch } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Alpha");

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

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft3",
      roomId: "!room",
    });
    await deliver({ text: "Beta" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Gamma");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft2",
      "Beta",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );

    await finish();
  });

  it("stops draft stream on handler error (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      sendSingleTextMessageMatrixMock
        .mockReset()
        .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
      editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
      deliverMatrixRepliesMock.mockReset().mockResolvedValue(true);
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
        dispatchReplyFromConfig: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
          capturedReplyOpts = args?.replyOptions;
          // Simulate streaming then model error.
          capturedReplyOpts?.onPartialReply?.({ text: "partial" });
          await vi.waitFor(() => {
            expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
          });
          throw new Error("model timeout");
        }) as never,
        withReplyDispatcher: async <T>(params: {
          dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
          run: () => Promise<T>;
          onSettled?: () => void | Promise<void>;
        }) => {
          const result = await params.run();
          await params.onSettled?.();
          return result;
        },
      });

      // Handler should not throw (outer catch absorbs it).
      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );

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

  it("redacts partial live drafts when generation aborts mid-stream", async () => {
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(true);

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
      dispatchReplyFromConfig: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        capturedReplyOpts?.onPartialReply?.({ text: "partial" });
        await vi.waitFor(() => {
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
        });
        throw new Error("model timeout");
      }) as never,
      withReplyDispatcher: async <T>(params: {
        dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
        run: () => Promise<T>;
        onSettled?: () => void | Promise<void>;
      }) => {
        const result = await params.run();
        await params.onSettled?.();
        return result;
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
    );

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
  });

  it("keeps shutdown cleanup for empty final payloads that send nothing", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    deliverMatrixRepliesMock.mockResolvedValue(false);
    await deliver({}, { kind: "final" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(redactEventMock).not.toHaveBeenCalled();

    await finish();

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
  });

  it("skips compaction notices in draft finalization", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Streaming" });
    await vi.waitFor(() => {
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

  it("redacts stale draft when payload reply target mismatches", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode: "first" });
    const { deliver, opts, finish } = await dispatch();

    // Simulate streaming: partial reply creates draft message.
    opts.onPartialReply?.({ text: "Partial reply" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Final delivery carries a different replyToId than the draft's.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text", replyToId: "$different_msg" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    // Draft should be redacted since it can't change reply relation.
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    // Final answer delivered via normal path.
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("finalizes partial drafts before reusing unchanged media captions", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "@room screenshot ready" });
    await vi.waitFor(() => {
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

    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "@room screenshot ready",
      expect.objectContaining({ live: false }),
    );
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "https://example.com/image.png",
            text: undefined,
          }),
        ],
      }),
    );
    await finish();
  });

  it("finalizes quiet drafts before reusing unchanged media captions", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "quiet" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "@room screenshot ready" });
    await vi.waitFor(() => {
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

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "@room screenshot ready",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "https://example.com/image.png",
            text: undefined,
          }),
        ],
      }),
    );
    await finish();
  });

  it("redacts stale draft and sends the final once when a later preview exceeds the event limit", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "1234" });
    await vi.waitFor(() => {
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
  it("keeps final-only delivery when draft streaming is off by default", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "off",
      dispatchReplyFromConfig: vi.fn(
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

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("keeps block streaming disabled when partial previews are on and block streaming is off", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      dispatchReplyFromConfig: vi.fn(
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

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("keeps block streaming disabled when quiet previews are on and block streaming is off", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "quiet",
      dispatchReplyFromConfig: vi.fn(
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

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("allows shared block streaming when partial previews and block streaming are both enabled", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "partial",
      blockStreamingEnabled: true,
      dispatchReplyFromConfig: vi.fn(
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

    expect(capturedDisableBlockStreaming).toBe(false);
  });

  it("uses shared block streaming when explicitly enabled for Matrix", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      streaming: "off",
      blockStreamingEnabled: true,
      dispatchReplyFromConfig: vi.fn(
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

    expect(capturedDisableBlockStreaming).toBe(false);
  });
});
