import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send-mocks.js";
import "./zalo-js.test-mocks.js";
import { resolveZalouserAccountSync } from "./accounts.js";
import { __testing } from "./monitor.js";
import {
  sendDeliveredZalouserMock,
  sendMessageZalouserMock,
  sendSeenZalouserMock,
  sendTypingZalouserMock,
} from "./monitor.send-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

function createAccount(): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
      },
    },
  };
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      zalouser: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: {
          "*": { requireMention: true },
        },
      },
    },
  };
}

const createRuntimeEnv = () => createZalouserRuntimeEnv();

function installRuntime(params: {
  commandAuthorized?: boolean;
  replyPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
}) {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions, ctx }) => {
    await dispatcherOptions.typingCallbacks?.onReplyStart?.();
    if (params.replyPayload) {
      await dispatcherOptions.deliver(params.replyPayload);
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, ctx };
  });
  const resolveCommandAuthorizedFromAuthorizers = vi.fn(
    (input: {
      useAccessGroups: boolean;
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
    }) => {
      if (params.resolveCommandAuthorizedFromAuthorizers) {
        return params.resolveCommandAuthorizedFromAuthorizers(input);
      }
      return params.commandAuthorized ?? false;
    },
  );
  const resolveAgentRoute = vi.fn((input: { peer?: { kind?: string; id?: string } }) => {
    const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
    const peerId = input.peer?.id ?? "1";
    return {
      agentId: "main",
      sessionKey:
        peerKind === "direct" ? "agent:main:main" : `agent:main:zalouser:${peerKind}:${peerId}`,
      accountId: "default",
      mainSessionKey: "agent:main:main",
    };
  });
  const readAllowFromStore = vi.fn(async () => []);
  const readSessionUpdatedAt = vi.fn(
    (_params?: { storePath: string; sessionKey: string }): number | undefined => undefined,
  );
  type ResolvedTurn = Awaited<
    ReturnType<Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]["adapter"]["resolveTurn"]>
  >;
  const dispatchAssembled = vi.fn(async (turn: ResolvedTurn) => {
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    if ("runDispatch" in turn) {
      const dispatchResult = await turn.runDispatch();
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.routeSessionKey,
        dispatchResult,
      };
    }
    const dispatchResult = await turn.dispatchReplyWithBufferedBlockDispatcher({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...turn.dispatcherOptions,
        deliver: async (...args: Parameters<typeof turn.delivery.deliver>) => {
          await turn.delivery.deliver(...args);
        },
        onError: turn.delivery.onError,
      },
      replyOptions: turn.replyOptions,
      replyResolver: turn.replyResolver,
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });
  const runTurn = vi.fn(async (params: Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]) => {
    const input = await params.adapter.ingest(params.raw);
    if (!input) {
      return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
    }
    const resolved = await params.adapter.resolveTurn(
      input,
      {
        kind: "message",
        canStartAgentTurn: true,
      },
      {},
    );
    return await dispatchAssembled(resolved);
  });
  const buildContext = vi.fn(
    (params: Parameters<PluginRuntime["channel"]["turn"]["buildContext"]>[0]) =>
      ({
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        InboundHistory: params.message.inboundHistory,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        BodyForCommands: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        ChatType: params.conversation.kind,
        ConversationLabel: params.conversation.label,
        SenderName: params.sender.name,
        SenderId: params.sender.id,
        Provider: params.provider ?? params.channel,
        Surface: params.surface ?? params.provider ?? params.channel,
        MessageSid: params.messageId,
        MessageSidFull: params.messageIdFull,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        ...params.extra,
      }) as ReturnType<PluginRuntime["channel"]["turn"]["buildContext"]>,
  );
  const buildAgentSessionKey = vi.fn(
    (input: {
      agentId: string;
      channel: string;
      accountId?: string;
      peer?: { kind?: string; id?: string };
      dmScope?: string;
    }) => {
      const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
      const peerId = input.peer?.id ?? "1";
      if (peerKind === "direct") {
        if (input.dmScope === "per-account-channel-peer") {
          return `agent:${input.agentId}:${input.channel}:${input.accountId ?? "default"}:direct:${peerId}`;
        }
        if (input.dmScope === "per-peer") {
          return `agent:${input.agentId}:direct:${peerId}`;
        }
        if (input.dmScope === "main" || !input.dmScope) {
          return "agent:main:main";
        }
      }
      return `agent:${input.agentId}:${input.channel}:${peerKind}:${peerId}`;
    },
  );

  setZalouserRuntime({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
        buildPairingReply: vi.fn(() => "pair"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn((body: string) => body.trim().startsWith("/")),
        resolveCommandAuthorizedFromAuthorizers,
        isControlCommandMessage: vi.fn((body: string) => body.trim().startsWith("/")),
        shouldHandleTextCommands: vi.fn(() => true),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionWithExplicit: vi.fn(
          (input) => input.explicit?.isExplicitlyMentioned === true,
        ),
      },
      groups: {
        resolveRequireMention: vi.fn((input) => {
          const cfg = input.cfg as OpenClawConfig;
          const groupCfg = cfg.channels?.zalouser?.groups ?? {};
          const typedGroupCfg = groupCfg as Record<string, { requireMention?: boolean }>;
          const groupEntry = input.groupId ? typedGroupCfg[input.groupId] : undefined;
          const defaultEntry = typedGroupCfg["*"];
          if (typeof groupEntry?.requireMention === "boolean") {
            return groupEntry.requireMention;
          }
          if (typeof defaultEntry?.requireMention === "boolean") {
            return defaultEntry.requireMention;
          }
          return true;
        }),
      },
      routing: {
        buildAgentSessionKey,
        resolveAgentRoute,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp"),
        readSessionUpdatedAt,
        recordInboundSession: vi.fn(async () => {}),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }) => body),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      turn: {
        run: runTurn as unknown as PluginRuntime["channel"]["turn"]["run"],
        buildContext: buildContext as unknown as PluginRuntime["channel"]["turn"]["buildContext"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 1200),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime);

  return {
    dispatchReplyWithBufferedBlockDispatcher,
    resolveAgentRoute,
    resolveCommandAuthorizedFromAuthorizers,
    readAllowFromStore,
    readSessionUpdatedAt,
    buildAgentSessionKey,
  };
}

