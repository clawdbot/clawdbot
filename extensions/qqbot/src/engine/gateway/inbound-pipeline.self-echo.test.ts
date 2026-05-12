import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QQBotInboundAccess } from "../adapter/index.js";
import type { RefIndexEntry } from "../ref/types.js";
import type { InboundPipelineDeps } from "./inbound-context.js";
import { buildInboundContext } from "./inbound-pipeline.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount, GatewayPluginRuntime, ProcessedAttachments } from "./types.js";

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

function makeRuntime(): GatewayPluginRuntime {
  return {
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
      turn: {
        run: vi.fn(async (rawParams: unknown) => {
          const params = rawParams as {
            raw: unknown;
            adapter: {
              ingest: (raw: unknown) => unknown;
              resolveTurn: (...args: unknown[]) => unknown;
            };
          };
          const input = await params.adapter.ingest(params.raw);
          const turn = (await params.adapter.resolveTurn(
            input,
            {
              kind: "message",
              canStartAgentTurn: true,
            },
            {},
          )) as { runDispatch: () => Promise<unknown> };
          return { dispatchResult: await turn.runDispatch() };
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
        resolveInboundAccess: vi.fn(
          (input): QQBotInboundAccess => ({
            state: {
              channelId: "qqbot",
              accountId: "qq-main",
              conversationKind: input.isGroup ? "group" : "direct",
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
              admission: "dispatch",
              decision: "allow",
              decisiveGateId: "activation",
              reasonCode: "activation_allowed",
              graph: { gates: [] },
            },
            senderAccess: {
              allowed: true,
              decision: "allow",
              reasonCode: input.isGroup ? "group_policy_allowed" : "dm_policy_open",
              effectiveAllowFrom: [],
              effectiveGroupAllowFrom: [],
              providerMissingFallbackApplied: false,
            },
            commandAccess: {
              requested: true,
              authorized: true,
              shouldBlockControlCommand: false,
              reasonCode: "command_authorized",
            },
            routeAccess: {
              allowed: true,
            },
            activationAccess: {
              ran: false,
              allowed: true,
              shouldSkip: false,
              reasonCode: "activation_allowed",
            },
          }),
        ),
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

  it("does not block a user message that quotes a bot-authored ref", async () => {
    getRefIndexMock.mockReturnValue({
      content: "previous bot reply",
      senderId: "qq-main",
      timestamp: 1,
      isBot: true,
    });
    const deps = makeDeps();

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
