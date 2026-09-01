import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
// Whatsapp tests cover inbound dispatch plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { loadWebMedia } from "../../media.js";
import { deliverWebReply } from "../deliver-reply.js";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isError?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
};

type CapturedDispatchParams = {
  ctx?: unknown;
  dispatcherOptions?: {
    deliver?: (
      payload: CapturedReplyPayload,
      info: { kind: "tool" | "block" | "final" },
    ) => Promise<unknown>;
    onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => Promise<void> | void;
    onSettled?: () => unknown;
  };
  replyOptions?: {
    disableBlockStreaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    suppressTyping?: boolean;
  };
};

const {
  dispatchReplyWithBufferedBlockDispatcherMock,
  deliverInboundReplyWithMessageSendContextMock,
  readAgentRunTerminalOutcomeMock,
  sourceReplyDeliveryModeContexts,
} = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: CapturedDispatchParams) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
  deliverInboundReplyWithMessageSendContextMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
  readAgentRunTerminalOutcomeMock: vi.fn(),
  sourceReplyDeliveryModeContexts: [] as unknown[],
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    readAgentRunTerminalOutcome: readAgentRunTerminalOutcomeMock,
  };
});

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext: deliverInboundReplyWithMessageSendContextMock,
    resolveChannelMessageSourceReplyDeliveryMode: (params: {
      cfg: {
        messages?: {
          visibleReplies?: "automatic" | "message_tool";
          groupChat?: { visibleReplies?: "automatic" | "message_tool" };
        };
      };
      ctx: {
        ChatType?: string;
        CommandSource?: "native" | "text";
        CommandAuthorized?: boolean;
      };
    }) => {
      sourceReplyDeliveryModeContexts.push(params.ctx);
      return params.ctx.CommandSource === "native" ||
        (params.ctx.CommandSource === "text" && params.ctx.CommandAuthorized === true)
        ? "automatic"
        : (params.cfg.messages?.groupChat?.visibleReplies ??
              params.cfg.messages?.visibleReplies) === "automatic"
          ? "automatic"
          : "message_tool_only";
    },
  };
});

vi.mock("./runtime-api.js", async () => {
  return {
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
    getAgentScopedMediaLocalRoots: () => [],
    jidToE164: (value: string) => {
      const phone = value.split("@")[0]?.replace(/[^\d]/g, "");
      return phone ? `+${phone}` : null;
    },
    logVerbose: () => {},
    resolveChunkMode: () => "length",
    resolveIdentityNamePrefix: (cfg: {
      agents?: { list?: Array<{ id?: string; default?: boolean; identity?: { name?: string } }> };
    }) => {
      const agent = cfg.agents?.list?.find((entry) => entry.default) ?? cfg.agents?.list?.[0];
      const name = agent?.identity?.name?.trim();
      return name ? `[${name}]` : undefined;
    },
    resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
    resolveMarkdownTableMode: () => undefined,
    resolveSendableOutboundReplyParts: (payload: {
      text?: string;
      mediaUrls?: string[];
      mediaUrl?: string;
    }) => {
      const urls = [
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : []),
      ];
      return {
        text: payload.text ?? "",
        hasMedia: urls.length > 0,
      };
    },
    resolveTextChunkLimit: () => 4000,
    shouldLogVerbose: () => false,
  };
});

vi.mock("../../media.js", () => ({ loadWebMedia: vi.fn() }));

import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
  prepareWhatsAppInboundContext,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof prepareWhatsAppInboundContext>[0]["route"];
type TestMsg = Parameters<typeof prepareWhatsAppInboundContext>[0]["msg"];
type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;
type TestAdmissionOverride = NonNullable<TestMsgOverrides["admission"]>;

function testReceipt(messageIds: string[]) {
  return {
    ...(messageIds[0] ? { primaryPlatformMessageId: messageIds[0] } : {}),
    platformMessageIds: messageIds,
    parts: messageIds.map((messageId, index) => ({
      platformMessageId: messageId,
      kind: "text" as const,
      index,
    })),
    sentAt: 123,
  };
}

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    channel: "whatsapp",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:direct:+1000",
    mainSessionKey: "agent:main:whatsapp:direct:+1000",
    lastRoutePolicy: "main",
    matchedBy: "default",
    ...overrides,
  };
}

function makeMsg(overrides: TestMsgOverrides = {}): TestMsg {
  const { admission, event, payload, platform, ...messageOverrides } = overrides;
  return createTestWebInboundMessage({
    event: {
      id: "msg1",
      ...event,
    },
    payload: {
      body: "hi",
      ...payload,
    },
    platform: {
      chatJid: "+1000",
      recipientJid: "+2000",
      ...platform,
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "+1000",
      },
      ...admission,
    },
    ...messageOverrides,
  });
}

function collectNonPortablePaths(
  value: unknown,
  path = "inbound",
  seen = new Set<object>(),
): string[] {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return [];
  }
  if (typeof value === "function") {
    return [path];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const symbolPaths = Object.getOwnPropertySymbols(record).map(
    (symbol) => `${path}.${String(symbol)}`,
  );
  return [
    ...symbolPaths,
    ...Object.entries(record).flatMap(([key, child]) =>
      collectNonPortablePaths(child, `${path}.${key}`, seen),
    ),
  ];
}

type PrepareWhatsAppInboundParams = Parameters<typeof prepareWhatsAppInboundContext>[0];
type LegacyTestCommand = Omit<
  NonNullable<PrepareWhatsAppInboundParams["command"]>,
  "authorization"
> & {
  authorized?: boolean;
  authorization?: NonNullable<PrepareWhatsAppInboundParams["command"]>["authorization"];
};

async function buildWhatsAppInboundContext(
  params: Omit<PrepareWhatsAppInboundParams, "command"> & {
    command?: LegacyTestCommand;
  },
) {
  const { command: legacyCommand, ...preparedParams } = params;
  const command = legacyCommand
    ? {
        ...legacyCommand,
        authorization:
          legacyCommand.authorization ??
          (legacyCommand.authorized === undefined
            ? { kind: "not_checked" as const }
            : legacyCommand.authorized
              ? { kind: "authorized" as const }
              : { kind: "denied" as const }),
      }
    : undefined;
  if (!command) {
    return (await prepareWhatsAppInboundContext(preparedParams)).ctxPayload;
  }
  const { authorized: _legacyAuthorized, ...preparedCommand } = command;
  return (
    await prepareWhatsAppInboundContext({
      ...preparedParams,
      command: preparedCommand,
    })
  ).ctxPayload;
}

function directAdmission(conversationId: string): TestAdmissionOverride {
  return {
    conversation: {
      kind: "direct",
      id: conversationId,
    },
    sender: {
      id: conversationId,
    },
  };
}

