import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import * as dedup from "./dedup.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async (_params: { event?: unknown }) => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./bot.js", async () => {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  return {
    ...actual,
    handleFeishuMessage: handleFeishuMessageMock,
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./bot.js");
  vi.doUnmock("./monitor.transport.js");
  vi.doUnmock("./thread-bindings.js");
  vi.resetModules();
});

const cfg = {} as ClawdbotConfig;

function makeReactionEvent(
  overrides: Partial<FeishuReactionCreatedEvent> = {},
): FeishuReactionCreatedEvent {
  return {
    message_id: "om_msg1",
    reaction_type: { emoji_type: "THUMBSUP" },
    operator_type: "user",
    user_id: { open_id: "ou_user1" },
    ...overrides,
  };
}

function createFetchedReactionMessage(chatId: string, chatType?: "p2p" | "group" | "private") {
  return {
    messageId: "om_msg1",
    chatId,
    chatType,
    senderOpenId: "ou_bot",
    content: "hello",
    contentType: "text",
  };
}

async function resolveReactionWithLookup(params: {
  event?: FeishuReactionCreatedEvent;
  lookupChatId: string;
  lookupChatType?: "p2p" | "group" | "private";
}) {
  return await resolveReactionSyntheticEvent({
    cfg,
    accountId: "default",
    event: params.event ?? makeReactionEvent(),
    botOpenId: "ou_bot",
    fetchMessage: async () =>
      createFetchedReactionMessage(params.lookupChatId, params.lookupChatType),
    uuid: () => "fixed-uuid",
  });
}

async function resolveNonBotReaction(params?: { cfg?: ClawdbotConfig; uuid?: () => string }) {
  return await resolveReactionSyntheticEvent({
    cfg: params?.cfg ?? cfg,
    accountId: "default",
    event: makeReactionEvent(),
    botOpenId: "ou_bot",
    fetchMessage: async () => ({
      messageId: "om_msg1",
      chatId: "oc_group",
      chatType: "group",
      senderOpenId: "ou_other",
      senderType: "user",
      content: "hello",
      contentType: "text",
    }),
    ...(params?.uuid ? { uuid: params.uuid } : {}),
  });
}

type FeishuMention = NonNullable<FeishuMessageEvent["message"]["mentions"]>[number];

function buildDebounceConfig(): ClawdbotConfig {
  return {
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 20,
        },
      },
    },
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildDebounceAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createTextEvent(params: {
  messageId: string;
  text: string;
  senderId?: string;
  mentions?: FeishuMention[];
}): FeishuMessageEvent {
  const senderId = params.senderId ?? "ou_sender";
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_group_1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
    },
  };
}

async function setupDebounceMonitor(params?: {
  botOpenId?: string;
  botName?: string;
}): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    cfg: buildDebounceConfig(),
    account: buildDebounceAccount(),
    runtime: createNonExitingRuntimeEnv(),
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: params?.botOpenId ?? "ou_bot",
      botName: params?.botName,
    },
  });

  const onMessage = handlers["im.message.receive_v1"];
  if (!onMessage) {
    throw new Error("missing im.message.receive_v1 handler");
  }
  return onMessage;
}

function getFirstDispatchedEvent(): FeishuMessageEvent {
  const firstCall = handleFeishuMessageMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("missing dispatch call");
  }
  const firstParams = firstCall[0] as { event?: FeishuMessageEvent } | undefined;
  if (!firstParams?.event) {
    throw new Error("missing dispatched event payload");
  }
  return firstParams.event;
}

function expectSingleDispatchedEvent(): FeishuMessageEvent {
  expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
  return getFirstDispatchedEvent();
}

function expectParsedFirstDispatchedEvent(botOpenId = "ou_bot") {
  const dispatched = expectSingleDispatchedEvent();
  return {
    dispatched,
    parsed: parseFeishuMessageEvent(dispatched, botOpenId),
  };
}

function setDedupPassThroughMocks(): void {
  vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
  vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
  vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
}

