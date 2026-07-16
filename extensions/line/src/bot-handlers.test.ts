// Line tests cover bot handlers plugin behavior.
import type { webhook } from "@line/bot-sdk";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAccountConfig } from "./types.js";

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

// Avoid pulling in globals/pairing/media dependencies; this suite only asserts
// allowlist/groupPolicy gating and message-context wiring.
vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  buildMentionRegexes: () => [],
  matchesMentionPatterns: () => false,
}));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer:
    ({ upsertPairingRequest }: { upsertPairingRequest: (args: unknown) => Promise<unknown> }) =>
    async ({ senderId, onCreated }: { senderId: string; onCreated?: () => void }) => {
      await upsertPairingRequest({ id: senderId, meta: {} });
      onCreated?.();
    },
}));
vi.mock("openclaw/plugin-sdk/command-auth-native", () => ({
  hasControlCommand: (text: string) => {
    const body = text.trim().toLowerCase();
    return body === "/status" || body.startsWith("/status ");
  },
  resolveControlCommandGate: ({
    hasControlCommand,
    authorizers,
  }: {
    hasControlCommand: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => ({
    commandAuthorized:
      hasControlCommand && authorizers.some((entry) => entry.allowed || !entry.configured),
  }),
}));
vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  resolveAllowlistProviderRuntimeGroupPolicy: ({
    groupPolicy,
    defaultGroupPolicy,
  }: {
    groupPolicy?: string;
    defaultGroupPolicy: string;
  }) => ({
    groupPolicy: groupPolicy ?? defaultGroupPolicy,
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: (cfg: { channels?: { line?: { groupPolicy?: string } } }) =>
    cfg.channels?.line?.groupPolicy ?? "open",
  warnMissingProviderGroupPolicyFallbackOnce: () => {},
}));
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (text: string) => text,
  logVerbose: () => {},
}));
vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  createChannelHistoryWindow: ({ historyMap }: { historyMap: Map<string, HistoryEntry[]> }) => ({
    record: ({
      historyKey,
      limit,
      entry,
    }: {
      historyKey: string;
      limit: number;
      entry: HistoryEntry;
    }) => {
      const existing = historyMap.get(historyKey) ?? [];
      historyMap.set(historyKey, [...existing, entry].slice(-limit));
    },
    buildInboundHistory: ({ historyKey, limit }: { historyKey: string; limit: number }) => {
      if (limit <= 0) {
        return undefined;
      }
      return (historyMap.get(historyKey) ?? []).slice(-limit);
    },
    clear: ({ historyKey }: { historyKey: string }) => {
      historyMap.delete(historyKey);
    },
  }),
  buildInboundHistoryFromMap: ({
    historyMap,
    historyKey,
    limit,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
  }) => {
    if (limit <= 0) {
      return undefined;
    }
    return (historyMap.get(historyKey) ?? []).slice(-limit);
  },
  clearHistoryEntriesIfEnabled: ({
    historyMap,
    historyKey,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
  }) => {
    historyMap.delete(historyKey);
  },
  recordPendingHistoryEntryIfEnabled: ({
    historyMap,
    historyKey,
    limit,
    entry,
  }: {
    historyMap: Map<string, HistoryEntry[]>;
    historyKey: string;
    limit: number;
    entry: HistoryEntry;
  }) => {
    const existing = historyMap.get(historyKey) ?? [];
    historyMap.set(historyKey, [...existing, entry].slice(-limit));
  },
}));
vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: () => ({ agentId: "default" }),
}));

const { readAllowFromStoreMock, upsertPairingRequestMock } = vi.hoisted(() => ({
  readAllowFromStoreMock: vi.fn(async () => [] as string[]),
  upsertPairingRequestMock: vi.fn(async (_args: unknown) => ({ code: "CODE", created: true })),
}));
const downloadLineMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolvePairingIdLabel: () => "lineUserId",
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock("./download.js", () => ({
  downloadLineMedia: downloadLineMediaMock,
}));