function groupAdmission(conversationId: string): TestAdmissionOverride {
  return {
    conversation: {
      kind: "group",
      id: conversationId,
    },
    senderAccess: {
      reasonCode: "group_policy_allowed",
    },
  };
}

describe("prepared WhatsApp inbound boundary", () => {
  it("projects from-me messages as the operator's own sender identity", async () => {
    const prepared = await prepareWhatsAppInboundContext({
      combinedBody: "hello from me",
      msg: makeMsg({ platform: { fromMe: true } }),
      route: makeRoute(),
      sender: { id: "+15550001111", name: "Operator" },
    });

    expect(prepared.inbound.sender.isSelf).toBe(true);
    expect(prepared.ctxPayload).toMatchObject({
      SenderId: "+15550001111",
      SenderIsSelf: true,
    });
  });

  it("separates portable facts from WhatsApp transport callbacks", async () => {
    const msg = makeMsg({
      event: { id: "current-1", timestamp: 1_710_000_000 },
      payload: {
        body: "agent body",
        commandBody: "/status",
        media: {
          path: "/tmp/photo.jpg",
          type: "image/jpeg",
          kind: "image",
        },
      },
      admission: groupAdmission("120363000000000000@g.us"),
      groupMention: {
        wasMentioned: false,
        requireMention: false,
      },
      group: {
        subject: "Boundary Room",
        participants: ["15550001111@s.whatsapp.net"],
      },
    });
    const prepared = await prepareWhatsAppInboundContext({
      bodyForAgent: "agent body",
      combinedBody: "formatted agent body",
      command: {
        kind: "text-slash",
        body: "/status",
        authorization: { kind: "denied", reason: "sender_not_allowed" },
      },
      msg,
      route: makeRoute({
        sessionKey: "agent:main:whatsapp:group:120363000000000000@g.us",
      }),
      sender: {
        id: "+15550001111",
        name: "Alice",
        e164: "+15550001111",
      },
      transcript: "prepared transcript",
      mediaTranscribedIndexes: [0],
      visibleReplyTo: {
        id: "quoted-1",
        body: "quoted body",
        sender: { label: "Bob" },
      },
      replyThreading: { implicitCurrentMessage: "allow" },
      suppressMessageReceivedHooks: true,
    });

    expect(prepared.inbound).toMatchObject({
      event: {
        id: "current-1",
        timestamp: 1_710_000_000,
      },
      message: {
        body: "formatted agent body",
        bodyForAgent: "agent body",
        rawBody: "agent body",
        commandBody: "/status",
      },
      conversation: {
        kind: "group",
        id: "120363000000000000@g.us",
        label: "120363000000000000@g.us",
      },
      reply: {
        replyToId: "quoted-1",
      },
      command: {
        kind: "text-slash",
        body: "/status",
        authorization: { kind: "denied", reason: "sender_not_allowed" },
      },
      media: [
        {
          path: "/tmp/photo.jpg",
          contentType: "image/jpeg",
          kind: "image",
          transcribed: true,
        },
      ],
      context: {
        transcript: "prepared transcript",
        groupSubject: "Boundary Room",
        senderE164: "+15550001111",
        replyThreading: { implicitCurrentMessage: "allow" },
      },
    });
    expect(prepared.ctxPayload).toMatchObject({
      ConversationLabel: "120363000000000000@g.us",
      GroupSubject: "Boundary Room",
    });
    expect(collectNonPortablePaths(prepared.inbound)).toEqual([]);
    expect(prepared.inbound).not.toHaveProperty("platform");
    expect(prepared.inbound).not.toHaveProperty("admission");
    expect(prepared.control).toEqual({ messageReceivedHooks: "channel" });

    const transport = buildWhatsAppInboundTransportContext(msg);
    expect(transport).toMatchObject({
      accountId: "default",
      conversationId: "120363000000000000@g.us",
      conversationKind: "group",
      chatJid: "+1000",
      recipientJid: "+2000",
      correlationId: "current-1",
    });
    expect(transport.reply).toBe(msg.platform.reply);
    expect(transport.sendMedia).toBe(msg.platform.sendMedia);
    expect(transport.sendComposing).toBe(msg.platform.sendComposing);
    expect(transport).not.toHaveProperty("wasMentioned");
  });

  it("assigns unique portable identities without inventing native message IDs", async () => {
    const msg = makeMsg({
      event: { id: undefined, timestamp: 1_710_000_000 },
    });
    const params = {
      combinedBody: "hi",
      msg,
      route: makeRoute(),
      sender: { id: "+15550001111" },
    };

    const [first, second] = await Promise.all([
      prepareWhatsAppInboundContext(params),
      prepareWhatsAppInboundContext(params),
    ]);

    expect(first.inbound.event.id).not.toBe(second.inbound.event.id);
    expect(buildWhatsAppInboundTransportContext(msg).correlationId).toBeUndefined();
  });
});

function getCapturedDeliver() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.deliver;
}

function getCapturedOnError() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.onError;
}

function getCapturedOnSettled() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.onSettled;
}