function createMention(params: { openId: string; name: string; key?: string }): FeishuMention {
  return {
    key: params.key ?? "@_user_1",
    id: { open_id: params.openId },
    name: params.name,
  };
}

function mentionOpenIds(event: FeishuMessageEvent): string[] {
  return (event.message.mentions ?? []).flatMap((mention) =>
    mention.id.open_id ? [mention.id.open_id] : [],
  );
}

function createFeishuMonitorRuntime(params?: {
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
}): PluginRuntime {
  return {
    channel: {
      debounce: {
        createInboundDebouncer: params?.createInboundDebouncer ?? createInboundDebouncer,
        resolveInboundDebounceMs: params?.resolveInboundDebounceMs ?? resolveInboundDebounceMs,
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? hasControlCommand,
      },
    },
  } as unknown as PluginRuntime;
}

async function enqueueDebouncedMessage(
  onMessage: (data: unknown) => Promise<void>,
  event: FeishuMessageEvent,
): Promise<void> {
  await onMessage(event);
  await Promise.resolve();
  await Promise.resolve();
}

function setStaleRetryMocks(messageId = "om_old") {
  vi.spyOn(dedup, "hasProcessedFeishuMessage").mockImplementation(
    async (currentMessageId) => currentMessageId === messageId,
  );
}

describe("resolveReactionSyntheticEvent", () => {
  it("filters app self-reactions", async () => {
    const event = makeReactionEvent({ operator_type: "app" });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("filters Typing reactions", async () => {
    const event = makeReactionEvent({ reaction_type: { emoji_type: "Typing" } });
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
    });
    expect(result).toBeNull();
  });

  it("fails closed when bot open_id is unavailable", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
    });
    expect(result).toBeNull();
  });

  it("drops reactions when reactionNotifications is off", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg: {
        channels: {
          feishu: {
            reactionNotifications: "off",
          },
        },
      } as ClawdbotConfig,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => ({
        messageId: "om_msg1",
        chatId: "oc_group",
        senderOpenId: "ou_bot",
        senderType: "app",
        content: "hello",
        contentType: "text",
      }),
    });
    expect(result).toBeNull();
  });

  it("filters reactions on non-bot messages", async () => {
    const result = await resolveNonBotReaction();
    expect(result).toBeNull();
  });

  it("allows non-bot reactions when reactionNotifications is all", async () => {
    const result = await resolveNonBotReaction({
      cfg: {
        channels: {
          feishu: {
            reactionNotifications: "all",
          },
        },
      } as ClawdbotConfig,
      uuid: () => "fixed-uuid",
    });
    expect(result?.message.message_id).toBe("om_msg1:reaction:THUMBSUP:fixed-uuid");
  });

  it("drops unverified reactions when sender verification times out", async () => {
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "default",
      event,
      botOpenId: "ou_bot",
      verificationTimeoutMs: 1,
      fetchMessage: async () =>
        await new Promise<never>(() => {
          // Never resolves
        }),
    });
    expect(result).toBeNull();
  });

  it("uses event chat context when provided", async () => {
    const result = await resolveReactionWithLookup({
      event: makeReactionEvent({
        chat_id: "oc_group_from_event",
        chat_type: "group",
      }),
      lookupChatId: "oc_group_from_lookup",
    });

    expect(result).toEqual({
      sender: {
        sender_id: { open_id: "ou_user1" },
        sender_type: "user",
      },
      message: {
        message_id: "om_msg1:reaction:THUMBSUP:fixed-uuid",
        chat_id: "oc_group_from_event",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({
          text: "[reacted with THUMBSUP to message om_msg1]",
        }),
      },
    });
  });

  it("falls back to reacted message chat_id when event chat_id is absent", async () => {
    const result = await resolveReactionWithLookup({
      lookupChatId: "oc_group_from_lookup",
      lookupChatType: "group",
    });

    expect(result?.message.chat_id).toBe("oc_group_from_lookup");
    expect(result?.message.chat_type).toBe("group");
  });

  it("falls back to sender p2p chat when lookup returns empty chat_id", async () => {
    const result = await resolveReactionWithLookup({
      lookupChatId: "",
      lookupChatType: "p2p",
    });

    expect(result?.message.chat_id).toBe("p2p:ou_user1");
    expect(result?.message.chat_type).toBe("p2p");
  });

  it("drops reactions without chat context when lookup does not provide chat_type", async () => {
    const result = await resolveReactionWithLookup({
      lookupChatId: "oc_group_from_lookup",
    });

    expect(result).toBeNull();
  });

  it("drops reactions when event chat_type is invalid and lookup cannot recover it", async () => {
    const result = await resolveReactionWithLookup({
      event: makeReactionEvent({
        chat_id: "oc_group_from_event",
        chat_type: "bogus" as "group",
      }),
      lookupChatId: "oc_group_from_lookup",
    });

    expect(result).toBeNull();
  });

  it("logs and drops reactions when lookup throws", async () => {
    const log = vi.fn();
    const event = makeReactionEvent();
    const result = await resolveReactionSyntheticEvent({
      cfg,
      accountId: "acct1",
      event,
      botOpenId: "ou_bot",
      fetchMessage: async () => {
        throw new Error("boom");
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ignoring reaction on non-bot/unverified message om_msg1"),
    );
  });
});

