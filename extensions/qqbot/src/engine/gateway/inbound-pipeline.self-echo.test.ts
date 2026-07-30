// Qqbot tests cover inbound pipeline.self echo plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QQBotInboundAccess } from "../adapter/index.js";
import type { RefIndexEntry } from "../ref/types.js";
import { MSG_TYPE_QUOTE } from "../utils/text-parsing.js";
import type { ProcessedAttachments } from "./inbound-attachments.js";
import type { InboundPipelineDeps } from "./inbound-context.js";
import { buildInboundContext } from "./inbound-pipeline.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const getRefIndexMock = vi.hoisted(() => vi.fn<(refIdx: string) => RefIndexEntry | null>());
const setRefIndexMock = vi.hoisted(() => vi.fn<(refIdx: string, entry: RefIndexEntry) => void>());
const formatRefEntryForAgentMock = vi.hoisted(() => vi.fn<(entry: RefIndexEntry) => string>());
const processAttachmentsMock = vi.hoisted(() =>
  vi.fn<
    (
      attachments: QueuedMessage["attachments"],
      ctx: { accountId: string; cfg: unknown; log?: unknown },
    ) => Promise<ProcessedAttachments>
  >(),
);

vi.mock("../ref/store.js", () => ({
  getRefIndex: getRefIndexMock,
  setRefIndex: setRefIndexMock,
  formatRefEntryForAgent: formatRefEntryForAgentMock,
}));

vi.mock("./inbound-attachments.js", () => ({
  processAttachments: processAttachmentsMock,
}));

const emptyProcessedAttachments: ProcessedAttachments = {
  attachmentInfo: "",
  imageUrls: [],
  imageMediaTypes: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceAsrReferTexts: [],
  voiceTranscripts: [],
  voiceTranscriptSources: [],
  attachmentLocalPaths: [],
};

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

const allowlistQuoteVisibilityCfg = {
  channels: { qqbot: { contextVisibility: "allowlist" as const } },
};

const emptyAllowlist: QQBotInboundAccess["state"]["allowlists"]["dm"] = {
  rawEntryCount: 0,
  normalizedEntries: [],
  invalidEntries: [],
  disabledEntries: [],
  matchedEntryIds: [],
  hasConfiguredEntries: false,
  hasMatchableEntries: false,
  hasWildcard: false,
  accessGroups: {
    referenced: [],
    matched: [],
    missing: [],
    unsupported: [],
    failed: [],
  },
  match: {
    matched: false,
    matchedEntryIds: [],
  },
};

function makeAccessResult(
  input: { isGroup?: boolean; allowed?: boolean } = {},
): QQBotInboundAccess {
  const allowed = input.allowed ?? true;
  const isGroup = input.isGroup ?? false;
  return {
    state: {
      channelId: "qqbot",
      accountId: "qq-main",
      conversationKind: isGroup ? "group" : "direct",
      event: {
        kind: "message",
        authMode: "inbound",
        mayPair: true,
        hasOriginSubject: false,
        originSubjectMatched: false,
      },
      routeFacts: [],
      allowlists: {
        dm: emptyAllowlist,
        pairingStore: emptyAllowlist,
        group: emptyAllowlist,
        commandOwner: emptyAllowlist,
        commandGroup: emptyAllowlist,
      },
    },
    ingress: {
      admission: allowed ? "dispatch" : "drop",
      decision: allowed ? "allow" : "block",
      decisiveGateId: allowed ? "activation" : "sender",
      reasonCode: allowed
        ? "activation_allowed"
        : isGroup
          ? "group_policy_not_allowlisted"
          : "dm_policy_not_allowlisted",
      graph: { gates: [] },
    },
    senderAccess: {
      allowed,
      decision: allowed ? "allow" : "block",
      reasonCode: allowed
        ? isGroup
          ? "group_policy_allowed"
          : "dm_policy_open"
        : isGroup
          ? "group_policy_not_allowlisted"
          : "dm_policy_not_allowlisted",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
      providerMissingFallbackApplied: false,
    },
    commandAccess: {
      requested: true,
      authorized: allowed,
      shouldBlockControlCommand: false,
      reasonCode: allowed ? "command_authorized" : "control_command_unauthorized",
    },
    routeAccess: {
      allowed,
    },
    activationAccess: {
      ran: false,
      allowed,
      shouldSkip: false,
      reasonCode: allowed ? "activation_allowed" : "activation_skipped",
    },
  };
}