function getCapturedReplyOptions() {
  return (capturedDispatchParams as CapturedDispatchParams)?.replyOptions;
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockArg(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

function requireLastMockArg(
  mock: { mock: { calls: unknown[][] } },
  argIndex: number,
  label: string,
) {
  const callIndex = mock.mock.calls.length - 1;
  return requireMockArg(mock, callIndex, argIndex, label);
}

function expectReplyResultFields(
  deliverReply: { mock: { calls: unknown[][] } },
  fields: Record<string, unknown>,
) {
  const params = requireLastMockArg(deliverReply, 0, "deliver reply params");
  expectRecordFields(requireRecord(params.replyResult, "reply result"), fields);
}

type BufferedReplyParams = Parameters<typeof createWhatsAppReplyPlan>[0];
type BufferedReplyOverrides = Partial<Omit<BufferedReplyParams, "context" | "transport">> & {
  context?: Partial<BufferedReplyParams["context"]>;
  msg?: TestMsg;
  cancelAfterPrepare?: (payload: CapturedReplyPayload) => boolean;
};

function finalizedContext(
  overrides: Partial<BufferedReplyParams["context"]> = {},
): BufferedReplyParams["context"] {
  return { CommandAuthorized: false, ...overrides };
}

function makeReplyLogger(): BufferedReplyParams["replyLogger"] {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as never;
}

function acceptedDeliveryResult() {
  return {
    results: [
      {
        kind: "text" as const,
        messageId: "wa-sent-1",
        keys: [{ id: "wa-sent-1" }],
        providerAccepted: true,
      },
    ],
    receipt: testReceipt(["wa-sent-1"]),
    providerAccepted: true,
  };
}

function unacceptedDeliveryResult() {
  return {
    results: [],
    receipt: testReceipt([]),
    providerAccepted: false,
  };
}

function makePreparedInbound(msg: TestMsg): BufferedReplyParams["inbound"] {
  const admission = msg.admission;
  return {
    channel: "whatsapp",
    event: { id: msg.event.id ?? "msg1", timestamp: msg.event.timestamp },
    from: admission.conversation.id,
    sender: { id: admission.sender.id },
    conversation: {
      kind: admission.conversation.kind,
      id: admission.conversation.id,
    },
    route: {
      agentId: "main",
      accountId: admission.accountId,
      routeSessionKey: makeRoute().sessionKey,
    },
    reply: {
      to: msg.platform.recipientJid,
      originatingTo: admission.conversation.id,
    },
    message: {
      body: msg.payload.body,
      bodyForAgent: msg.payload.body,
      rawBody: msg.payload.commandBody ?? msg.payload.body,
      commandBody: msg.payload.commandBody ?? msg.payload.body,
    },
  };
}

async function dispatchBufferedReply(overrides: BufferedReplyOverrides = {}) {
  const { cancelAfterPrepare, msg = makeMsg(), ...paramOverrides } = overrides;
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { streaming: { block: { enabled: true } } } } } as never,
    connectionId: "conn",
    context: finalizedContext({ Body: "hi" }),
    deliverReply: async () => acceptedDeliveryResult(),
    groupHistories: new Map(),
    groupHistoryKey: "+1000",
    maxMediaBytes: 1,
    inbound: makePreparedInbound(msg),
    replyLogger: makeReplyLogger(),
    replyPipeline: {} as never,
    replyResolver: (async () => undefined) as never,
    route: makeRoute(),
    shouldClearGroupHistory: false,
    transport: buildWhatsAppInboundTransportContext(msg),
  };

  return runWhatsAppReplyPlan(
    {
      ...params,
      ...paramOverrides,
      context: finalizedContext({ ...params.context, ...paramOverrides.context }),
    },
    { cancelAfterPrepare },
  );
}

async function runWhatsAppReplyPlan(
  params: BufferedReplyParams,
  options: Pick<BufferedReplyOverrides, "cancelAfterPrepare"> = {},
): Promise<boolean> {
  const plan = createWhatsAppReplyPlan(params);
  const dispatchResult = await dispatchReplyWithBufferedBlockDispatcherMock({
    ctx: params.context,
    dispatcherOptions: {
      ...plan.dispatcherOptions,
      deliver: async (payload, info) => {
        // The dispatcher fixture retains null as the explicit no-native-reply sentinel.
        const deliveryInput = payload as unknown as Parameters<typeof plan.delivery.deliver>[0];
        const prepared = plan.delivery.preparePayload
          ? await plan.delivery.preparePayload(deliveryInput, info)
          : deliveryInput;
        if (prepared === null) {
          const result = {
            visibleReplySent: false,
            suppression: { reason: "no_visible_payload" as const },
          };
          await plan.delivery.onDelivered?.(deliveryInput, info, result);
          return result;
        }
        const durable =
          typeof plan.delivery.durable === "function"
            ? await plan.delivery.durable(prepared, info)
            : plan.delivery.durable;
        if (durable) {
          const outcome = requireRecord(
            await deliverInboundReplyWithMessageSendContextMock({
              cfg: params.cfg,
              channel: "whatsapp",
              accountId: params.route.accountId,
              agentId: params.route.agentId,
              ctxPayload: params.context,
              payload: prepared,
              info,
              ...durable,
            }),
            "durable outcome",
          );
          if (outcome.status === "failed") {
            const error = outcome.error;
            if (outcome.sentBeforeError === true && error && typeof error === "object") {
              Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
            }
            plan.delivery.onError?.(error, info);
            throw error;
          }
          if (outcome.status === "handled_visible" || outcome.status === "handled_no_send") {
            const result = outcome.delivery as Awaited<ReturnType<typeof plan.delivery.deliver>>;
            await plan.delivery.onDelivered?.(prepared, info, result);
            return result;
          }
        }
        if (options.cancelAfterPrepare?.(prepared)) {
          const result = {
            visibleReplySent: false,
            suppression: { reason: "cancelled_by_message_sending_hook" as const },
          };
          await plan.delivery.onDelivered?.(prepared, info, result);
          return result;
        }
        const result = await plan.delivery.deliver(prepared, info);
        if (result?.finalization) {
          void result.finalization.catch(() => undefined);
        }
        await plan.delivery.onDelivered?.(prepared, info, result);
        return result;
      },
      onError: plan.delivery.onError,
    },
    replyOptions: plan.replyOptions,
  });
  return plan.finalize(dispatchResult);
}

const DEFERRED_TOOL_MEDIA = {
  text: "tool image",
  mediaUrls: ["/tmp/generated.jpg"],
};
const CAPTIONED_MEDIA_REPLACEMENT = {
  text: "captioned replacement",
  mediaUrls: ["/tmp/generated.jpg"],
};

function requireCapturedDeliver(params: CapturedDispatchParams) {
  const deliver = params.dispatcherOptions?.deliver;
  if (!deliver) {
    throw new Error("expected captured deliver callback");
  }
  return deliver;
}

