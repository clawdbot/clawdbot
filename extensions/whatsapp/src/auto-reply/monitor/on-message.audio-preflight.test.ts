// Whatsapp tests cover on message.audio preflight plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const transcribeFirstAudioMock = vi.fn();
const maybeSendAckReactionMock = vi.fn();
const processMessageMock = vi.fn();
const maybeBroadcastMessageMock = vi.fn();
const createStatusReactionControllerMock = vi.fn();
const updateLastRouteInBackgroundMock = vi.fn();
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
  updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
}));

vi.mock("./peer.js", () => ({
  resolvePeerId: (msg: { admission: { conversation: { id: string } } }) =>
    msg.admission.conversation.id,
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

import {
  createTestLegacyFlatWebInboundMessage,
  createTestWebAudioInboundMessage,
} from "../../inbound/test-message.test-helper.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { createWebOnMessageHandler } from "./on-message.js";

function makeAudioMsg(): WebInboundMessage {
  return createTestWebAudioInboundMessage();
}

function makeLegacyAudioMsg() {
  return createTestLegacyFlatWebInboundMessage({
    body: "",
    mediaPath: "/tmp/voice.ogg",
    mediaType: "audio/ogg; codecs=opus",
  });
}

function makeGroupAudioMsg(): WebInboundMessage {
  return createTestWebAudioInboundMessage({
    platform: { chatJid: "1203630@g.us" },
    admission: {
      conversation: {
        kind: "group",
        id: "1203630@g.us",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    wasMentioned: false,
  });
}

function makeBlockedDirectAudioMsg(): WebInboundMessage {
  return createTestWebAudioInboundMessage({
    admission: {
      ingress: {
        admission: "drop",
        decision: "block",
        reasonCode: "dm_policy_not_allowlisted",
      },
      senderAccess: {
        allowed: false,
        decision: "block",
        reasonCode: "dm_policy_not_allowlisted",
      },
      activationAccess: {
        allowed: false,
        shouldSkip: true,
        reasonCode: "dm_policy_not_allowlisted",
      },
    },
  });
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

function makeHandler(overrides: Partial<Parameters<typeof createWebOnMessageHandler>[0]> = {}) {
  return createWebOnMessageHandler({
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
    ...overrides,
  });
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
    ackReactionHandle.remove.mockClear();
    updateLastRouteInBackgroundMock.mockReset();
    applyGroupGatingMock.mockReset();
    applyGroupGatingMock.mockResolvedValue({ shouldProcess: true });
  });

  it("sends ack reaction before audio preflight for voice notes", async () => {
    const handler = makeHandler();

    await handler(makeAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams.preflightAudioTranscript).toBe("transcribed voice note");
    expect(processParams.ackAlreadySent).toBe(true);
    expect(processParams.ackReaction).toBe(ackReactionHandle);
  });

  it("sends queued status reaction before audio preflight when status reactions are enabled", async () => {
    const handler = makeHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
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

  it("drops blocked DM admission before ack, preflight, or dispatch", async () => {
    const handler = makeHandler();

    await handler(makeBlockedDirectAudioMsg());

    expect(events).toStrictEqual([]);
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("skips early DM ack/preflight for legacy audio without explicit access proof", async () => {
    const handler = makeHandler();

    await handler(makeLegacyAudioMsg());

    expect(events).toStrictEqual([]);
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    const processParams = mockObjectArg(processMessageMock, "processMessage");
    expect(processParams).not.toHaveProperty("preflightAudioTranscript");
    expect(processParams).not.toHaveProperty("ackAlreadySent");
    expect(processParams).not.toHaveProperty("ackReaction");
  });

  it("shares one transcript for legacy direct broadcasts without explicit access proof", async () => {
    maybeBroadcastMessageMock.mockImplementation(
      async (params: { preflightAudioTranscript?: string | null }) => {
        expect(params.preflightAudioTranscript).toBe("transcribed voice note");
        return true;
      },
    );
    const handler = makeHandler({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
        broadcast: {
          "+15551234567": ["main", "backup"],
        },
      } as never,
    });

    await handler(makeLegacyAudioMsg());

    expect(events).toStrictEqual(["stt"]);
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
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
    const handler = makeHandler({
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
    });

    await handler(makeGroupAudioMsg());

    expect(events).toEqual(["ack", "stt"]);
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("clears preflight status reaction before group broadcast voice fan-out", async () => {
    maybeBroadcastMessageMock.mockImplementation(
      async (params: { preflightAudioTranscript?: string | null }) => {
        expect(params.preflightAudioTranscript).toBe("transcribed voice note");
        expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
        expect(statusReactionController.clear).toHaveBeenCalledTimes(1);
        return true;
      },
    );
    const handler = makeHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        broadcast: {
          "1203630@g.us": ["main", "backup"],
        },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
    });

    await handler(makeGroupAudioMsg());

    expect(events).toEqual(["status-queued", "stt"]);
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(statusReactionController.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.clear).toHaveBeenCalledTimes(1);
    expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("uses group voice transcript for mention gating before dispatch", async () => {
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: true });
    const handler = makeHandler();

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

  it("removes preflight ack when group voice transcript still misses mention gating", async () => {
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: false });
    const handler = makeHandler();

    await handler(makeGroupAudioMsg());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["ack", "stt"]);
    expect(ackReactionHandle.remove).toHaveBeenCalledTimes(1);
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("clears preflight status reaction when group voice transcript still misses mention gating", async () => {
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: false });
    const handler = makeHandler({
      cfg: {
        messages: { statusReactions: { enabled: true } },
        channels: {
          whatsapp: {
            ackReaction: { enabled: true },
          },
        },
      } as never,
    });

    await handler(makeGroupAudioMsg());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(2);
    expect(statusReactionController.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.clear).toHaveBeenCalledTimes(1);
    expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("passes routing ctx fields to transcribeFirstAudio so echoTranscript can deliver (#79778)", async () => {
    let capturedCtx: unknown;
    transcribeFirstAudioMock.mockImplementation(async ({ ctx }: { ctx: unknown }) => {
      capturedCtx = ctx;
      return "transcribed voice note";
    });
    const handler = makeHandler();

    await handler(makeAudioMsg());

    expect(capturedCtx).toEqual({
      media: [
        {
          path: "/tmp/voice.ogg",
          contentType: "audio/ogg; codecs=opus",
          kind: "audio",
        },
      ],
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
    const handler = makeHandler();

    await handler(makeGroupAudioMsg());

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });
});
