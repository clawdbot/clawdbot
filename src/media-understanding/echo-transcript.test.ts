// Transcript echo tests cover destination resolution, custom formatting,
// channel filtering, metadata forwarding, and failure swallowing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
  deliverOutboundPayloadsInternal: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) =>
    channel === "voicechat" ||
    channel === "telegram" ||
    channel === "matrix" ||
    channel === "slack",
}));

import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";

const EMPTY_CONFIG = {} as OpenClawConfig;

type ChannelReplyMode = "off" | "first" | "all" | "batched";

function asReplyMode(value: unknown): ChannelReplyMode | undefined {
  if (value === "off" || value === "first" || value === "all" || value === "batched") {
    return value;
  }
  return undefined;
}

function resolveStubReplyToMode(
  channelId: string,
  cfg: OpenClawConfig,
  accountId?: string | null,
  chatType?: string | null,
  unsetDefault: ChannelReplyMode = "off",
): ChannelReplyMode {
  const channels = cfg.channels as
    | Record<
        string,
        {
          replyToMode?: string;
          replyToModeByChatType?: Record<string, string>;
          accounts?: Record<
            string,
            { replyToMode?: string; replyToModeByChatType?: Record<string, string> }
          >;
        }
      >
    | undefined;
  const channel = channels?.[channelId];
  const id = typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  const account = id ? channel?.accounts?.[id] : undefined;
  const chatKey = typeof chatType === "string" && chatType.trim() ? chatType.trim() : undefined;

  const accountChatMode = chatKey
    ? asReplyMode(account?.replyToModeByChatType?.[chatKey])
    : undefined;
  if (accountChatMode) {
    return accountChatMode;
  }
  const accountMode = asReplyMode(account?.replyToMode);
  if (accountMode) {
    return accountMode;
  }
  const channelChatMode = chatKey
    ? asReplyMode(channel?.replyToModeByChatType?.[chatKey])
    : undefined;
  if (channelChatMode) {
    return channelChatMode;
  }
  const mode = asReplyMode(channel?.replyToMode);
  if (mode) {
    return mode;
  }
  return unsetDefault;
}

function createThreadingPluginStub(params: {
  id: string;
  label: string;
  docsPath: string;
  unsetDefault?: ChannelReplyMode;
}) {
  return {
    pluginId: params.id,
    source: "test",
    plugin: {
      id: params.id,
      meta: {
        id: params.id,
        label: params.label,
        selectionLabel: params.label,
        docsPath: params.docsPath,
        blurb: "test stub.",
      },
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        listAccountIds: () => ["acc1", "default"],
        resolveAccount: () => ({}),
      },
      threading: {
        resolveReplyToMode: ({
          cfg,
          accountId,
          chatType,
        }: {
          cfg: OpenClawConfig;
          accountId?: string | null;
          chatType?: string | null;
        }) =>
          resolveStubReplyToMode(params.id, cfg, accountId, chatType, params.unsetDefault ?? "off"),
      },
    },
  };
}

/** Register minimal threading adapters used by echo reply-policy tests. */
function installTelegramThreadingAdapter(): void {
  setActivePluginRegistry(
    createTestRegistry([
      createThreadingPluginStub({
        id: "telegram",
        label: "Telegram",
        docsPath: "/channels/telegram",
        unsetDefault: "off",
      }),
      // Matrix colon-id cases must not fall through to real plugin load (hangs in CI).
      createThreadingPluginStub({
        id: "matrix",
        label: "Matrix",
        docsPath: "/channels/matrix",
        unsetDefault: "off",
      }),
      createThreadingPluginStub({
        id: "slack",
        label: "Slack",
        docsPath: "/channels/slack",
        unsetDefault: "off",
      }),
    ]),
  );
}

function createCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "voicechat", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
    installTelegramThreadingAdapter();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("sends the default formatted transcript to the resolved origin", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
    expect(DEFAULT_ECHO_TRANSCRIPT_FORMAT).toBe('📝 "{transcript}"');
  });

  it("uses a custom format when provided", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "custom message",
      format: "🎤 Heard: {transcript}",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+10000000001",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: "🎤 Heard: custom message" }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("keeps dollar sequences in the transcript literal", async () => {
    await sendTranscriptEcho({
      ctx: createCtx(),
      cfg: EMPTY_CONFIG,
      transcript: "tickets cost $$40, wait for the deal & confirm with $&",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: '📝 "tickets cost $$40, wait for the deal & confirm with $&"' }],
      }),
    );
  });

  it("threads the echo as a reply to the inbound voice message only when reply is opted in", async () => {
    // Telegram adapter defaults unset replyToMode → off; use "all" so echo may thread
    // without consuming a single-use "first" slot reserved for the agent reply.
    const cfg = {
      channels: { telegram: { replyToMode: "all" } },
    } as OpenClawConfig;
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "73299",
        MessageSidFull: "telegram:73299",
      }),
      cfg,
      transcript: "what the agent heard",
      reply: true,
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg,
      channel: "telegram",
      to: "telegram:42",
      accountId: "acc1",
      threadId: undefined,
      replyToId: "73299",
      replyToMode: "all",
      payloads: [
        {
          text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "what the agent heard"),
        },
      ],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("does not thread the echo as a reply when reply is not opted in (default)", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "73299",
        MessageSidFull: "telegram:73299",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "what the agent heard",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "telegram",
      to: "telegram:42",
      accountId: "acc1",
      threadId: undefined,
      payloads: [
        {
          text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "what the agent heard"),
        },
      ],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("skips non-deliverable channels", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ Provider: "internal-system", From: "some-source" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no resolved destination", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: undefined }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("prefers OriginatingTo when From is absent", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({ From: undefined, OriginatingTo: "+19999999999" }),
      cfg: EMPTY_CONFIG,
      transcript: "hello world",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "voicechat",
      to: "+19999999999",
      accountId: "acc1",
      threadId: undefined,
      payloads: [{ text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "hello world") }],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("forwards Telegram account and thread metadata to outbound delivery", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        AccountId: "primary",
        MessageThreadId: 77,
      }),
      cfg: EMPTY_CONFIG,
      transcript: "threaded voice note",
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith({
      cfg: EMPTY_CONFIG,
      channel: "telegram",
      to: "telegram:42",
      accountId: "primary",
      threadId: 77,
      payloads: [
        { text: DEFAULT_ECHO_TRANSCRIPT_FORMAT.replace("{transcript}", "threaded voice note") },
      ],
      bestEffort: true,
      durability: "best_effort",
    });
  });

  it("swallows delivery failures", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    await expect(
      sendTranscriptEcho({
        ctx: createCtx(),
        cfg: EMPTY_CONFIG,
        transcript: "hello world",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveEchoReplyToId via sendTranscriptEcho", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "telegram", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
    installTelegramThreadingAdapter();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("strips only a matching channel: prefix", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSidFull: "telegram:73299",
        Body: "x",
      }),
      // Telegram unset → off; use "all" so reply-id path is exercised without first-slot.
      cfg: { channels: { telegram: { replyToMode: "all" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
    };
    expect(arg.replyToId).toBe("73299");
  });

  it("preserves colon-bearing native ids for non-matching prefixes", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "matrix",
        From: "@user:example.org",
        MessageSid: "$abc:example.org",
        Body: "x",
      }),
      // Matrix default may not thread; force all so reply-id preservation is exercised.
      cfg: { channels: { matrix: { replyToMode: "all" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
    };
    expect(arg.replyToId).toBe("$abc:example.org");
  });

  it("prefers bare MessageSid over a prefixed full id", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: undefined,
        OriginatingTo: "telegram:42",
        MessageSid: "73299",
        MessageSidFull: "telegram:73299",
        Body: "x",
      }),
      cfg: { channels: { telegram: { replyToMode: "all" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
    };
    expect(arg.replyToId).toBe("73299");
  });
});