function installGroupCommandAuthRuntime() {
  return installRuntime({
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}

async function processGroupControlCommand(params: {
  account: ResolvedZalouserAccount;
  content?: string;
  commandContent?: string;
}) {
  await __testing.processMessage({
    message: createGroupMessage({
      content: params.content ?? "/new",
      commandContent: params.commandContent ?? "/new",
      hasAnyMention: true,
      wasExplicitlyMentioned: true,
    }),
    account: params.account,
    config: createConfig(),
    runtime: createRuntimeEnv(),
  });
}

function createGroupMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "g-1",
    isGroup: true,
    senderId: "123",
    senderName: "Alice",
    groupName: "Team",
    content: "hello",
    timestampMs: Date.now(),
    msgId: "m-1",
    hasAnyMention: false,
    wasExplicitlyMentioned: false,
    canResolveExplicitMention: true,
    implicitMention: false,
    raw: { source: "test" },
    ...overrides,
  };
}

function createDmMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "u-1",
    isGroup: false,
    senderId: "321",
    senderName: "Bob",
    groupName: undefined,
    content: "hello",
    timestampMs: Date.now(),
    msgId: "dm-1",
    raw: { source: "test" },
    ...overrides,
  };
}

describe("zalouser monitor group mention gating", () => {
  beforeEach(() => {
    sendMessageZalouserMock.mockClear();
    sendTypingZalouserMock.mockClear();
    sendDeliveredZalouserMock.mockClear();
    sendSeenZalouserMock.mockClear();
  });

  async function processMessageWithDefaults(params: {
    message: ZaloInboundMessage;
    account?: ResolvedZalouserAccount;
    historyState?: {
      historyLimit: number;
      groupHistories: Map<
        string,
        Array<{ sender: string; body: string; timestamp?: number; messageId?: string }>
      >;
    };
  }) {
    await __testing.processMessage({
      message: params.message,
      account: params.account ?? createAccount(),
      config: createConfig(),
      runtime: createZalouserRuntimeEnv(),
      historyState: params.historyState,
    });
  }

  async function expectSkippedGroupMessage(message?: Partial<ZaloInboundMessage>) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendTypingZalouserMock).not.toHaveBeenCalled();
  }

  async function expectGroupCommandAuthorizers(params: {
    accountConfig: ResolvedZalouserAccount["config"];
    expectedAuthorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveCommandAuthorizedFromAuthorizers } =
      installGroupCommandAuthRuntime();
    await processGroupControlCommand({
      account: {
        ...createAccount(),
        config: params.accountConfig,
      },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const authCall = resolveCommandAuthorizedFromAuthorizers.mock.calls[0]?.[0];
    expect(authCall?.authorizers).toEqual(params.expectedAuthorizers);
  }

  async function processOpenDmMessage(params?: {
    message?: Partial<ZaloInboundMessage>;
    readSessionUpdatedAt?: (input?: {
      storePath: string;
      sessionKey: string;
    }) => number | undefined;
  }) {
    const runtime = installRuntime({
      commandAuthorized: false,
    });
    if (params?.readSessionUpdatedAt) {
      runtime.readSessionUpdatedAt.mockImplementation(params.readSessionUpdatedAt);
    }
    const account = createAccount();
    await processMessageWithDefaults({
      message: createDmMessage(params?.message),
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
    });
    return runtime;
  }

  async function expectDangerousNameMatching(params: {
    dangerouslyAllowNameMatching?: boolean;
    expectedDispatches: number;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createGroupMessage({
        threadId: "g-attacker-001",
        groupName: "Trusted Team",
        senderId: "666",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        content: "ping @bot",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          ...(params.dangerouslyAllowNameMatching ? { dangerouslyAllowNameMatching: true } : {}),
          groupPolicy: "allowlist",
          groupAllowFrom: ["*"],
          groups: {
            "group:g-trusted-001": { enabled: true },
            "Trusted Team": { enabled: true },
          },
        },
      },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
      params.expectedDispatches,
    );
    return dispatchReplyWithBufferedBlockDispatcher;
  }

  async function dispatchGroupMessage(params: {
    commandAuthorized: boolean;
    message: Partial<ZaloInboundMessage>;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: params.commandAuthorized,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(params.message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    return dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
  }

  it("skips unmentioned group messages when requireMention=true", async () => {
    await expectSkippedGroupMessage();
  });

  it("blocks mentioned group messages by default when groupPolicy is omitted", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const cfg: OpenClawConfig = {
      channels: {
        zalouser: {
          enabled: true,
        },
      },
    };
    const account = resolveZalouserAccountSync({ cfg, accountId: "default" });

    await __testing.processMessage({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account,
      config: cfg,
      runtime: createRuntimeEnv(),
    });

    expect(account.config.groupPolicy).toBe("allowlist");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("fails closed when requireMention=true but mention detection is unavailable", async () => {
    await expectSkippedGroupMessage({
      canResolveExplicitMention: false,
      hasAnyMention: false,
      wasExplicitlyMentioned: false,
    });
  });

  it("dispatches explicitly-mentioned group messages and marks WasMentioned", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: false,
      message: {
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        content: "ping @bot",
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-1");
    expect(callArg?.ctx?.OriginatingTo).toBe("zalouser:group:g-1");
    expect(sendTypingZalouserMock).toHaveBeenCalledWith("g-1", {
      profile: "default",
      isGroup: true,
    });
  });

  it("allows authorized control commands to bypass mention gating", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        content: "/status",
        hasAnyMention: false,
        wasExplicitlyMentioned: false,
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
  });

  it("passes long markdown replies through once so formatting happens before chunking", async () => {
    const replyText = `**${"a".repeat(2501)}**`;
    installRuntime({
      commandAuthorized: false,
      replyPayload: { text: replyText },
    });

    await __testing.processMessage({
      message: createDmMessage({
        content: "hello",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZalouserMock).toHaveBeenCalledWith(
      "u-1",
      replyText,
      expect.objectContaining({
        isGroup: false,
        profile: "default",
        textMode: "markdown",
        textChunkMode: "length",
        textChunkLimit: 1200,
      }),
    );
  });

  it("uses commandContent for mention-prefixed control commands", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        content: "@Bot /new",
        commandContent: "/new",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      },
    });
    expect(callArg?.ctx?.CommandBody).toBe("/new");
    expect(callArg?.ctx?.BodyForCommands).toBe("/new");
  });

  it("allows group control commands when only allowFrom is configured", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["123"],
      },
      expectedAuthorizers: [
        { configured: true, allowed: true },
        { configured: true, allowed: true },
      ],
    });
  });

  it("blocks routed allowlist groups without an explicit group sender allowlist", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await __testing.processMessage({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        senderId: "456",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          groupPolicy: "allowlist",
          allowFrom: ["123"],
          groups: {
            "group:g-1": { enabled: true, requireMention: true },
          },
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("blocks group messages when sender is not in groupAllowFrom", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await __testing.processMessage({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          groupPolicy: "allowlist",
          allowFrom: ["999"],
          groupAllowFrom: ["999"],
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not accept a different group id by matching only the mutable group name by default", async () => {
    await expectDangerousNameMatching({ expectedDispatches: 0 });
  });

  it("accepts mutable group-name matches only when dangerouslyAllowNameMatching is enabled", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = await expectDangerousNameMatching({
      dangerouslyAllowNameMatching: true,
      expectedDispatches: 1,
    });
    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-attacker-001");
  });

  it("allows group control commands when sender is in groupAllowFrom", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["999"],
        groupAllowFrom: ["123"],
      },
      expectedAuthorizers: [
        { configured: true, allowed: false },
        { configured: true, allowed: true },
      ],
    });
  });

  it("routes DM messages with direct peer kind", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveAgentRoute, buildAgentSessionKey } =
      await processOpenDmMessage();

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "321" },
      }),
    );
    expect(buildAgentSessionKey).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "321" },
        dmScope: "per-channel-peer",
      }),
    );
    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.SessionKey).toBe("agent:main:zalouser:direct:321");
  });

  it("reuses the legacy DM session key when only the old group-shaped session exists", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = await processOpenDmMessage({
      readSessionUpdatedAt: (input?: { storePath: string; sessionKey: string }) =>
        input?.sessionKey === "agent:main:zalouser:group:321" ? 123 : undefined,
    });

    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.SessionKey).toBe("agent:main:zalouser:group:321");
  });

  it("skips pairing store read for open DM control commands", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    const account = createAccount();
    await __testing.processMessage({
      message: createDmMessage({ content: "/new", commandContent: "/new" }),
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("skips pairing store read for open DM non-command messages", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    const account = createAccount();
    await __testing.processMessage({
      message: createDmMessage({ content: "hello there" }),
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "open",
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("includes skipped group messages as InboundHistory on the next processed message", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const historyState = {
      historyLimit: 5,
      groupHistories: new Map<
        string,
        Array<{ sender: string; body: string; timestamp?: number; messageId?: string }>
      >(),
    };
    const account = createAccount();
    const config = createConfig();
    await __testing.processMessage({
      message: createGroupMessage({
        content: "first unmentioned line",
        hasAnyMention: false,
        wasExplicitlyMentioned: false,
      }),
      account,
      config,
      runtime: createRuntimeEnv(),
      historyState,
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    await __testing.processMessage({
      message: createGroupMessage({
        content: "second line @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account,
      config,
      runtime: createRuntimeEnv(),
      historyState,
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const firstDispatch = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(firstDispatch?.ctx?.InboundHistory).toEqual([
      expect.objectContaining({ sender: "Alice", body: "first unmentioned line" }),
    ]);
    expect(String(firstDispatch?.ctx?.Body ?? "")).toContain("first unmentioned line");

    await __testing.processMessage({
      message: createGroupMessage({
        content: "third line @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account,
      config,
      runtime: createRuntimeEnv(),
      historyState,
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    const secondDispatch = dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0];
    expect(secondDispatch?.ctx?.InboundHistory).toEqual([]);
  });
});