describe("monitorSingleAccount lifecycle", () => {
  beforeEach(() => {
    createFeishuThreadBindingManagerMock.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    createEventDispatcherMock.mockReset().mockReturnValue({
      register: vi.fn(),
    });
  });

  it("stops the Feishu thread binding manager when the monitor exits", async () => {
    setFeishuRuntime(createFeishuMonitorRuntime());

    await monitorSingleAccount({
      cfg: buildDebounceConfig(),
      account: buildDebounceAccount(),
      runtime: createNonExitingRuntimeEnv(),
      botOpenIdSource: {
        kind: "prefetched",
        botOpenId: "ou_bot",
      },
    });

    const manager = createFeishuThreadBindingManagerMock.mock.results[0]?.value as
      | { stop: ReturnType<typeof vi.fn> }
      | undefined;
    expect(manager?.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the Feishu thread binding manager when setup fails before transport starts", async () => {
    setFeishuRuntime(createFeishuMonitorRuntime());
    createEventDispatcherMock.mockReturnValue({
      get register() {
        throw new Error("register failed");
      },
    });

    await expect(
      monitorSingleAccount({
        cfg: buildDebounceConfig(),
        account: buildDebounceAccount(),
        runtime: createNonExitingRuntimeEnv(),
        botOpenIdSource: {
          kind: "prefetched",
          botOpenId: "ou_bot",
        },
      }),
    ).rejects.toThrow("register failed");

    const manager = createFeishuThreadBindingManagerMock.mock.results[0]?.value as
      | { stop: ReturnType<typeof vi.fn> }
      | undefined;
    expect(manager?.stop).toHaveBeenCalledTimes(1);
  });
});

describe("Feishu inbound debounce regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    handleFeishuMessageMock.mockClear();
    setFeishuRuntime(createFeishuMonitorRuntime());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps bot mention when per-message mention keys collide across non-forward messages", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_1",
        text: "first",
        mentions: [createMention({ openId: "ou_user_a", name: "user-a" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_2",
        text: "@bot second",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    const dispatched = expectSingleDispatchedEvent();
    const mergedOpenIds = mentionOpenIds(dispatched);
    expect(mergedOpenIds).toContain("ou_bot");
    expect(mergedOpenIds).not.toContain("ou_user_a");
  });

  it("passes prefetched botName through to handleFeishuMessage", async () => {
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
    const onMessage = await setupDebounceMonitor({ botName: "OpenClaw Bot" });

    await onMessage(
      createTextEvent({
        messageId: "om_name_passthrough",
        text: "@bot hello",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "OpenClaw Bot",
          },
        ],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
    const firstParams = handleFeishuMessageMock.mock.calls[0]?.[0] as
      | { botName?: string }
      | undefined;
    expect(firstParams?.botName).toBe("OpenClaw Bot");
  });

  it("does not synthesize mention-forward intent across separate messages", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_user_mention",
        text: "@alice first",
        mentions: [createMention({ openId: "ou_alice", name: "alice" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_bot_mention",
        text: "@bot second",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    const { dispatched, parsed } = expectParsedFirstDispatchedEvent();
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets).toBeUndefined();
    expect(mentionOpenIds(dispatched)).toEqual(["ou_bot"]);
  });

  it("preserves bot mention signal when the latest merged message has no mentions", async () => {
    setDedupPassThroughMocks();
    const onMessage = await setupDebounceMonitor();

    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_bot_first",
        text: "@bot first",
        mentions: [createMention({ openId: "ou_bot", name: "bot" })],
      }),
    );
    await enqueueDebouncedMessage(
      onMessage,
      createTextEvent({
        messageId: "om_plain_second",
        text: "plain follow-up",
      }),
    );
    await vi.advanceTimersByTimeAsync(25);

    const { parsed } = expectParsedFirstDispatchedEvent();
    expect(parsed.mentionedBot).toBe(true);
  });

  it("excludes previously processed retries from combined debounce text", async () => {
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    setStaleRetryMocks();
    const onMessage = await setupDebounceMonitor();

    await onMessage(createTextEvent({ messageId: "om_old", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_new_1", text: "first" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_old", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_new_2", text: "second" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    const dispatched = expectSingleDispatchedEvent();
    expect(dispatched.message.message_id).toBe("om_new_2");
    const combined = JSON.parse(dispatched.message.content) as { text?: string };
    expect(combined.text).toBe("first\nsecond");
  });

  it("uses latest fresh message id when debounce batch ends with stale retry", async () => {
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    const recordSpy = vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    setStaleRetryMocks("om_old_latest_fresh");
    const onMessage = await setupDebounceMonitor();

    await onMessage(createTextEvent({ messageId: "om_new_latest_fresh", text: "fresh" }));
    await Promise.resolve();
    await Promise.resolve();
    await onMessage(createTextEvent({ messageId: "om_old_latest_fresh", text: "stale" }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    const dispatched = expectSingleDispatchedEvent();
    expect(dispatched.message.message_id).toBe("om_new_latest_fresh");
    const combined = JSON.parse(dispatched.message.content) as { text?: string };
    expect(combined.text).toBe("fresh");
    expect(recordSpy).toHaveBeenCalledWith("om_old_latest_fresh", "default", expect.any(Function));
    expect(recordSpy).not.toHaveBeenCalledWith(
      "om_new_latest_fresh",
      "default",
      expect.any(Function),
    );
  });

  it("releases early event dedupe when debounced dispatch fails", async () => {
    setDedupPassThroughMocks();
    const enqueueMock = vi.fn();
    setFeishuRuntime(
      createFeishuMonitorRuntime({
        createInboundDebouncer: <T>(params: { onError?: (err: unknown, items: T[]) => void }) => ({
          enqueue: async (item: T) => {
            enqueueMock(item);
            params.onError?.(new Error("dispatch failed"), [item]);
          },
          flushKey: async () => {},
        }),
      }),
    );
    const onMessage = await setupDebounceMonitor();
    const event = createTextEvent({ messageId: "om_retryable", text: "hello" });

    await enqueueDebouncedMessage(onMessage, event);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    await enqueueDebouncedMessage(onMessage, event);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
  });

  it("drops duplicate inbound events before they re-enter the debounce pipeline", async () => {
    const onMessage = await setupDebounceMonitor();
    const event = createTextEvent({ messageId: "om_duplicate", text: "hello" });

    await enqueueDebouncedMessage(onMessage, event);
    await vi.advanceTimersByTimeAsync(25);
    await enqueueDebouncedMessage(onMessage, event);
    await vi.advanceTimersByTimeAsync(25);

    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
  });
});