vi.mock("./send.js", () => ({
  pushMessageLine: async () => {
    throw new Error("pushMessageLine should not be called from bot-handlers tests");
  },
  replyMessageLine: async () => {
    throw new Error("replyMessageLine should not be called from bot-handlers tests");
  },
}));

const { buildLineMessageContextMock, buildLinePostbackContextMock } = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(async () => ({
    ctxPayload: { From: "line:group:group-1" },
    replyToken: "reply-token",
    route: { agentId: "default" },
    isGroup: true,
    accountId: "default",
  })),
  buildLinePostbackContextMock: vi.fn(async () => null as unknown),
}));

vi.mock("./bot-message-context.js", () => ({
  buildLineMessageContext: buildLineMessageContextMock,
  buildLinePostbackContext: buildLinePostbackContextMock,
  getLineSourceInfo: (source: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  }) => ({
    userId: source.userId,
    groupId: source.type === "group" ? source.groupId : undefined,
    roomId: source.type === "room" ? source.roomId : undefined,
    isGroup: source.type === "group" || source.type === "room",
  }),
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let createLineWebhookReplayCache: typeof import("./bot-handlers.js").createLineWebhookReplayCache;
type LineWebhookContext = Parameters<typeof import("./bot-handlers.js").handleLineWebhookEvents>[1];

const createRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

function createReplayMessageEvent(params: {
  messageId: string;
  groupId: string;
  userId: string;
  webhookEventId: string;
  isRedelivery: boolean;
}) {
  return {
    type: "message",
    message: { id: params.messageId, type: "text", text: "hello", quoteToken: "quote-token" },
    replyToken: "reply-token",
    timestamp: Date.now(),
    source: { type: "group", groupId: params.groupId, userId: params.userId },
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: params.isRedelivery },
  } as MessageEvent;
}

function createTestMessageEvent(params: {
  message: MessageEvent["message"];
  source: MessageEvent["source"];
  webhookEventId: string;
  timestamp?: number;
  replyToken?: string;
  isRedelivery?: boolean;
}) {
  return {
    type: "message",
    message: params.message,
    replyToken: params.replyToken ?? "reply-token",
    timestamp: params.timestamp ?? Date.now(),
    source: params.source,
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: params.isRedelivery ?? false },
  } as MessageEvent;
}

function createLineWebhookTestContext(params: {
  processMessage: LineWebhookContext["processMessage"];
  groupPolicy?: LineAccountConfig["groupPolicy"];
  dmPolicy?: LineAccountConfig["dmPolicy"];
  allowFrom?: LineAccountConfig["allowFrom"];
  groupAllowFrom?: LineAccountConfig["groupAllowFrom"];
  requireMention?: boolean;
  groupHistories?: Map<string, HistoryEntry[]>;
  replayCache?: ReturnType<typeof createLineWebhookReplayCache>;
  accessGroups?: Record<string, { type: "message.senders"; members: Record<string, string[]> }>;
}): Parameters<typeof handleLineWebhookEvents>[1] {
  const allowFrom = params.allowFrom ?? (params.dmPolicy === "open" ? ["*"] : undefined);
  const lineConfig = {
    ...(params.groupPolicy ? { groupPolicy: params.groupPolicy } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    ...(allowFrom ? { allowFrom } : {}),
    ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
  };
  return {
    cfg: {
      ...(params.accessGroups ? { accessGroups: params.accessGroups } : {}),
      channels: { line: lineConfig },
    },
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config",
      config: {
        ...lineConfig,
        ...(params.requireMention === undefined
          ? {}
          : { groups: { "*": { requireMention: params.requireMention } } }),
      },
    },
    runtime: createRuntime(),
    mediaMaxBytes: 1,
    processMessage: params.processMessage,
    ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    ...(params.replayCache ? { replayCache: params.replayCache } : {}),
  };
}

function createOpenGroupReplayContext(
  processMessage: LineWebhookContext["processMessage"],
  replayCache: ReturnType<typeof createLineWebhookReplayCache>,
): Parameters<typeof handleLineWebhookEvents>[1] {
  return createLineWebhookTestContext({
    processMessage,
    groupPolicy: "open",
    requireMention: false,
    replayCache,
  });
}