async function dispatchDeferredMediaReplacement(
  overrides: BufferedReplyOverrides,
  media: { deferred: string[]; replacement: string[] } = {
    deferred: DEFERRED_TOOL_MEDIA.mediaUrls,
    replacement: CAPTIONED_MEDIA_REPLACEMENT.mediaUrls,
  },
): Promise<{
  finalization: Promise<unknown>;
  replacement: PromiseSettledResult<unknown>;
}> {
  let finalization: Promise<unknown> | undefined;
  let replacement: PromiseSettledResult<unknown> | undefined;
  dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
    async (params: CapturedDispatchParams) => {
      capturedDispatchParams = params;
      const deliver = requireCapturedDeliver(params);
      const deferred = requireRecord(
        await deliver({ ...DEFERRED_TOOL_MEDIA, mediaUrls: media.deferred }, { kind: "tool" }),
        "deferred media result",
      );
      finalization = deferred.finalization as Promise<unknown>;
      [replacement] = await Promise.allSettled([
        deliver(
          { ...CAPTIONED_MEDIA_REPLACEMENT, mediaUrls: media.replacement },
          { kind: "block" },
        ),
      ]);
      await params.dispatcherOptions?.onSettled?.();
      return { queuedFinal: false, counts: { tool: 1, block: 1, final: 0 } };
    },
  );

  await dispatchBufferedReply(overrides);
  if (!finalization || !replacement) {
    throw new Error("expected deferred media replacement lifecycle");
  }
  return { finalization, replacement };
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    sourceReplyDeliveryModeContexts.length = 0;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
    readAgentRunTerminalOutcomeMock.mockReset().mockReturnValue(undefined);
    deliverInboundReplyWithMessageSendContextMock.mockReset();
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValue({
      status: "unsupported",
      reason: "missing_outbound_handler",
    });
  });

  it("builds a finalized inbound context payload", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        event: { timestamp: 1737158400000 },
        groupMention: { wasMentioned: false, requireMention: false },
        platform: {
          senderName: "Alice",
          senderJid: "alice@s.whatsapp.net",
          senderE164: "+15550002222",
        },
        group: {
          subject: "Test Group",
          participants: [],
        },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Alice",
        e164: "+15550002222",
      },
    });

    expectRecordFields(requireRecord(ctx, "inbound context"), {
      Body: "Alice: hi",
      BodyForAgent: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      Timestamp: 1737158400000,
      SenderId: "+15550002222",
      SenderE164: "+15550002222",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
      WasMentioned: false,
      GroupRequireMention: false,
    });
  });

  it("keeps agent and command bodies independently overridable", async () => {
    const ctx = await buildWhatsAppInboundContext({
      bodyForAgent: "spoken transcript",
      combinedBody: "spoken transcript",
      command: {
        kind: "normal",
        body: "",
        authorized: false,
      },
      msg: makeMsg({
        payload: {
          body: "",
          media: {
            path: "/tmp/voice.ogg",
            type: "audio/ogg; codecs=opus",
            kind: "audio",
          },
        },
      }),
      rawBody: "",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      transcript: "spoken transcript",
    });

    expectRecordFields(requireRecord(ctx, "voice inbound context"), {
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "",
      CommandBody: "",
      RawBody: "",
      Transcript: "spoken transcript",
    });
  });

  it("preserves remote-only inbound media URLs", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "<image>",
      msg: makeMsg({
        payload: {
          body: "<image>",
          media: {
            url: "https://media.example/image.jpg",
            type: "image/jpeg",
          },
        },
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(requireRecord(ctx, "remote media inbound context")).toMatchObject({
      media: [
        expect.objectContaining({
          url: "https://media.example/image.jpg",
          contentType: "image/jpeg",
        }),
      ],
    });
  });

  it("marks authorized text slash commands as text command turns", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "/status",
      command: {
        kind: "text-slash",
        authorized: true,
        body: "/status",
      },
      msg: makeMsg({
        payload: { body: "/status" },
      }),
      rawBody: "/status",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expectRecordFields(requireRecord(ctx, "slash command context"), {
      Body: "/status",
      BodyForAgent: "/status",
      BodyForCommands: "/status",
      CommandBody: "/status",
      RawBody: "/status",
      CommandAuthorized: true,
      CommandSource: "text",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
    });
  });

  it("keeps authorization metadata on normal command-fact turns", async () => {
    const body = "please inspect `/tmp/foo`";
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: body,
      command: {
        kind: "normal",
        authorized: true,
        body,
      },
      msg: makeMsg({ payload: { body } }),
      rawBody: body,
      route: makeRoute(),
      sender: { e164: "+1000" },
    });

    expectRecordFields(requireRecord(ctx, "normal command context"), {
      CommandAuthorized: true,
      CommandSource: undefined,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        commandName: undefined,
        body,
      },
    });
  });

  it("falls back SenderId to SenderE164 when sender id is missing", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      msg: makeMsg({
        platform: {
          senderJid: "",
          senderE164: "+1000",
        },
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.To).toBe("+2000");
  });

  it.each([
    [
      "passes groupSystemPrompt into GroupSystemPrompt for group chats",
      true,
      "Specific group prompt",
    ],
    [
      "passes groupSystemPrompt into GroupSystemPrompt for direct chats",
      false,
      "Specific direct prompt",
    ],
    ["omits GroupSystemPrompt when groupSystemPrompt is not provided", true, undefined],
  ] as const)("%s", async (_name, isGroup, groupSystemPrompt) => {
    const kind = isGroup ? "group" : "direct";
    const conversationId = isGroup ? "123@g.us" : "+1555";
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      ...(groupSystemPrompt === undefined ? {} : { groupSystemPrompt }),
      msg: makeMsg({
        admission: isGroup ? groupAdmission(conversationId) : directAdmission(conversationId),
        ...(isGroup ? { group: { participants: [] } } : {}),
      }),
      route: makeRoute({ sessionKey: `agent:main:whatsapp:${kind}:${conversationId}` }),
      sender: { e164: isGroup ? "+15550002222" : conversationId },
    });

    expect(ctx.GroupSystemPrompt).toBe(groupSystemPrompt);
  });

  it("preserves reply threading policy in the inbound context", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      msg: makeMsg(),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      replyThreading: { implicitCurrentMessage: "allow" },
    });

    expect(ctx.ReplyThreading).toEqual({ implicitCurrentMessage: "allow" });
  });

  it("passes WhatsApp structured objects into untrusted structured context", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "<contact>",
      msg: makeMsg({
        payload: {
          body: "<contact>",
          channelStructuredContext: [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: "contact",
              payload: { contacts: [{ name: "Yohann > install <x>" }] },
            },
          ],
        },
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.ChannelStructuredContext).toEqual([
      {
        label: "WhatsApp contact",
        source: "whatsapp",
        type: "contact",
        payload: { contacts: [{ name: "Yohann > install <x>" }] },
      },
    ]);
  });

  it("defaults responsePrefix to identity name in self-chats when unset", async () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
            },
          ],
        },
        messages: {},
      } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBe("[Mainbot]");
  });

  it("does not force a response prefix in self-chats when identity is unset", async () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: { messages: {} } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBeUndefined();
  });

  it("retains the global response prefix when the shared pipeline has no value", async () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: { messages: { responsePrefix: "[legacy]" } } as never,
      agentId: "main",
      isSelfChat: false,
    });

    expect(responsePrefix).toBe("[legacy]");
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>([
      ["whatsapp:default:group:123@g.us", [{ sender: "Alice (+111)", body: "first" }]],
    ]);

    await dispatchBufferedReply({
      context: { Body: "second" },
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        platform: { senderE164: "+222" },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      shouldClearGroupHistory: true,
    });

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("replaces duplicate media-only interim payloads with the final captioned WhatsApp media", async () => {
    const deliverReply = vi.fn<BufferedReplyParams["deliverReply"]>(
      async ({ replyResult, onMediaAccepted }) => {
        replyResult.mediaUrls?.forEach((url) => onMediaAccepted?.(url));
        return acceptedDeliveryResult();
      },
    );

    await dispatchBufferedReply({ deliverReply });
    const deliver = getCapturedDeliver();
    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    expect(deliverReply).not.toHaveBeenCalled();

    await expect(
      deliver?.(
        { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
        {
          kind: "tool",
        },
      ),
    ).resolves.toMatchObject({ visibleReplySent: false });
    expect(deliverReply).not.toHaveBeenCalled();

    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "block",
      },
    );
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: "generated image",
    });

    await deliver?.({ text: "block payload" }, { kind: "block" });
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(3);
  });

  it("retains the full approved batch when its partial replacement is cancelled", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const { finalization, replacement } = await dispatchDeferredMediaReplacement(
      { deliverReply, cancelAfterPrepare: (payload) => payload.text === "captioned replacement" },
      { deferred: ["/tmp/a.jpg", "/tmp/b.jpg"], replacement: ["/tmp/a.jpg"] },
    );

    expect(replacement).toMatchObject({
      status: "fulfilled",
      value: {
        visibleReplySent: false,
        suppression: { reason: "cancelled_by_message_sending_hook" },
      },
    });
    await expect(finalization).resolves.toMatchObject({ visibleReplySent: true });
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"],
      text: undefined,
    });
  });

  it("drops deferred media when its captioned replacement fails after becoming visible", async () => {
    const error = Object.assign(new Error("post-send bookkeeping failed"), {
      sentBeforeError: true,
      visibleReplySent: true,
    });
    const deliverReply = vi.fn<BufferedReplyParams["deliverReply"]>(async ({ onMediaAccepted }) => {
      onMediaAccepted?.("/tmp/generated.jpg");
      throw error;
    });
    const { finalization, replacement } = await dispatchDeferredMediaReplacement({ deliverReply });
    const replacementFailure = replacement.status === "rejected" ? replacement.reason : undefined;

    await expect(finalization).resolves.toEqual({ visibleReplySent: false });
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(replacementFailure).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "captioned replacement",
        visibleReplySent: true,
      },
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect((replacementFailure as Error).cause).toBe(error);
  });

  it.each([
    {
      name: "first upload rejected",
      failIndex: 0,
      acceptedBeforeError: false,
      expectedRemainder: ["/tmp/a.jpg"],
    },
    {
      name: "trailing upload rejected",
      failIndex: 1,
      acceptedBeforeError: false,
      expectedRemainder: ["/tmp/b.jpg"],
    },
    {
      name: "first upload accepted before transport error",
      failIndex: 0,
      acceptedBeforeError: true,
      expectedRemainder: ["/tmp/b.jpg"],
    },
  ])(
    "retains only unsent attachments when $name",
    async ({ failIndex, acceptedBeforeError, expectedRemainder }) => {
      const sent: string[] = [];
      let attempt = 0;
      vi.mocked(loadWebMedia).mockImplementation(async (url) => ({
        buffer: Buffer.from(url),
        contentType: "image/jpeg",
        kind: "image",
      }));
      const sendMedia: TestMsg["platform"]["sendMedia"] = async (content) => {
        if (!("image" in content) || !Buffer.isBuffer(content.image)) {
          throw new Error("expected image transport payload");
        }
        const url = content.image.toString();
        if (attempt++ === failIndex) {
          const error = new Error("upload failed");
          if (acceptedBeforeError) {
            sent.push(url);
            throw createChannelPartialDeliveryError(error, {
              visibleReplySent: true,
              messageIds: ["accepted-before-error"],
            });
          }
          throw error;
        }
        sent.push(url);
        return createAcceptedWhatsAppSendResult("media", `accepted-${attempt}`);
      };
      const reply = vi.fn<TestMsg["platform"]["reply"]>(async () =>
        createAcceptedWhatsAppSendResult("text", "warning"),
      );
      const deliverReply = vi.fn(deliverWebReply);
      const { finalization, replacement } = await dispatchDeferredMediaReplacement(
        { deliverReply, msg: makeMsg({ platform: { sendMedia, reply } }) },
        { deferred: ["/tmp/a.jpg", "/tmp/b.jpg"], replacement: ["/tmp/a.jpg", "/tmp/b.jpg"] },
      );

      expect(deliverReply.mock.calls.map(([params]) => params.replyResult.mediaUrls)).toEqual([
        ["/tmp/a.jpg", "/tmp/b.jpg"],
        expectedRemainder,
      ]);
      expect(sent.toSorted()).toEqual(["/tmp/a.jpg", "/tmp/b.jpg"]);
      await expect(finalization).resolves.toMatchObject({ visibleReplySent: true });
      if (acceptedBeforeError) {
        expect(replacement).toMatchObject({
          status: "rejected",
          reason: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: { visibleReplySent: true },
          },
        });
        expect(reply).not.toHaveBeenCalled();
      } else {
        expect(replacement).toMatchObject({
          status: "fulfilled",
          value: { visibleReplySent: true },
        });
        expect(reply).toHaveBeenCalledOnce();
        expect(reply.mock.calls[0]?.[0]).toContain("⚠️ Media");
      }
    },
  );

  it("does not defer or send a tool batch vetoed by the sending hook", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({ deliverReply, cancelAfterPrepare: () => true });
    const deliver = requireCapturedDeliver(capturedDispatchParams as CapturedDispatchParams);
    await expect(
      deliver({ mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"] }, { kind: "tool" }),
    ).resolves.toMatchObject({
      visibleReplySent: false,
      suppression: { reason: "cancelled_by_message_sending_hook" },
    });
    await getCapturedOnSettled()?.();
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("returns receipt-backed delivery facts for native text fallback", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({ deliverReply });

    const deliver = getCapturedDeliver();
    await expect(deliver?.({ text: "fallback text" }, { kind: "final" })).resolves.toMatchObject({
      content: "fallback text",
      messageIds: ["wa-sent-1"],
      receipt: testReceipt(["wa-sent-1"]),
      visibleReplySent: true,
    });
  });

  it.each([
    {
      name: "prefers trimmed, deduplicated mediaUrls over legacy mediaUrl",
      mediaUrl: " /tmp/legacy.jpg ",
      mediaUrls: [" /tmp/preferred.jpg ", "/tmp/preferred.jpg", "   "],
      expectedMediaUrl: "/tmp/preferred.jpg",
    },
    {
      name: "falls back to trimmed legacy mediaUrl when mediaUrls are whitespace-only",
      mediaUrl: " /tmp/legacy.jpg ",
      mediaUrls: ["   ", "\t"],
      expectedMediaUrl: "/tmp/legacy.jpg",
    },
  ])("$name during inbound dispatch", async ({ mediaUrl, mediaUrls, expectedMediaUrl }) => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({ deliverReply });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");
    await deliver?.({ text: "caption", mediaUrl, mediaUrls }, { kind: "block" });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrl: expectedMediaUrl,
      mediaUrls: [expectedMediaUrl],
      text: "caption",
    });
  });

  it("queues final WhatsApp payloads through durable outbound delivery", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({
      context: { Body: "incoming", SessionKey: "agent:main:whatsapp:+15551234567" },
      deliverReply,
      route: makeRoute({
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:whatsapp:+15551234567",
      }),
    });

    const deliver = getCapturedDeliver();
    await deliver?.({ text: "final payload" }, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "durable delivery params",
    );
    expectRecordFields(durableParams, {
      channel: "whatsapp",
      accountId: "default",
      agentId: "main",
      to: "+1000",
      info: { kind: "final" },
      replyToId: null,
    });
    expectRecordFields(requireRecord(durableParams.payload, "durable payload"), {
      text: "final payload",
    });
    expectRecordFields(requireRecord(durableParams.ctxPayload, "durable context"), {
      SessionKey: "agent:main:whatsapp:+15551234567",
    });
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses resolved final payload reply targets",
      payload: { text: "final payload", replyToId: "trigger-message" },
      expectedReplyToId: "trigger-message",
    },
    {
      name: "quotes the current user follow-up without falling back to the quoted bot message",
      payload: { text: "final payload" },
      expectedReplyToId: "trigger-message",
    },
    {
      name: "preserves explicit null reply targets",
      payload: { text: "final payload", replyToId: null },
      expectedReplyToId: null,
    },
  ] satisfies Array<{
    name: string;
    payload: CapturedReplyPayload;
    expectedReplyToId: string | null;
  }>)("$name while preserving quoted WhatsApp context", async ({ payload, expectedReplyToId }) => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      context: {
        Body: "incoming",
        ReplyToId: "quoted-bot-message",
        ReplyToBody: "Earlier bot reply",
        ReplyToSender: "OpenClaw",
      },
      deliverReply,
      msg: makeMsg({
        event: { id: "trigger-message" },
      }),
    });

    const deliver = getCapturedDeliver();
    await deliver?.(payload, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "durable delivery params",
    );
    expectRecordFields(durableParams, {
      replyToId: expectedReplyToId,
    });
    expectRecordFields(requireRecord(durableParams.ctxPayload, "durable context"), {
      ReplyToId: "quoted-bot-message",
      ReplyToBody: "Earlier bot reply",
      ReplyToSender: "OpenClaw",
    });
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("does not use a synthetic portable event ID as a WhatsApp reply target", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const msg = makeMsg({
      event: { id: undefined, timestamp: 1_710_000_000 },
    });

    await dispatchBufferedReply({
      context: {
        Body: "incoming",
        ReplyToId: "quoted-bot-message",
      },
      msg,
      inbound: {
        ...makePreparedInbound(msg),
        event: {
          id: "120363000000000000@g.us:1710000000",
          timestamp: 1_710_000_000,
        },
      },
    });

    const deliver = getCapturedDeliver();
    await deliver?.({ text: "final payload" }, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "durable delivery params",
    );
    expectRecordFields(durableParams, {
      replyToId: null,
    });
  });

  it("does not fall back when durable WhatsApp delivery suppresses a send", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: {
        messageIds: [],
        visibleReplySent: false,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    expect(await deliver?.({ text: "cancelled by hook" }, { kind: "final" })).toMatchObject({
      visibleReplySent: false,
    });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "suppressed durable delivery params",
    );
    expectRecordFields(durableParams, {
      channel: "whatsapp",
      info: { kind: "final" },
    });
    expectRecordFields(requireRecord(durableParams.payload, "suppressed payload"), {
      text: "cancelled by hook",
    });
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("reports deferred media visible only after an accepted flush", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: {
        messageIds: [],
        visibleReplySent: false,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    const deferred = requireRecord(
      await deliver?.({ text: "tool image", mediaUrls: ["/tmp/generated.jpg"] }, { kind: "tool" }),
      "deferred media result",
    );
    expect(deferred).toMatchObject({ visibleReplySent: false });
    await expect(deliver?.({ text: "cancelled final" }, { kind: "final" })).resolves.toMatchObject({
      visibleReplySent: false,
    });
    await expect(deferred.finalization).resolves.toMatchObject({
      visibleReplySent: true,
      messageIds: ["wa-sent-1"],
      content: "",
      receipt: testReceipt(["wa-sent-1"]),
    });
    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("flushes deferred media through the settled delivery hook", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    let settledResult: unknown;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        const deliver = params.dispatcherOptions?.deliver;
        if (!deliver) {
          throw new Error("expected captured deliver callback");
        }
        const onSettled = params.dispatcherOptions?.onSettled;
        const deferred = await deliver(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        expect(deferred).toMatchObject({ visibleReplySent: false });
        settledResult = await onSettled?.();
        return {
          queuedFinal: false,
          counts: { tool: 1, block: 0, final: 0 },
        };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
      }),
    ).resolves.toBe(true);

    expect(settledResult).toMatchObject({ visibleReplySent: true });
    expect(getCapturedOnSettled()).toBeTypeOf("function");
    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("marks deferred media flush failures visible after an earlier accepted flush", async () => {
    const error = new Error("second deferred media failed");
    const deliverReply = vi
      .fn()
      .mockResolvedValueOnce(acceptedDeliveryResult())
      .mockRejectedValueOnce(error);
    let firstSettlement: Promise<{ status: "resolved"; value: unknown } | { status: "rejected" }>;
    let secondSettlement: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }>;
    let thirdSettlement: Promise<{ status: "resolved" } | { status: "rejected"; error: unknown }>;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        const deliver = params.dispatcherOptions?.deliver;
        if (!deliver) {
          throw new Error("expected captured deliver callback");
        }
        const onSettled = params.dispatcherOptions?.onSettled;
        const first = requireRecord(
          await deliver({ text: "first image", mediaUrls: ["/tmp/first.jpg"] }, { kind: "tool" }),
          "first deferred media result",
        );
        const second = requireRecord(
          await deliver({ text: "second image", mediaUrls: ["/tmp/second.jpg"] }, { kind: "tool" }),
          "second deferred media result",
        );
        const third = requireRecord(
          await deliver({ text: "third image", mediaUrls: ["/tmp/third.jpg"] }, { kind: "tool" }),
          "third deferred media result",
        );
        firstSettlement = (first.finalization as Promise<unknown>).then(
          (value) => ({ status: "resolved" as const, value }),
          () => ({ status: "rejected" as const }),
        );
        secondSettlement = (second.finalization as Promise<unknown>).then(
          () => ({ status: "resolved" as const }),
          (settlementError: unknown) => ({
            status: "rejected" as const,
            error: settlementError,
          }),
        );
        thirdSettlement = (third.finalization as Promise<unknown>).then(
          () => ({ status: "resolved" as const }),
          (settlementError: unknown) => ({
            status: "rejected" as const,
            error: settlementError,
          }),
        );
        await onSettled?.();
        return {
          queuedFinal: false,
          counts: { tool: 3, block: 0, final: 0 },
        };
      },
    );

    await expect(dispatchBufferedReply({ deliverReply })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
      cause: error,
    });
    expect(error).not.toHaveProperty("sentBeforeError");
    expect(error).not.toHaveProperty("visibleReplySent");
    await expect(firstSettlement!).resolves.toMatchObject({
      status: "resolved",
      value: { visibleReplySent: true },
    });
    await expect(secondSettlement!).resolves.toEqual({ status: "rejected", error });
    const third = await thirdSettlement!;
    expect(third).toMatchObject({
      status: "rejected",
      error: { cause: error },
    });
    if (third.status === "rejected") {
      expect(third.error).not.toHaveProperty("sentBeforeError");
      expect(third.error).not.toHaveProperty("visibleReplySent");
    }
    expect(deliverReply).toHaveBeenCalledTimes(2);
  });

  it("marks downstream failures visible after deferred media flushes", async () => {
    const error = new Error("durable text failed");
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "failed",
      error,
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await expect(
      deliver?.({ text: "tool image", mediaUrls: ["/tmp/generated.jpg"] }, { kind: "tool" }),
    ).resolves.toMatchObject({ visibleReplySent: false });
    await expect(deliver?.({ text: "final text" }, { kind: "final" })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("marks durable partial send failures as visible before rethrowing", async () => {
    const error = new Error("second chunk failed");
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "failed",
      error,
      sentBeforeError: true,
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await expect(deliver?.({ text: "partial final" }, { kind: "final" })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("keeps media replies on the WhatsApp owner delivery path", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      { kind: "final" },
    );

    expect(deliverInboundReplyWithMessageSendContextMock).not.toHaveBeenCalled();
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: "generated image",
    });
  });

  it("normalizes WhatsApp payload text before delivery", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: 'Before\n<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>\nAfter',
      },
      { kind: "final" },
    );

    expectReplyResultFields(deliverReply, { text: "Before\n\nAfter" });
  });

  it("suppresses reasoning and compaction payloads before WhatsApp delivery", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "hidden", isReasoning: true }, { kind: "block" });
    await deliver?.(
      { text: "🧹 Compacting context...", isCompactionNotice: true },
      { kind: "block" },
    );
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("suppresses payloads that normalize to no visible WhatsApp content", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: '<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>',
      },
      { kind: "final" },
    );

    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("suppresses error payload text", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    await dispatchBufferedReply({ deliverReply });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "provider exploded", isError: true }, { kind: "final" });

    expect(deliverReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "maps WhatsApp streaming.block.enabled=true to disableBlockStreaming=false",
      cfg: undefined,
      expected: false,
    },
    {
      name: "maps WhatsApp streaming.block.enabled=false to disableBlockStreaming=true",
      cfg: { channels: { whatsapp: { streaming: { block: { enabled: false } } } } } as never,
      expected: true,
    },
    {
      name: "leaves disableBlockStreaming undefined when WhatsApp block streaming is unset",
      cfg: { channels: { whatsapp: {} } } as never,
      expected: undefined,
    },
  ])("$name", async ({ cfg, expected }) => {
    await dispatchBufferedReply(cfg ? { cfg } : {});

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(expected);
  });

  it("leaves WhatsApp direct reply mode unset by default", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "direct" },
      msg: makeMsg({ admission: directAdmission("+15550001000") }),
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(false);
    expect(getCapturedReplyOptions()?.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("defaults WhatsApp group replies to message-tool-only and disables source streaming", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ admission: groupAdmission("120363000000000000@g.us") }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      disableBlockStreaming: true,
    });
  });

  it("delivers authorized WhatsApp group text slash command replies visibly", async () => {
    const context = finalizedContext({
      Body: "/status",
      ChatType: "group",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { streaming: { block: { enabled: true } } } },
        messages: { groupChat: { visibleReplies: "message_tool" } },
      } as never,
      context,
      msg: makeMsg({
        payload: { body: "/status" },
        admission: groupAdmission("120363000000000000@g.us"),
      }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
      suppressTyping: false,
    });
    expect(sourceReplyDeliveryModeContexts).toEqual([context]);
  });

  it("honors automatic visible replies for WhatsApp groups", async () => {
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { streaming: { block: { enabled: true } } } },
        messages: { groupChat: { visibleReplies: "automatic" } },
      } as never,
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ admission: groupAdmission("120363000000000000@g.us") }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
      suppressTyping: false,
    });
  });

  it.each([
    {
      name: "suppresses typing for message-tool-only group chat without mention",
      chatType: "group" as const,
      wasMentioned: false,
      expected: true,
    },
    {
      name: "does not suppress typing for group chat when mentioned",
      chatType: "group" as const,
      wasMentioned: true,
      expected: false,
    },
    {
      name: "does not suppress typing for direct chat",
      chatType: "direct" as const,
      wasMentioned: undefined,
      expected: false,
    },
  ])("$name", async ({ chatType, wasMentioned, expected }) => {
    const isGroup = chatType === "group";
    await dispatchBufferedReply({
      context: {
        Body: wasMentioned ? "@bot hi" : "hi",
        ChatType: chatType,
        ...(wasMentioned === undefined ? {} : { WasMentioned: wasMentioned }),
      },
      msg: makeMsg({
        admission: isGroup
          ? groupAdmission("120363000000000000@g.us")
          : directAdmission("+15550001000"),
        ...(wasMentioned === undefined ? {} : { wasMentioned }),
      }),
    });

    expect(getCapturedReplyOptions()?.suppressTyping).toBe(expected);
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "partial block" }, { kind: "block" });
        return { queuedFinal: false, counts: { tool: 0, block: 1, final: 0 } };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("returns success when shared dispatch observes message-tool delivery", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
          observedReplyDelivery: true,
        };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("keeps visible delivery successful while marking a failed agent run as an error", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const statusReactionController = {
      setQueued: vi.fn(),
      setThinking: vi.fn(),
      setTool: vi.fn(),
      setCompacting: vi.fn(),
      cancelPending: vi.fn(),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => undefined),
    };
    readAgentRunTerminalOutcomeMock.mockReturnValueOnce("failed");
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "visible failure" }, { kind: "final" });
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 1 },
        };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        statusReactionController,
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setDone).not.toHaveBeenCalled();
    expect(statusReactionController.setError.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionController.restoreInitial.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not treat generated WhatsApp text as sent when the provider did not accept it", async () => {
    const deliverReply = vi.fn(async () => unacceptedDeliveryResult());
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "final text" }, { kind: "final" });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        replyLogger,
      }),
    ).resolves.toBe(false);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    const warnMock = replyLogger["warn"] as unknown as { mock: { calls: unknown[][] } };
    const warningContext = requireMockArg(warnMock, 0, 0, "warning context");
    expectRecordFields(warningContext, {
      replyKind: "final",
      conversationId: "+1000",
    });
    expect(warnMock.mock.calls.at(0)?.[1]).toBe("auto-reply was not accepted by WhatsApp provider");
  });

  it("returns true for tool-only media turns after delivering media", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const msg = makeMsg();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        await params.dispatcherOptions?.onSettled?.();
        return { queuedFinal: false, counts: { tool: 1, block: 0, final: 0 } };
      },
    );

    await expect(
      runWhatsAppReplyPlan({
        cfg: { channels: { whatsapp: { streaming: { block: { enabled: true } } } } } as never,
        connectionId: "conn",
        context: finalizedContext({ Body: "hi" }),
        deliverReply,
        groupHistories: new Map(),
        groupHistoryKey: "+1000",
        inbound: makePreparedInbound(msg),
        maxMediaBytes: 1,
        replyLogger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as never,
        replyPipeline: {},
        replyResolver: (async () => undefined) as never,
        route: makeRoute(),
        shouldClearGroupHistory: false,
        transport: buildWhatsAppInboundTransportContext(msg),
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: undefined,
    });
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);

    await dispatchBufferedReply({
      msg: makeMsg({ platform: { sendComposing } }),
    });

    expect(
      (
        capturedDispatchParams as {
          dispatcherOptions?: { onReplyStart?: unknown };
        }
      )?.dispatcherOptions?.onReplyStart,
    ).toBe(sendComposing);
  });

  it("logs delivery failures from the shared dispatcher with WhatsApp context", async () => {
    const replyLogger = makeReplyLogger();
    const error = new Error("send failed");

    await dispatchBufferedReply({
      connectionId: "conn-1",
      msg: makeMsg({
        admission: directAdmission("+15550001000"),
        event: { id: "msg-1" },
        platform: {
          recipientJid: "+15550002000",
          chatJid: "15550001000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    await getCapturedOnError()?.(error, { kind: "final" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      {
        err: { type: "Error", message: "send failed", stack: error.stack },
        replyKind: "final",
        correlationId: "msg-1",
        connectionId: "conn-1",
        conversationId: "+15550001000",
        chatId: "15550001000@s.whatsapp.net",
        to: "+15550001000",
        from: "+15550002000",
      },
      "auto-reply delivery failed",
    );
  });

  it("preserves Error subclass own-enumerable fields (e.g. Boom output) in the logged err", async () => {
    const replyLogger = makeReplyLogger();

    class BoomLikeError extends Error {
      output: { statusCode: number; payload: { error: string } };
      data: { reason: string };
      constructor(message: string) {
        super(message);
        this.name = "BoomLikeError";
        this.output = { statusCode: 408, payload: { error: "Request Time-out" } };
        this.data = { reason: "transport-stale" };
      }
    }
    const error = new BoomLikeError("send timed out");

    await dispatchBufferedReply({
      connectionId: "conn-boom",
      msg: makeMsg({
        admission: directAdmission("+15550020000"),
        event: { id: "msg-boom" },
        platform: {
          recipientJid: "+15550021000",
          chatJid: "15550020000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    await getCapturedOnError()?.(error, { kind: "final" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          type: "BoomLikeError",
          message: "send timed out",
          stack: error.stack,
          output: { statusCode: 408, payload: { error: "Request Time-out" } },
          data: { reason: "transport-stale" },
        }),
        replyKind: "final",
        correlationId: "msg-boom",
      }),
      "auto-reply delivery failed",
    );
  });

  it.each([
    {
      name: "logs delivery failures with non-Error rejection values via pass-through",
      rejection: "plain string rejection",
      replyKind: "block" as const,
      connectionId: "conn-2",
      messageId: "msg-2",
      conversationId: "+15550003000",
      recipientJid: "+15550004000",
    },
    {
      name: "preserves structured object rejections so diagnostic fields stay queryable",
      rejection: {
        error: { message: "wrapped failure", code: "BAILEYS_NACK" },
        attempt: 2,
      },
      replyKind: "tool" as const,
      connectionId: "conn-3",
      messageId: "msg-3",
      conversationId: "+15550005000",
      recipientJid: "+15550006000",
    },
  ])(
    "$name",
    async ({ rejection, replyKind, connectionId, messageId, conversationId, recipientJid }) => {
      const replyLogger = makeReplyLogger();
      await dispatchBufferedReply({
        connectionId,
        msg: makeMsg({
          admission: directAdmission(conversationId),
          event: { id: messageId },
          platform: {
            recipientJid,
            chatJid: `${conversationId.slice(1)}@s.whatsapp.net`,
          },
        }),
        replyLogger,
      });

      await getCapturedOnError()?.(rejection, { kind: replyKind });

      expect(replyLogger["error"]).toHaveBeenCalledWith(
        expect.objectContaining({ err: rejection, replyKind, correlationId: messageId }),
        "auto-reply delivery failed",
      );
    },
  );

  it.each([
    {
      name: "updates main last route for DM when session key matches main session key",
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: null,
      route: {},
      expectedCalls: 1,
    },
    {
      name: "does not update main last route for isolated DM scope sessions",
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: null,
      route: {
        sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
        mainSessionKey: "agent:main:whatsapp:direct:+1000",
      },
      expectedCalls: 0,
    },
    {
      name: "does not update main last route for non-owner sender when main DM scope is pinned",
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: "+1000",
      route: { sessionKey: "agent:main:main", mainSessionKey: "agent:main:main" },
      expectedCalls: 0,
    },
    {
      name: "updates main last route for owner sender when main DM scope is pinned",
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: "+1000",
      route: { sessionKey: "agent:main:main", mainSessionKey: "agent:main:main" },
      expectedCalls: 1,
    },
  ])("$name", ({ dmRouteTarget, pinnedMainDmRecipient, route, expectedCalls }) => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget,
      pinnedMainDmRecipient,
      route: makeRoute(route),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(expectedCalls);
  });

  it("resolves DM route targets from the sender first and the chat JID second", async () => {
    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ admission: directAdmission("15550003333@s.whatsapp.net") }),
        senderE164: "+15550002222",
        normalizeE164: (value) => value,
      }),
    ).toBe("+15550002222");

    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ admission: directAdmission("15550003333@s.whatsapp.net") }),
        normalizeE164: () => null,
      }),
    ).toBe("+15550003333");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
