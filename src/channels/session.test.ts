// Channel session tests cover session persistence, lookup, and lifecycle helpers.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn(
  (_args?: unknown): Promise<{ sessionId: string } | undefined> => Promise.resolve(undefined),
);
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const admitInboundMemorySessionContextMock = vi.fn();

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  recordInboundSessionMeta: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateSessionLastRoute: (args: unknown) => updateLastRouteMock(args),
}));

vi.mock("../state/memory-session-subject.js", () => ({
  admitInboundMemorySessionContext: (args: unknown) => admitInboundMemorySessionContextMock(args),
}));

type SessionModule = typeof import("./session.js");

let recordInboundSession: SessionModule["recordInboundSession"];

function requireFirstCallArg(mock: ReturnType<typeof vi.fn>): {
  sessionKey?: string;
  ctx?: MsgContext;
  createIfMissing?: boolean;
  deliveryContext?: {
    channel?: string;
    to?: string;
  };
} {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("Expected mock call argument");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("Expected mock call argument to be an object");
  }
  return arg;
}

describe("recordInboundSession", () => {
  const ctx: MsgContext = {
    Provider: "demo-channel",
    From: "demo-channel:1234",
    SessionKey: "agent:main:demo-channel:1234:thread:42",
    OriginatingTo: "demo-channel:1234",
  };

  beforeAll(async () => {
    ({ recordInboundSession } = await import("./session.js"));
  });

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
    admitInboundMemorySessionContextMock.mockClear();
  });

  it("does not pass ctx when updating a different session key", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
      onRecordError: vi.fn(),
    });

    const route = requireFirstCallArg(updateLastRouteMock);
    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.ctx).toBeUndefined();
    expect(route.deliveryContext?.channel).toBe("demo-channel");
    expect(route.deliveryContext?.to).toBe("demo-channel:1234");
  });

  it("passes ctx when updating the same session key", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
      onRecordError: vi.fn(),
    });

    const route = requireFirstCallArg(updateLastRouteMock);
    expect(route.sessionKey).toBe("agent:main:demo-channel:1234:thread:42");
    expect(route.ctx).toBe(ctx);
    expect(route.deliveryContext?.channel).toBe("demo-channel");
    expect(route.deliveryContext?.to).toBe("demo-channel:1234");
  });

  it("normalizes mixed-case session keys before recording and route updates", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "Agent:Main:Demo-Channel:1234:Thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(requireFirstCallArg(recordSessionMetaFromInboundMock).sessionKey).toBe(
      "agent:main:demo-channel:1234:thread:42",
    );
    const route = requireFirstCallArg(updateLastRouteMock);
    expect(route.sessionKey).toBe("agent:main:demo-channel:1234:thread:42");
    expect(route.ctx).toBe(ctx);
  });

  it("preserves Signal group ids before recording and route updates", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const signalCtx: MsgContext = {
      Provider: "signal",
      ChatType: "group",
      From: `signal:group:${mixedGroupId}`,
      To: `signal:group:${mixedGroupId}`,
      SessionKey: `agent:main:signal:group:${mixedGroupId}`,
      OriginatingTo: `signal:group:${mixedGroupId}`,
    };

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: `Agent:Main:Signal:Group:${mixedGroupId}`,
      ctx: signalCtx,
      updateLastRoute: {
        sessionKey: `Agent:Main:Signal:Group:${mixedGroupId}`,
        channel: "signal",
        to: `signal:group:${mixedGroupId}`,
      },
      onRecordError: vi.fn(),
    });

    expect(requireFirstCallArg(recordSessionMetaFromInboundMock).sessionKey).toBe(
      `agent:main:signal:group:${mixedGroupId}`,
    );
    const route = requireFirstCallArg(updateLastRouteMock);
    expect(route.sessionKey).toBe(`agent:main:signal:group:${mixedGroupId}`);
    expect(route.ctx).toBe(signalCtx);
  });

  it("skips last-route updates when main DM owner pin mismatches sender", async () => {
    const onSkip = vi.fn();

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
        mainDmOwnerPin: {
          ownerRecipient: "1234",
          senderRecipient: "9999",
          onSkip,
        },
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      ownerRecipient: "1234",
      senderRecipient: "9999",
    });
  });

  it("forwards session creation policy to last-route updates", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx,
      createIfMissing: false,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(requireFirstCallArg(recordSessionMetaFromInboundMock).createIfMissing).toBe(false);
    const route = requireFirstCallArg(updateLastRouteMock);
    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.createIfMissing).toBe(false);
  });

  it("consumes only the exact inbound context after its session mapping commits", async () => {
    const admittedContext: MsgContext = {
      ...ctx,
      AgentId: "main",
      DmScope: "per-account-channel-peer",
    };
    recordSessionMetaFromInboundMock.mockResolvedValueOnce({ sessionId: "session-1" });
    let trackedMetaTask: Promise<unknown> | undefined;

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx: admittedContext,
      onRecordError: vi.fn(),
      trackSessionMetaTask: (task) => {
        trackedMetaTask = task;
      },
    });
    await expect(trackedMetaTask).resolves.toEqual({ sessionId: "session-1" });

    expect(admitInboundMemorySessionContextMock).toHaveBeenCalledWith({
      context: admittedContext,
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      sessionId: "session-1",
      options: { agentId: "main" },
    });
  });

  it("does not complete recording before the committed session gets a subject", async () => {
    const admittedContext: MsgContext = {
      ...ctx,
      AgentId: "main",
    };
    let resolveSessionMeta: ((entry: { sessionId: string }) => void) | undefined;
    recordSessionMetaFromInboundMock.mockImplementationOnce(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveSessionMeta = resolve;
        }),
    );
    let completed = false;
    const recording = recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx: admittedContext,
      onRecordError: vi.fn(),
    }).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(admitInboundMemorySessionContextMock).not.toHaveBeenCalled();

    resolveSessionMeta?.({ sessionId: "session-1" });
    await recording;

    expect(admitInboundMemorySessionContextMock).toHaveBeenCalledOnce();
  });

  it("rejects the turn record when subject admission fails", async () => {
    const admissionError = new Error("subject write failed");
    const onRecordError = vi.fn();
    recordSessionMetaFromInboundMock.mockResolvedValueOnce({ sessionId: "session-1" });
    admitInboundMemorySessionContextMock.mockImplementationOnce(() => {
      throw admissionError;
    });

    await expect(
      recordInboundSession({
        storePath: "/tmp/openclaw-session-store.json",
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        ctx: { ...ctx, AgentId: "main" },
        updateLastRoute: {
          sessionKey: "agent:main:demo-channel:1234:thread:42",
          channel: "demo-channel",
          to: "demo-channel:1234",
        },
        onRecordError,
      }),
    ).rejects.toThrow(admissionError);

    expect(onRecordError).toHaveBeenCalledWith(admissionError);
    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "throws synchronously",
      handler: (_err: unknown): void => {
        throw new Error("handler failed");
      },
    },
    {
      name: "returns a rejected promise",
      handler: ((_err: unknown) => Promise.reject(new Error("handler failed"))) as (
        _err: unknown,
      ) => void,
    },
  ])("reports and rejects recording when onRecordError $name", async ({ handler }) => {
    const recordError = new Error("db failed");
    recordSessionMetaFromInboundMock.mockRejectedValueOnce(recordError);
    const onRecordError = vi.fn(handler);
    let trackedMetaTask: Promise<unknown> | undefined;

    await expect(
      recordInboundSession({
        storePath: "/tmp/openclaw-session-store.json",
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        ctx,
        onRecordError,
        trackSessionMetaTask: (task) => {
          trackedMetaTask = task;
        },
      }),
    ).rejects.toThrow(recordError);

    expect(trackedMetaTask).toBeDefined();
    await expect(trackedMetaTask).resolves.toBeUndefined();
    expect(onRecordError).toHaveBeenCalledTimes(1);
    expect(onRecordError).toHaveBeenCalledWith(recordError);
  });
});
