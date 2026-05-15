import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const transcribeFirstAudioMock = vi.fn();
const maybeSendAckReactionMock = vi.fn();
const processMessageMock = vi.fn();
const maybeBroadcastMessageMock = vi.fn();
const createStatusReactionControllerMock = vi.fn();
const statusReactionController = {
  setQueued: vi.fn(async () => {
    events.push("status-queued");
  }),
  setThinking: vi.fn(async () => undefined),
  setTool: vi.fn(async () => undefined),
  setCompacting: vi.fn(async () => undefined),
  cancelPending: vi.fn(),
  setDone: vi.fn(async () => undefined),
  setError: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
  restoreInitial: vi.fn(async () => undefined),
};
const ackReactionHandle = {
  ackReactionPromise: Promise.resolve(true),
  ackReactionValue: "👀",
  remove: vi.fn(async () => undefined),
};
const applyGroupGatingMock = vi.fn();

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => maybeBroadcastMessageMock(...args),
}));

vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: (...args: unknown[]) =>
    createStatusReactionControllerMock(...args),
}));

vi.mock("./group-gating.js", () => ({
  applyGroupGating: (...args: unknown[]) => applyGroupGatingMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: () => {},
}));

vi.mock("./peer.js", () => ({
  resolvePeerId: (msg: { from: string }) => msg.from,
}));

vi.mock("../config.runtime.js", () => ({
  getRuntimeConfig: () => ({
    channels: {
      whatsapp: {
        ackReaction: { enabled: true },
      },
    },
  }),
}));

vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => undefined,
  getSenderIdentity: () => ({ e164: "+15550000002", name: "Alice" }),
}));

vi.mock("../../text-runtime.js", () => ({
  normalizeE164: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  buildGroupHistoryKey: () => "group-key",
  resolveAgentRoute: () => ({
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:+15550000002",
    mainSessionKey: "agent:main:main",
  }),
}));

import type { WebInboundMsg } from "../types.js";
import { createWebOnMessageHandler } from "./on-message.js";

function makeAudioMsg(): WebInboundMsg {
  return {
    id: "msg-1",
    from: "+15550000002",
    to: "+15550000001",
    accessControlPassed: true,
    body: "<media:audio>",
    chatType: "direct",
    mediaType: "audio/ogg; codecs=opus",
    mediaPath: "/tmp/voice.ogg",
    timestamp: 1700000000,
    accountId: "default",
  } as WebInboundMsg;
}

function makeGroupAudioMsg(): WebInboundMsg {
  return {
    ...makeAudioMsg(),
    from: "1203630@g.us",
    chatId: "1203630@g.us",
    chatType: "group",
    conversationId: "1203630@g.us",
    wasMentioned: false,
  } as WebInboundMsg;
}

function makeEchoTracker() {
  return {
    has: () => false,
    forget: () => {},
    rememberText: () => {},
    buildCombinedKey: (p: { combinedBody: string }) => p.combinedBody,
  };
}

function mockObjectArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  const arg = call.at(0);
  if (!arg || typeof arg !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} object argument`);
  }
  return arg as Record<string, unknown>;
}

describe("createWebOnMessageHandler audio preflight", () => {
  beforeEach(() => {
    events.length = 0;
    maybeBroadcastMessageMock.mockReset();
    maybeBroadcastMessageMock.mockImplementation(async () => false);
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockImplementation(async () => {
      events.push("ack");
      return ackReactionHandle;
    });
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockImplementation(async () => {
      events.push("stt");
      return "transcribed voice note";
    });
    processMessageMock.mockReset();
    processMessageMock.mockResolvedValue(true);
    createStatusReactionControllerMock.mockReset();
    createStatusReactionControllerMock.mockResolvedValue(statusReactionController);
    Object.values(statusReactionController).forEach((mock) => mock.mockClear());
    applyGroupGatingMock.mockReset();
    applyGroupGatingMock.mockResolvedValue({ shouldProcess: true });
  });

  it("sends ack reaction before audio preflight for voice notes", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams.preflightAudioTranscript).toBe("transcribed voice note");
    expect(processParams.ackAlreadySent).toBe(true);
    expect(processParams.ackReaction).toBe(ackReactionHandle);
  });

  it("sends queued status reaction before audio preflight when status reactions are enabled", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeAudioMsg());

    expect(events).toEqual(["status-queued", "stt"]);
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(createStatusReactionControllerMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams.preflightAudioTranscript).toBe("transcribed voice note");
    expect(processParams.statusReactionController).toBe(statusReactionController);
    expect(processParams.ackAlreadySent).toBeUndefined();
  });

  it("skips early DM ack/preflight when access-control was not explicitly passed through", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler({ ...makeAudioMsg(), accessControlPassed: undefined });

    expect(events).toStrictEqual([]);
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams).not.toHaveProperty("preflightAudioTranscript");
    expect(processParams).not.toHaveProperty("ackAlreadySent");
    expect(processParams).not.toHaveProperty("ackReaction");
  });

  it("preserves per-agent ack checks for group broadcast voice notes", async () => {
    maybeBroadcastMessageMock.mockImplementation(
      async (params: {
        ackAlreadySent?: boolean;
        ackReaction?: unknown;
        preflightAudioTranscript?: string | null;
      }) => {
        expect(params.preflightAudioTranscript).toBe("transcribed voice note");
        expect(params.ackAlreadySent).toBeUndefined();
        expect(params.ackReaction).toBeUndefined();
        return true;
      },
    );
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
        broadcast: {
          "1203630@g.us": ["main", "backup"],
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeGroupAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("uses group voice transcript for mention gating before dispatch", async () => {
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: true });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeGroupAudioMsg());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(2);
    const firstGatingParams = mockObjectArg(applyGroupGatingMock, "applyGroupGating");
    expect(firstGatingParams.deferMissingMention).toBe(true);
    expect(firstGatingParams).not.toHaveProperty("mentionText");
    expect(events).toEqual(["ack", "stt"]);
    const secondGatingParams = mockObjectArg(applyGroupGatingMock, "applyGroupGating", 1);
    expect(secondGatingParams.mentionText).toBe("transcribed voice note");
    expect(secondGatingParams).not.toHaveProperty("deferMissingMention");
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams.preflightAudioTranscript).toBe("transcribed voice note");
    expect(processParams.ackAlreadySent).toBe(true);
    expect(processParams.ackReaction).toBe(ackReactionHandle);
  });

  it("passes routing ctx fields to transcribeFirstAudio so echoTranscript can deliver (#79778)", async () => {
    let capturedCtx: unknown;
    transcribeFirstAudioMock.mockImplementation(async ({ ctx }: { ctx: unknown }) => {
      capturedCtx = ctx;
      return "transcribed voice note";
    });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeAudioMsg());

    expect(capturedCtx).toEqual({
      MediaPaths: ["/tmp/voice.ogg"],
      MediaTypes: ["audio/ogg; codecs=opus"],
      From: "+15550000002",
      To: "+15550000001",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+15550000002",
      AccountId: "default",
    });
  });

  it("does not transcribe group voice when policy gating rejects before mention", async () => {
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: false });
    const handler = createWebOnMessageHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: makeEchoTracker() as never,
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/auth", accountId: "default" },
    });

    await handler(makeGroupAudioMsg());

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });
});