function makeRuntime(): GatewayPluginRuntime {
  return {
    state: {
      openChannelIngressQueue: () => {
        throw new Error("unexpected durable ingress access");
      },
    },
    channel: {
      activity: { record: vi.fn() },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "qqbot:c2c:user-openid",
          accountId: "qq-main",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        finalizeInboundContext: vi.fn((fields: Record<string, unknown>) => fields),
        formatInboundEnvelope: vi.fn(() => "formatted inbound"),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw/qqbot-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      inbound: {
        run: vi.fn(async (rawParams: unknown) => {
          const params = rawParams as {
            raw: unknown;
            adapter: {
              ingest: (raw: unknown) => unknown;
              resolveTurn: (...args: unknown[]) => unknown;
            };
          };
          const input = await params.adapter.ingest(params.raw);
          await params.adapter.resolveTurn(
            input,
            {
              kind: "message",
              canStartAgentTurn: true,
            },
            {},
          );
          return {
            dispatched: true,
            dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
          };
        }),
      },
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
    tts: {
      textToSpeech: vi.fn(),
    },
  };
}

function makeEvent(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "c2c",
    senderId: "user-openid",
    messageId: "msg-1",
    content: "hello",
    timestamp: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<InboundPipelineDeps> = {}): InboundPipelineDeps {
  return {
    account,
    cfg: {},
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: makeRuntime(),
    startTyping: vi.fn(async () => ({ keepAlive: null })),
    adapters: {
      history: {
        recordPendingHistoryEntry: vi.fn(() => []),
        buildPendingHistoryContext: vi.fn(() => ""),
        clearPendingHistory: vi.fn(),
      },
      mentionGate: {
        resolveInboundMentionDecision: vi.fn(() => ({
          effectiveWasMentioned: false,
          shouldSkip: false,
          shouldBypassMention: false,
          implicitMention: false,
        })),
      },
      access: {
        resolveInboundAccess: vi.fn((input): QQBotInboundAccess => makeAccessResult(input)),
        resolveSlashCommandAuthorization: vi.fn(() => true),
      },
      audioConvert: {
        convertSilkToWav: vi.fn(async () => null),
        isVoiceAttachment: vi.fn(() => false),
        formatDuration: vi.fn(() => "0s"),
      },
      outboundAudio: {
        audioFileToSilkBase64: vi.fn(async () => undefined),
        isAudioFile: vi.fn(() => false),
        shouldTranscodeVoice: vi.fn(() => false),
        waitForFile: vi.fn(async () => 0),
      },
      commands: {
        pluginVersion: "0.0.0-test",
        resolveVersion: vi.fn(() => "0.0.0"),
      },
    },
    ...overrides,
  };
}

describe("buildInboundContext bot self-echo suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRefIndexMock.mockReturnValue(null);
    formatRefEntryForAgentMock.mockReturnValue("bot reply");
    processAttachmentsMock.mockResolvedValue(emptyProcessedAttachments);
  });

  it("does not block inbound events whose current msgIdx matches this bot's outbound ref (self-echo handled upstream)", async () => {
    getRefIndexMock.mockReturnValue({
      content: "mirrored reply",
      senderId: "qq-main",
      timestamp: 1,
      isBot: true,
    });
    const deps = makeDeps();

    const inbound = await buildInboundContext(makeEvent({ msgIdx: "REF_BOT" }), deps);

    // Self-echo suppression is handled by the gateway layer upstream;
    // buildInboundContext no longer short-circuits on msgIdx match.
    expect(inbound.blocked).toBe(false);
    expect(deps.startTyping).toHaveBeenCalledTimes(1);
    expect(processAttachmentsMock).toHaveBeenCalledTimes(1);
  });

  it("does not block a restricted user message that quotes this account's bot-authored ref", async () => {
    getRefIndexMock.mockReturnValue({
      content: "previous bot reply",
      senderId: "qq-main",
      timestamp: 1,
      isBot: true,
    });
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });

    const inbound = await buildInboundContext(makeEvent({ refMsgIdx: "REF_BOT" }), deps);

    expect(getRefIndexMock).toHaveBeenCalledWith("REF_BOT");
    expect(formatRefEntryForAgentMock).toHaveBeenCalled();
    expect(inbound.blocked).toBe(false);
    expect(inbound.replyTo).toStrictEqual({
      id: "REF_BOT",
      body: "bot reply",
      sender: "qq-main",
      isQuote: true,
    });
    expect(deps.startTyping).toHaveBeenCalledTimes(1);
    expect(processAttachmentsMock).toHaveBeenCalledTimes(1);
  });

  it("omits cached quoted content from another bot account under restricted policy", async () => {
    getRefIndexMock.mockReturnValue({
      content: "other bot reply",
      senderId: "qq-other",
      timestamp: 1,
      isBot: true,
    });
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });
    deps.adapters.access.resolveInboundAccess = vi.fn(
      (input): QQBotInboundAccess =>
        makeAccessResult({
          isGroup: input.isGroup,
          allowed: input.senderId === "user-openid",
        }),
    );

    const inbound = await buildInboundContext(makeEvent({ refMsgIdx: "REF_OTHER_BOT" }), deps);

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_OTHER_BOT",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("Original content unavailable");
    expect(inbound.agentBody).not.toContain("other bot reply");
  });

  it("omits cache-miss quoted content when restricted policy cannot verify the quoted sender", async () => {
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });

    const inbound = await buildInboundContext(
      makeEvent({
        refMsgIdx: "REF_UNKNOWN",
        msgType: MSG_TYPE_QUOTE,
        msgElements: [{ msg_idx: "REF_UNKNOWN", content: "quoted outsider content" }],
      }),
      deps,
    );

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_UNKNOWN",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("Original content unavailable");
    expect(inbound.agentBody).not.toContain("quoted outsider content");
  });

  it("keeps cache-miss quoted content for open conversations", async () => {
    const deps = makeDeps({
      account: {
        ...account,
        config: { dmPolicy: "open" },
      },
    });

    const inbound = await buildInboundContext(
      makeEvent({
        refMsgIdx: "REF_UNKNOWN",
        msgType: MSG_TYPE_QUOTE,
        msgElements: [{ msg_idx: "REF_UNKNOWN", content: "quoted open content" }],
      }),
      deps,
    );

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_UNKNOWN",
      body: "quoted open content",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("quoted open content");
  });

  it("keeps cache-miss quoted content for all visibility under restricted sender policy", async () => {
    const deps = makeDeps({
      cfg: { channels: { qqbot: { contextVisibility: "all" } } },
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });

    const inbound = await buildInboundContext(
      makeEvent({
        refMsgIdx: "REF_ALL",
        msgType: MSG_TYPE_QUOTE,
        msgElements: [{ msg_idx: "REF_ALL", content: "quoted all-mode content" }],
      }),
      deps,
    );

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_ALL",
      body: "quoted all-mode content",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("quoted all-mode content");
  });

  it("keeps cache-miss quoted content for quote visibility under restricted sender policy", async () => {
    const deps = makeDeps({
      cfg: { channels: { qqbot: { contextVisibility: "allowlist_quote" } } },
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });

    const inbound = await buildInboundContext(
      makeEvent({
        refMsgIdx: "REF_QUOTE",
        msgType: MSG_TYPE_QUOTE,
        msgElements: [{ msg_idx: "REF_QUOTE", content: "quoted quote-mode content" }],
      }),
      deps,
    );

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_QUOTE",
      body: "quoted quote-mode content",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("quoted quote-mode content");
  });

  it("omits cached quoted content when open DM policy is narrowed by allowFrom", async () => {
    getRefIndexMock.mockReturnValue({
      content: "quoted narrowed outsider",
      senderId: "outsider-openid",
      timestamp: 1,
    });
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "open" },
      },
    });
    deps.adapters.access.resolveInboundAccess = vi.fn(
      (input): QQBotInboundAccess =>
        makeAccessResult({
          isGroup: input.isGroup,
          allowed: input.senderId === "user-openid",
        }),
    );

    const inbound = await buildInboundContext(makeEvent({ refMsgIdx: "REF_NARROWED" }), deps);

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_NARROWED",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("Original content unavailable");
    expect(inbound.agentBody).not.toContain("quoted narrowed outsider");
  });

  it("omits cached quoted content when open group policy is narrowed by groupAllowFrom", async () => {
    getRefIndexMock.mockReturnValue({
      content: "quoted narrowed group outsider",
      senderId: "outsider-openid",
      timestamp: 1,
    });
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { groupAllowFrom: ["user-openid"], groupPolicy: "open" },
      },
    });
    const resolveInboundAccessMock = vi.fn(
      (input): QQBotInboundAccess =>
        makeAccessResult({
          isGroup: input.isGroup,
          allowed: input.senderId === "user-openid",
        }),
    );
    deps.adapters.access.resolveInboundAccess = resolveInboundAccessMock;

    const inbound = await buildInboundContext(
      makeEvent({
        type: "group",
        groupOpenid: "group-openid",
        refMsgIdx: "REF_GROUP_NARROWED",
      }),
      deps,
    );

    expect(resolveInboundAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "group-openid",
        groupPolicy: "allowlist",
        isGroup: true,
        senderId: "outsider-openid",
      }),
    );
    expect(inbound.replyTo).toStrictEqual({
      id: "REF_GROUP_NARROWED",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("Original content unavailable");
    expect(inbound.agentBody).not.toContain("quoted narrowed group outsider");
  });

  it("omits cached quoted content when the quoted sender no longer passes restricted policy", async () => {
    getRefIndexMock.mockReturnValue({
      content: "quoted outsider cache",
      senderId: "outsider-openid",
      timestamp: 1,
    });
    const deps = makeDeps({
      cfg: allowlistQuoteVisibilityCfg,
      account: {
        ...account,
        config: { allowFrom: ["user-openid"], dmPolicy: "allowlist" },
      },
    });
    deps.adapters.access.resolveInboundAccess = vi.fn(
      (input): QQBotInboundAccess =>
        makeAccessResult({
          isGroup: input.isGroup,
          allowed: input.senderId === "user-openid",
        }),
    );

    const inbound = await buildInboundContext(makeEvent({ refMsgIdx: "REF_OTHER" }), deps);

    expect(inbound.replyTo).toStrictEqual({
      id: "REF_OTHER",
      isQuote: true,
    });
    expect(inbound.agentBody).toContain("Original content unavailable");
    expect(inbound.agentBody).not.toContain("quoted outsider cache");
    expect(formatRefEntryForAgentMock).not.toHaveBeenCalled();
  });

  it("does not block matching refs from another QQ Bot account", async () => {
    getRefIndexMock.mockReturnValue({
      content: "other bot reply",
      senderId: "qq-other",
      timestamp: 1,
      isBot: true,
    });
    const deps = makeDeps();

    const inbound = await buildInboundContext(makeEvent({ msgIdx: "REF_BOT" }), deps);

    expect(inbound.blocked).toBe(false);
    expect(deps.startTyping).toHaveBeenCalledTimes(1);
    expect(processAttachmentsMock).toHaveBeenCalledTimes(1);
  });
});
