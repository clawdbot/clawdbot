import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lazy-loaded audio preflight runtime boundary
const transcribeFirstAudioMock = vi.fn();
const maybeSendAckReactionMock = vi.fn();

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

// Controllable shouldComputeCommandAuthorized for command-sync tests
let shouldComputeCommandResult = false;
let shouldComputeCommandBodies: string[] = [];

// Minimal mocks for process-message dependencies
vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: () => ({
    accountId: "default",
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    allowFrom: [],
  }),
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => undefined,
  getSelfIdentity: () => ({ e164: "+15550000001" }),
  getSenderIdentity: () => ({ e164: "+15550000002", name: "Alice" }),
}));

vi.mock("../../reconnect.js", () => ({
  newConnectionId: () => "test-conn-id",
}));

vi.mock("../../session.js", () => ({
  formatError: (err: unknown) => String(err),
}));

vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: vi.fn(async () => {}),
}));

vi.mock("../loggers.js", () => ({
  whatsappInboundLog: { info: () => {}, debug: () => {} },
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("./inbound-context.js", () => ({
  resolveVisibleWhatsAppGroupHistory: () => [],
  resolveVisibleWhatsAppReplyContext: () => null,
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: () => {},
  updateLastRouteInBackground: () => {},
}));

vi.mock("./message-line.js", () => ({
  buildInboundLine: (params: { msg: { body: string } }) => params.msg.body,
}));

vi.mock("./runtime-api.js", () => ({
  buildHistoryContextFromEntries: (_p: { currentMessage: string }) => _p.currentMessage,
  createChannelMessageReplyPipeline: () => ({ onModelSelected: undefined }),
  formatInboundEnvelope: (p: { body: string }) => p.body,
  logVerbose: () => {},
  normalizeE164: (v: string) => v,
  readStoreAllowFromForDmPolicy: async () => [],
  recordSessionMetaFromInbound: async () => {},
  resolveChannelContextVisibilityMode: () => "standard",
  resolveInboundSessionEnvelopeContext: () => ({
    storePath: "/tmp/sessions.json",
    envelopeOptions: {},
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  resolveDmGroupAccessWithCommandGate: () => ({ commandAuthorized: true }),
  shouldComputeCommandAuthorized: (body: string) => {
    shouldComputeCommandBodies.push(body);
    return shouldComputeCommandResult || body.startsWith("/");
  },
  shouldLogVerbose: () => false,
  type: undefined,
}));

vi.mock("./inbound-dispatch.js", () => ({
  buildWhatsAppInboundContext: (params: {
    bodyForAgent?: string;
    combinedBody: string;
    commandAuthorized?: boolean;
    commandBody?: string;
    msg: { body: string; mediaPath?: string; mediaType?: string };
    mediaTranscribedIndexes?: number[];
    rawBody?: string;
    transcript?: string;
  }) => ({
    Body: params.combinedBody,
    BodyForAgent: params.bodyForAgent ?? params.msg.body,
    CommandAuthorized: params.commandAuthorized,
    CommandBody: params.commandBody ?? params.msg.body,
    MediaPath: params.msg.mediaPath,
    MediaType: params.msg.mediaType,
    MediaTranscribedIndexes: params.mediaTranscribedIndexes,
    RawBody: params.rawBody ?? params.msg.body,
    Transcript: params.transcript,
  }),
  dispatchWhatsAppBufferedReply: vi.fn(async () => true),
  resolveWhatsAppDmRouteTarget: () => "+15550000002",
  resolveWhatsAppResponsePrefix: () => undefined,
  updateWhatsAppMainLastRoute: () => {},
}));

import { dispatchWhatsAppBufferedReply } from "./inbound-dispatch.js";
import { processMessage } from "./process-message.js";

type WebInboundMsg = Parameters<typeof processMessage>[0]["msg"];
type TestRoute = Parameters<typeof processMessage>[0]["route"];

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function makeAudioMsg(overrides: Partial<WebInboundMsg> = {}): WebInboundMsg {
  return {
    id: "msg-1",
    from: "+15550000002",
    to: "+15550000001",
    body: "<media:audio>",
    chatType: "direct",
    mediaType: "audio/ogg; codecs=opus",
    mediaPath: "/tmp/voice.ogg",
    timestamp: 1700000000,
    accountId: "default",
    ...overrides,
  } as WebInboundMsg;
}

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    accountId: "default",
    ...overrides,
  } as TestRoute;
}

function makeParams(msgOverrides: Partial<WebInboundMsg> = {}) {
  return {
    cfg: {
      tools: { media: { audio: { enabled: true } } },
      channels: { whatsapp: {} },
      commands: { useAccessGroups: false },
    } as never,
    msg: makeAudioMsg(msgOverrides),
    route: makeRoute(),
    groupHistoryKey: "whatsapp:default:+15550000002",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024 * 1024,
    replyResolver: vi.fn() as never,
    replyLogger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    } as never,
    backgroundTasks: new Set<Promise<unknown>>(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: (p: { combinedBody: string }) => p.combinedBody,
  };
}

function makeAckReactionHandle() {
  return {
    ackReactionPromise: Promise.resolve(true),
    ackReactionValue: "👀",
    remove: vi.fn(async () => undefined),
  };
}

function makeRemoveAckAfterReplyParams() {
  return {
    ...makeParams(),
    cfg: {
      tools: { media: { audio: { enabled: true } } },
      channels: { whatsapp: {} },
      commands: { useAccessGroups: false },
      messages: { removeAckAfterReply: true },
    } as never,
    preflightAudioTranscript: "pre-computed transcript from caller",
  };
}

function firstTranscriptionContext(): Record<string, unknown> {
  const call = transcribeFirstAudioMock.mock.calls.at(0)?.[0] as
    | { ctx?: Record<string, unknown> }
    | undefined;
  if (!call?.ctx) {
    throw new Error("expected transcribeFirstAudio ctx");
  }
  return call.ctx;
}

function firstDispatchContext(): Record<string, unknown> {
  const calls = vi.mocked(dispatchWhatsAppBufferedReply).mock.calls as unknown[][];
  const dispatch = calls[0]?.[0] as { context?: Record<string, unknown> } | undefined;
  if (!dispatch?.context) {
    throw new Error("expected WhatsApp dispatch context");
  }
  return dispatch.context;
}

function expectContextFields(context: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(context[key]).toEqual(value);
  }
}

describe("processMessage audio preflight transcription", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockResolvedValue(null);
    shouldComputeCommandResult = false;
    shouldComputeCommandBodies = [];
    vi.mocked(dispatchWhatsAppBufferedReply).mockClear();
  });

  it("replaces <media:audio> body with transcript when transcription succeeds", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("okay let's test this voice message");

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expectContextFields(firstTranscriptionContext(), {
      AccountId: "default",
      From: "+15550000002",
      MediaPaths: ["/tmp/voice.ogg"],
      MediaTypes: ["audio/ogg; codecs=opus"],
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550000002",
      Provider: "whatsapp",
      Surface: "whatsapp",
      To: "+15550000001",
    });

    const context = firstDispatchContext();
    expectContextFields(context, {
      Body: "okay let's test this voice message",
      BodyForAgent: "okay let's test this voice message",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "okay let's test this voice message",
      MediaTranscribedIndexes: [0],
    });
    // mediaPath and mediaType must be preserved so inboundAudio detection (used by
    // features like messages.tts.auto: "inbound") still recognises this as audio.
    expectContextFields(context, {
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg; codecs=opus",
    });
  });

  it("falls back to <media:audio> placeholder when transcription fails", async () => {
    transcribeFirstAudioMock.mockRejectedValueOnce(new Error("provider unavailable"));

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);

    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
      BodyForAgent: "<media:audio>",
    });
  });

  it("falls back to <media:audio> placeholder when transcription returns undefined", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce(undefined);

    await processMessage(makeParams());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);

    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
      BodyForAgent: "<media:audio>",
    });
  });

  it("does not call transcribeFirstAudio when mediaType is not audio", async () => {
    await processMessage(
      makeParams({ body: "<media:image>", mediaType: "image/jpeg", mediaPath: "/tmp/img.jpg" }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when body is not <media:audio>", async () => {
    await processMessage(makeParams({ body: "hello there", mediaType: "audio/ogg; codecs=opus" }));

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when mediaPath is absent", async () => {
    await processMessage(makeParams({ mediaPath: undefined }));

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
  });

  it("does not call transcribeFirstAudio when msg.mediaType is absent", async () => {
    await processMessage(
      makeParams({ mediaType: undefined, body: "<media:audio>", mediaPath: "/tmp/voice.ogg" }),
    );

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    // Body passes through as-is without a mediaType to confirm audio
    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
    });
  });

  it("does not use transcript body for command detection", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("/new start a new session");

    await processMessage(makeParams());

    expect(shouldComputeCommandBodies).toEqual(["<media:audio>"]);

    expectContextFields(firstDispatchContext(), {
      Body: "/new start a new session",
      BodyForAgent: "/new start a new session",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "/new start a new session",
      MediaTranscribedIndexes: [0],
    });
  });

  it("uses preflightAudioTranscript when provided, skipping transcribeFirstAudio", async () => {
    // Simulate broadcast fan-out: caller pre-computed the transcript and passes it in.
    // transcribeFirstAudio must NOT be called again inside processMessage.
    await processMessage({
      ...makeParams(),
      preflightAudioTranscript: "pre-computed transcript from fan-out caller",
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    expectContextFields(firstDispatchContext(), {
      Body: "pre-computed transcript from fan-out caller",
      BodyForAgent: "pre-computed transcript from fan-out caller",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "pre-computed transcript from fan-out caller",
      MediaTranscribedIndexes: [0],
    });
  });

  it("does not send a duplicate ack when caller already sent it", async () => {
    await processMessage({
      ...makeParams(),
      preflightAudioTranscript: "pre-computed transcript from caller",
      ackAlreadySent: true,
      ackReaction: makeAckReactionHandle(),
    });

    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
  });

  it("removes caller-provided ack after a successful visible reply", async () => {
    const ackReaction = makeAckReactionHandle();

    await processMessage({
      ...makeRemoveAckAfterReplyParams(),
      ackReaction,
    });
    await flushMicrotasks();

    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
  });

  it("removes internally sent ack after a successful visible reply", async () => {
    const ackReaction = makeAckReactionHandle();
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(maybeSendAckReactionMock).toHaveBeenCalledTimes(1);
    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps ack when no visible reply was delivered", async () => {
    const ackReaction = makeAckReactionHandle();
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);
    vi.mocked(dispatchWhatsAppBufferedReply).mockResolvedValueOnce(false);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(ackReaction.remove).not.toHaveBeenCalled();
  });

  it("keeps ack when the ack send failed", async () => {
    const ackReaction = {
      ...makeAckReactionHandle(),
      ackReactionPromise: Promise.resolve(false),
    };
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);

    await processMessage(makeRemoveAckAfterReplyParams());
    await flushMicrotasks();

    expect(ackReaction.remove).not.toHaveBeenCalled();
  });

  it("skips internal STT when preflightAudioTranscript is null (failed preflight sentinel)", async () => {
    // null = caller already attempted preflight but got nothing (provider unavailable,
    // disabled, etc.). processMessage must NOT retry to avoid 1+N attempts in broadcast.
    await processMessage({
      ...makeParams(),
      preflightAudioTranscript: null,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();

    // Body falls back to the original <media:audio> placeholder, not retried transcript.
    expectContextFields(firstDispatchContext(), {
      Body: "<media:audio>",
    });
  });
});