describe("best-effort boundary for reply-mode resolution", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "telegram", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
    vi.doUnmock("../auto-reply/reply/reply-threading.js");
    vi.resetModules();
  });

  it("swallows reply-mode resolver failures and still does not reject", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["acc1"],
              resolveAccount: () => ({}),
            },
            threading: {
              resolveReplyToMode: () => {
                throw new Error("threading adapter boom");
              },
            },
          },
        },
      ]),
    );

    await expect(
      sendTranscriptEcho({
        ctx: createCtx({
          Provider: "telegram",
          From: "chat:1",
          MessageSid: "73299",
        }),
        cfg: {
          channels: {
            telegram: {
              replyToMode: "all",
            },
          },
        } as OpenClawConfig,
        transcript: "should not throw",
        reply: true,
      }),
    ).resolves.toBeUndefined();

    // Delivery must not proceed after resolver failure (best-effort abort of this send).
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips reply-mode resolution entirely when echoReply is off", async () => {
    let resolved = 0;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["acc1"],
              resolveAccount: () => ({}),
            },
            threading: {
              resolveReplyToMode: () => {
                resolved += 1;
                throw new Error("should not be called");
              },
            },
          },
        },
      ]),
    );

    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        From: "chat:1",
        MessageSid: "73299",
      }),
      cfg: EMPTY_CONFIG,
      transcript: "plain echo",
      reply: false,
    });

    expect(resolved).toBe(0);
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
  });
});

describe("echoReply vs channel replyToMode", () => {
  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "slack", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
    installTelegramThreadingAdapter();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("does not thread when channel replyToMode is off even if echoReply is true", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "slack",
        OriginatingTo: "C1",
        MessageSid: "111.222",
      }),
      cfg: { channels: { slack: { replyToMode: "off" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      payloads?: Array<{ text?: string; replyToId?: string }>;
    };
    expect(arg.replyToId).toBeUndefined();
    expect(arg.payloads?.[0]?.replyToId).toBeUndefined();
    expect(arg.payloads?.[0]?.text).toBe('📝 "hello"');
  });

  it("threads via ambient replyToId when echoReply is true and replyToMode is all", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "1",
        MessageSid: "73299",
      }),
      cfg: { channels: { telegram: { replyToMode: "all" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
      payloads?: Array<{ replyToId?: string }>;
    };
    expect(arg.replyToId).toBe("73299");
    expect(arg.replyToMode).toBe("all");
    expect(arg.payloads?.[0]?.replyToId).toBeUndefined();
  });

  it("does not thread when replyToMode is first (preserve first slot for agent reply)", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "1",
        MessageSid: "73299",
      }),
      cfg: { channels: { telegram: { replyToMode: "first" } } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
      payloads?: Array<{ replyToId?: string }>;
    };
    expect(arg.replyToId).toBeUndefined();
    expect(arg.replyToMode).toBeUndefined();
    expect(arg.payloads?.[0]?.replyToId).toBeUndefined();
  });

  it("does not thread on Telegram when replyToMode is unset (adapter default off)", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "1",
        MessageSid: "73299",
        AccountId: "acc1",
      }),
      // Empty channel config: Telegram threading adapter resolves unset → "off".
      cfg: { channels: { telegram: {} } } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
    };
    expect(arg.replyToId).toBeUndefined();
    expect(arg.replyToMode).toBeUndefined();
  });

  it("threads on Telegram when replyToMode is explicitly enabled", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "telegram",
        OriginatingTo: "1",
        MessageSid: "73299",
        AccountId: "acc1",
      }),
      cfg: {
        channels: {
          telegram: {
            accounts: { acc1: { replyToMode: "all" } },
          },
        },
      } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const arg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
    };
    expect(arg.replyToId).toBe("73299");
    expect(arg.replyToMode).toBe("all");
  });

  it("honors Slack replyToModeByChatType when ChatType is present", async () => {
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "slack",
        OriginatingTo: "channel:C1",
        MessageSid: "1710000.000100",
        ChatType: "direct",
      }),
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
            replyToModeByChatType: { direct: "off", channel: "all" },
          },
        },
      } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const offArg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
    };
    expect(offArg.replyToId).toBeUndefined();
    expect(offArg.replyToMode).toBeUndefined();

    mockDeliverOutboundPayloads.mockClear();
    await sendTranscriptEcho({
      ctx: createCtx({
        Provider: "slack",
        OriginatingTo: "channel:C1",
        MessageSid: "1710000.000100",
        ChatType: "channel",
      }),
      cfg: {
        channels: {
          slack: {
            replyToMode: "off",
            replyToModeByChatType: { direct: "off", channel: "all" },
          },
        },
      } as OpenClawConfig,
      transcript: "hello",
      reply: true,
    });
    const onArg = mockDeliverOutboundPayloads.mock.calls[0]?.[0] as {
      replyToId?: string;
      replyToMode?: string;
    };
    expect(onArg.replyToId).toBe("1710000.000100");
    expect(onArg.replyToMode).toBe("all");
  });
});