async function expectGroupMessageBlocked(params: {
  processMessage: LineWebhookContext["processMessage"];
  event: MessageEvent;
  context: Parameters<typeof handleLineWebhookEvents>[1];
}) {
  await handleLineWebhookEvents([params.event], params.context);
  expect(params.processMessage).not.toHaveBeenCalled();
  expect(buildLineMessageContextMock).not.toHaveBeenCalled();
}

async function expectRequireMentionGroupMessageProcessed(event: MessageEvent) {
  const processMessage = vi.fn();
  await handleLineWebhookEvents(
    [event],
    createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
    }),
  );
  expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
  expect(processMessage).toHaveBeenCalledTimes(1);
}

async function startInflightReplayDuplicate(params: {
  event: MessageEvent;
  processMessage: LineWebhookContext["processMessage"];
}) {
  const context = createOpenGroupReplayContext(
    params.processMessage,
    createLineWebhookReplayCache(),
  );
  const firstRun = handleLineWebhookEvents([params.event], context);
  await Promise.resolve();
  const secondRun = handleLineWebhookEvents([params.event], context);
  return { firstRun, secondRun };
}

describe("handleLineWebhookEvents", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents, createLineWebhookReplayCache } = await import("./bot-handlers.js"));
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
    vi.doUnmock("openclaw/plugin-sdk/channel-pairing");
    vi.doUnmock("openclaw/plugin-sdk/command-auth-native");
    vi.doUnmock("openclaw/plugin-sdk/runtime-group-policy");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/reply-history");
    vi.doUnmock("openclaw/plugin-sdk/routing");
    vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
    vi.doUnmock("./download.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("./bot-message-context.js");
    vi.resetModules();
  });

  beforeEach(() => {
    buildLineMessageContextMock.mockReset();
    buildLineMessageContextMock.mockImplementation(async () => ({
      ctxPayload: { From: "line:group:group-1" },
      replyToken: "reply-token",
      route: { agentId: "default" },
      isGroup: true,
      accountId: "default",
    }));
    buildLinePostbackContextMock.mockReset();
    buildLinePostbackContextMock.mockImplementation(async () => null as unknown);
    readAllowFromStoreMock.mockReset();
    readAllowFromStoreMock.mockImplementation(async () => [] as string[]);
    upsertPairingRequestMock.mockReset();
    upsertPairingRequestMock.mockImplementation(async () => ({ code: "CODE", created: true }));
    downloadLineMediaMock.mockReset();
    downloadLineMediaMock.mockImplementation(async () => {
      throw new Error("downloadLineMedia should not be called from bot-handlers tests");
    });
  });
  it("blocks group messages when groupPolicy is disabled", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m1", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "disabled" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "disabled" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when allowlist is empty", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      processMessage,
      event: createTestMessageEvent({
        message: { id: "m2", type: "text", text: "hi", quoteToken: "quote-token" },
        source: { type: "group", groupId: "group-1", userId: "user-2" },
        webhookEventId: "evt-2",
      }),
      context: createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
      }),
    });
  });

  it("allows group messages when sender is in groupAllowFrom", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m3", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-3" },
      mode: "active",
      webhookEventId: "evt-3",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-3"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-3"],
          groups: { "*": { requireMention: false } },
        },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("authorizes group control commands through shared access groups", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m3a", type: "text", text: "/status", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-ag" },
          webhookEventId: "evt-3a",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:line-operators"],
        requireMention: true,
        accessGroups: {
          "line-operators": {
            type: "message.senders",
            members: { line: ["user-ag"] },
          },
        },
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("does not bypass requireMention for a plain allowlisted message with an inline slash token", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m-bypass-1", type: "text", text: "cd /home", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-cmd" },
          webhookEventId: "evt-bypass-1",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-cmd"],
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("still bypasses requireMention for an allowlisted real control command", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m-bypass-2", type: "text", text: "/status", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-cmd" },
          webhookEventId: "evt-bypass-2",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-cmd"],
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps command authorization for mentioned group text with an inline command token", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-bypass-mentioned",
            type: "text",
            text: "@Bot please check /status",
            mention: {
              mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }],
            },
          } as MessageEvent["message"],
          source: { type: "group", groupId: "group-1", userId: "user-cmd" },
          webhookEventId: "evt-bypass-mentioned",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-cmd"],
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ commandAuthorized: true }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks unauthorized group control commands even when an open group sender is allowed", async () => {
    const processMessage = vi.fn();
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: { id: "m3b", type: "text", text: "/status", quoteToken: "quote-token" },
          source: { type: "group", groupId: "group-1", userId: "user-open" },
          webhookEventId: "evt-3b",
        }),
      ],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("blocks group sender not in groupAllowFrom without consulting the DM pairing store", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1", userId: "user-store" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-group"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("does not use the DM allowlist when group allowlist policy has no group entries", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      processMessage,
      event: createReplayMessageEvent({
        messageId: "m5c",
        groupId: "group-1",
        userId: "user-open-dm",
        webhookEventId: "evt-5c",
        isRedelivery: false,
      }),
      context: createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "allowlist",
        requireMention: false,
      }),
    });
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("blocks group messages without sender id when groupPolicy is allowlist", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5a", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-1" },
      mode: "active",
      webhookEventId: "evt-5a",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-5"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "allowlist", groupAllowFrom: ["user-5"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("does not authorize group messages from DM pairing-store entries when group allowlist is empty", async () => {
    const processMessage = vi.fn();
    await expectGroupMessageBlocked({
      processMessage,
      event: createTestMessageEvent({
        message: { id: "m5b", type: "text", text: "hi", quoteToken: "quote-token" },
        source: { type: "group", groupId: "group-1", userId: "user-5" },
        webhookEventId: "evt-5b",
      }),
      context: {
        cfg: { channels: { line: { groupPolicy: "allowlist" } } },
        account: {
          accountId: "default",
          enabled: true,
          channelAccessToken: "token",
          channelSecret: "secret",
          tokenSource: "config",
          config: {
            dmPolicy: "pairing",
            allowFrom: [],
            groupPolicy: "allowlist",
            groupAllowFrom: [],
          },
        },
        runtime: createRuntime(),
        mediaMaxBytes: 1,
        processMessage,
      },
    });
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("blocks group messages when wildcard group config disables groups", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m4", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-2", userId: "user-4" },
      mode: "active",
      webhookEventId: "evt-4",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { groupPolicy: "open" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { groupPolicy: "open", groups: { "*": { enabled: false } } },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("scopes DM pairing requests to accountId", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m5", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-5" },
      mode: "active",
      webhookEventId: "evt-5",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "pairing", allowFrom: ["user-owner"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(processMessage).not.toHaveBeenCalled();
    const pairingRequest = (upsertPairingRequestMock.mock.calls as unknown[][])[0]?.[0] as
      | { accountId?: string; channel?: string; id?: string }
      | undefined;
    expect(pairingRequest?.channel).toBe("line");
    expect(pairingRequest?.id).toBe("user-5");
    expect(pairingRequest?.accountId).toBe("default");
  });

  it("does not authorize DM senders from another account's pairing-store entries", async () => {
    const processMessage = vi.fn();
    readAllowFromStoreMock.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[2] as string | undefined;
      if (accountId === "work") {
        return [];
      }
      return ["cross-account-user"];
    });
    upsertPairingRequestMock.mockResolvedValue({ code: "CODE", created: false });

    const event = {
      type: "message",
      message: { id: "m6", type: "text", text: "hi" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "user", userId: "cross-account-user" },
      mode: "active",
      webhookEventId: "evt-6",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line: { dmPolicy: "pairing" } } },
      account: {
        accountId: "work",
        enabled: true,
        channelAccessToken: "token-work", // pragma: allowlist secret
        channelSecret: "secret-work", // pragma: allowlist secret
        tokenSource: "config",
        config: { dmPolicy: "pairing" },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
    });

    expect(readAllowFromStoreMock).toHaveBeenCalledWith("line", undefined, "work");
    expect(processMessage).not.toHaveBeenCalled();
    const pairingRequest = (upsertPairingRequestMock.mock.calls as unknown[][])[0]?.[0] as
      | { accountId?: string; channel?: string; id?: string }
      | undefined;
    expect(pairingRequest?.channel).toBe("line");
    expect(pairingRequest?.id).toBe("cross-account-user");
    expect(pairingRequest?.accountId).toBe("work");
  });

  it("deduplicates replayed webhook events by webhookEventId before processing", async () => {
    const processMessage = vi.fn();
    const event = createReplayMessageEvent({
      messageId: "m-replay",
      groupId: "group-replay",
      userId: "user-replay",
      webhookEventId: "evt-replay-1",
      isRedelivery: true,
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips concurrent redeliveries while the first event is still processing", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      messageId: "m-inflight",
      groupId: "group-inflight",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-1",
      isRedelivery: true,
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    resolveFirst?.();
    await Promise.all([firstRun, secondRun]);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("commits in-flight failures so concurrent duplicates do not retry", async () => {
    let rejectFirst: ((err: Error) => void) | undefined;
    const firstDone = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const processMessage = vi.fn(async () => {
      await firstDone;
    });
    const event = createReplayMessageEvent({
      messageId: "m-inflight-fail",
      groupId: "group-inflight",
      userId: "user-inflight",
      webhookEventId: "evt-inflight-fail-1",
      isRedelivery: true,
    });
    const { firstRun, secondRun } = await startInflightReplayDuplicate({ event, processMessage });
    const firstFailure = expect(firstRun).rejects.toThrow("transient inflight failure");
    rejectFirst?.(new Error("transient inflight failure"));

    await firstFailure;
    await expect(secondRun).resolves.toBeUndefined();
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates redeliveries by LINE message id when webhookEventId changes", async () => {
    const processMessage = vi.fn();
    const event = {
      type: "message",
      message: { id: "m-dup-1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source: { type: "group", groupId: "group-dup", userId: "user-dup" },
      mode: "active",
      webhookEventId: "evt-dup-1",
      deliveryContext: { isRedelivery: false },
    } as MessageEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: {
        channels: { line: { groupPolicy: "allowlist", groupAllowFrom: ["user-dup"] } },
      },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-dup"],
          groups: { "*": { requireMention: false } },
        },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          webhookEventId: "evt-dup-redelivery",
          deliveryContext: { isRedelivery: true },
        } as MessageEvent,
      ],
      context,
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates postback redeliveries by webhookEventId when replyToken changes", async () => {
    const processMessage = vi.fn();
    buildLinePostbackContextMock.mockResolvedValue({
      ctxPayload: { From: "line:user:user-postback" },
      route: { agentId: "default" },
      isGroup: false,
      accountId: "default",
    });
    const event = {
      type: "postback",
      postback: { data: "action=confirm" },
      replyToken: "reply-token-1",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-postback" },
      mode: "active",
      webhookEventId: "evt-postback-1",
      deliveryContext: { isRedelivery: false },
    } as PostbackEvent;

    const context: Parameters<typeof handleLineWebhookEvents>[1] = {
      cfg: { channels: { line: { dmPolicy: "open", allowFrom: ["*"] } } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: { dmPolicy: "open", allowFrom: ["*"] },
      },
      runtime: createRuntime(),
      mediaMaxBytes: 1,
      processMessage,
      replayCache: createLineWebhookReplayCache(),
    };

    await handleLineWebhookEvents([event], context);
    await handleLineWebhookEvents(
      [
        {
          ...event,
          replyToken: "reply-token-2",
          deliveryContext: { isRedelivery: true },
        } as PostbackEvent,
      ],
      context,
    );

    expect(buildLinePostbackContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("skips group messages by default when requireMention is not configured", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-default-skip", type: "text", text: "hi there", quoteToken: "q-default" },
      source: { type: "group", groupId: "group-default", userId: "user-default" },
      webhookEventId: "evt-default-skip",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("records unmentioned group messages as pending history", async () => {
    const processMessage = vi.fn();
    const groupHistories = new Map<string, HistoryEntry[]>();
    const event = createTestMessageEvent({
      message: { id: "m-hist-1", type: "text", text: "hello history", quoteToken: "q-hist-1" },
      timestamp: 1700000000000,
      source: { type: "group", groupId: "group-hist-1", userId: "user-hist" },
      webhookEventId: "evt-hist-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        groupHistories,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    const entries = groupHistories.get("group-hist-1");
    expect(entries).toHaveLength(1);
    const entry = entries?.[0];
    expect(entry?.sender).toBe("user:user-hist");
    expect(entry?.body).toBe("hello history");
    expect(entry?.timestamp).toBe(1700000000000);
  });

  it("keeps a group message recorded during a mention turn instead of clearing it", async () => {
    const groupHistories = new Map<string, HistoryEntry[]>();
    let releaseTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const processMessage = vi.fn(() => gate);
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      groupHistories,
    });

    // A plain ambient message is recorded first; the mention turn will consume it.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-past",
            type: "text",
            text: "earlier chatter",
            quoteToken: "test-token-placeholder",
          },
          source: { type: "group", groupId: "grp-race", userId: "user-b" },
          webhookEventId: "evt-past",
          timestamp: 1000,
        }),
      ],
      context,
    );
    expect(groupHistories.get("grp-race")).toHaveLength(1);

    // A mention turn starts and parks in processMessage (agent still running).
    const mentionRun = handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-mention",
            type: "text",
            text: "@Bot summarize",
            quoteToken: "test-token-placeholder",
            mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
          },
          source: { type: "group", groupId: "grp-race", userId: "user-a" },
          webhookEventId: "evt-mention",
          timestamp: 2000,
        }),
      ],
      context,
    );
    await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(1));

    // A concurrent plain message arrives mid-turn and is recorded.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-concurrent",
            type: "text",
            text: "ping",
            quoteToken: "test-token-placeholder",
          },
          source: { type: "group", groupId: "grp-race", userId: "user-c" },
          webhookEventId: "evt-concurrent",
          timestamp: 3000,
        }),
      ],
      context,
    );
    expect(groupHistories.get("grp-race")).toHaveLength(2);

    // Finish the turn; cleanup runs.
    releaseTurn();
    await mentionRun;

    // The turn's context saw exactly the pre-mention window...
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundHistory: [expect.objectContaining({ body: "earlier chatter" })],
      }),
    );
    // ...so cleanup drops "m-past" and the concurrent "m-concurrent" survives.
    expect(groupHistories.get("grp-race")).toEqual([expect.objectContaining({ body: "ping" })]);
  });

  it("keeps a message arriving between the history snapshot and context construction for the next mention", async () => {
    const groupHistories = new Map<string, HistoryEntry[]>();
    let releaseContextBuild: () => void = () => {};
    const contextGate = new Promise<void>((resolve) => {
      releaseContextBuild = resolve;
    });
    const processMessage = vi.fn();
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      groupHistories,
    });

    // An ambient message the mention turn will consume.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-past",
            type: "text",
            text: "earlier chatter",
            quoteToken: "test-token-placeholder",
          },
          source: { type: "group", groupId: "grp-mid", userId: "user-b" },
          webhookEventId: "evt-past",
          timestamp: 1000,
        }),
      ],
      context,
    );

    // The mention turn parks inside buildLineMessageContext: the handler has
    // snapshotted the window, but the turn context does not exist yet.
    buildLineMessageContextMock.mockImplementationOnce(async () => {
      await contextGate;
      return {
        ctxPayload: { From: "line:group:grp-mid" },
        replyToken: "test-auth-token",
        route: { agentId: "default" },
        isGroup: true,
        accountId: "default",
      };
    });
    const mentionRun = handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-mention",
            type: "text",
            text: "@Bot summarize",
            quoteToken: "test-token-placeholder",
            mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
          },
          source: { type: "group", groupId: "grp-mid", userId: "user-a" },
          webhookEventId: "evt-mention",
          timestamp: 2000,
        }),
      ],
      context,
    );
    await vi.waitFor(() => expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1));

    // An ambient message lands in that window and is recorded.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-mid",
            type: "text",
            text: "ping",
            quoteToken: "test-token-placeholder",
          },
          source: { type: "group", groupId: "grp-mid", userId: "user-c" },
          webhookEventId: "evt-mid",
          timestamp: 3000,
        }),
      ],
      context,
    );

    // The turn's context was captured with the snapshot, so it excludes "m-mid".
    expect(buildLineMessageContextMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inboundHistory: [expect.objectContaining({ body: "earlier chatter" })],
      }),
    );

    releaseContextBuild();
    await mentionRun;

    // Cleanup drops only the consumed "m-past"; "m-mid" survives...
    expect(groupHistories.get("grp-mid")).toEqual([expect.objectContaining({ body: "ping" })]);

    // ...and the next mention turn consumes it exactly once.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-mention-2",
            type: "text",
            text: "@Bot again",
            quoteToken: "test-token-placeholder",
            mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
          },
          source: { type: "group", groupId: "grp-mid", userId: "user-a" },
          webhookEventId: "evt-mention-2",
          timestamp: 4000,
        }),
      ],
      context,
    );
    expect(buildLineMessageContextMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inboundHistory: [expect.objectContaining({ body: "ping" })],
      }),
    );
    expect(groupHistories.has("grp-mid")).toBe(false);
  });

  it("keeps group history intact when a mention turn fails, so the retry still has context", async () => {
    const groupHistories = new Map<string, HistoryEntry[]>();
    const processMessage = vi.fn(async () => {
      throw new Error("agent failure");
    });
    const context = createLineWebhookTestContext({
      processMessage,
      groupPolicy: "open",
      requireMention: true,
      groupHistories,
    });

    // An ambient message the turn will consume.
    await handleLineWebhookEvents(
      [
        createTestMessageEvent({
          message: {
            id: "m-ambient",
            type: "text",
            text: "context",
            quoteToken: "test-token-placeholder",
          },
          source: { type: "group", groupId: "grp-fail", userId: "user-b" },
          webhookEventId: "evt-ambient",
          timestamp: 1000,
        }),
      ],
      context,
    );
    expect(groupHistories.get("grp-fail")).toHaveLength(1);

    // A mention turn whose processMessage throws; the handler rethrows after commit.
    await expect(
      handleLineWebhookEvents(
        [
          createTestMessageEvent({
            message: {
              id: "m-mention-fail",
              type: "text",
              text: "@Bot help",
              quoteToken: "test-token-placeholder",
              mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
            },
            source: { type: "group", groupId: "grp-fail", userId: "user-a" },
            webhookEventId: "evt-mention-fail",
            timestamp: 2000,
          }),
        ],
        context,
      ),
    ).rejects.toThrow(/agent failure/);

    // Cleanup runs only after a successful turn, so the failed turn leaves the
    // window intact for the retry.
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(groupHistories.get("grp-fail")).toHaveLength(1);
  });

  it("skips group messages without mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-1", type: "text", text: "hi there", quoteToken: "q-mention-1" },
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-1",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(processMessage).not.toHaveBeenCalled();
    expect(buildLineMessageContextMock).not.toHaveBeenCalled();
  });

  it("processes group messages with bot mention when requireMention is set", async () => {
    const processMessage = vi.fn();
    // Simulate a LINE text message with mention.mentionees containing isSelf=true
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-2",
        type: "text",
        text: "@Bot hi there",
        mention: {
          mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }],
        },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-2",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("processes group messages with @all mention when requireMention is set", async () => {
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-3",
        type: "text",
        text: "@All hi there",
        mention: {
          mentionees: [{ index: 0, length: 4, type: "all" }],
        },
      } as MessageEvent["message"],
      source: { type: "group", groupId: "group-mention", userId: "user-mention" },
      webhookEventId: "evt-mention-3",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("does not apply requireMention gating to DM messages", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: "m-mention-dm", type: "text", text: "hi", quoteToken: "q-mention-dm" },
      source: { type: "user", userId: "user-dm" },
      webhookEventId: "evt-mention-dm",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
        requireMention: true,
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps command authorization for DM text with an inline command token", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: {
        id: "m-command-dm",
        type: "text",
        text: "please check /status",
        quoteToken: "test-token-placeholder",
      },
      source: { type: "user", userId: "user-dm" },
      webhookEventId: "evt-command-dm",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
      }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ commandAuthorized: true }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("forwards LINE file names to media downloads", async () => {
    const processMessage = vi.fn();
    downloadLineMediaMock.mockResolvedValueOnce({
      path: "/tmp/line-media/voice-note.m4a",
      contentType: "audio/x-m4a",
      size: 1234,
    });
    const event = createTestMessageEvent({
      message: {
        id: "file-audio-1",
        type: "file",
        fileName: "voice-note.m4a",
        fileSize: 4096,
      } as MessageEvent["message"],
      source: { type: "user", userId: "user-file-audio" },
      webhookEventId: "evt-file-audio",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        dmPolicy: "open",
      }),
    );

    expect(downloadLineMediaMock).toHaveBeenCalledWith("file-audio-1", "token", 1, {
      originalFilename: "voice-note.m4a",
    });
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [
          {
            path: "/tmp/line-media/voice-note.m4a",
            contentType: "audio/x-m4a",
          },
        ],
      }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("reports failed media materialization to the message-context owner", async () => {
    downloadLineMediaMock.mockRejectedValueOnce(new Error("expired content"));
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: {
        id: "image-failed-1",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-image-failed",
      },
      source: { type: "user", userId: "user-image-failed" },
      webhookEventId: "evt-image-failed",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({ processMessage, dmPolicy: "open" }),
    );

    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ allMedia: [], mediaUnavailable: true }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("allows non-text group messages through when requireMention is set (cannot detect mention)", async () => {
    // Image message -- LINE only carries mention metadata on text messages.
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-img",
        type: "image",
        contentProvider: { type: "line" },
        quoteToken: "q-mention-img",
      },
      source: { type: "group", groupId: "group-1", userId: "user-img" },
      webhookEventId: "evt-mention-img",
    });

    await expectRequireMentionGroupMessageProcessed(event);
  });

  it("does not bypass mention gating when non-bot mention is present with control command", async () => {
    const processMessage = vi.fn();
    // Text message mentions another user (not bot) together with a control command.
    const event = createTestMessageEvent({
      message: {
        id: "m-mention-other",
        type: "text",
        text: "@other !status",
        mention: { mentionees: [{ index: 0, length: 6, type: "user", isSelf: false }] },
      } as unknown as MessageEvent["message"],
      source: { type: "group", groupId: "group-1", userId: "user-other" },
      webhookEventId: "evt-mention-other",
    });

    await handleLineWebhookEvents(
      [event],
      createLineWebhookTestContext({
        processMessage,
        groupPolicy: "open",
        requireMention: true,
      }),
    );

    // Should be skipped because there is a non-bot mention and the bot was not mentioned.
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("keeps replay cache committed after a non-retryable event failure", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const event = createReplayMessageEvent({
      messageId: "m-fail-then-retry",
      groupId: "group-retry",
      userId: "user-retry",
      webhookEventId: "evt-fail-then-retry",
      isRedelivery: false,
    });
    const context = createOpenGroupReplayContext(processMessage, createLineWebhookReplayCache());

    await expect(handleLineWebhookEvents([event], context)).rejects.toThrow("transient failure");
    await handleLineWebhookEvents([event], context);

    expect(buildLineMessageContextMock).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(context.runtime.error).toHaveBeenCalledWith(
      "line: event handler failed: Error: transient failure",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
