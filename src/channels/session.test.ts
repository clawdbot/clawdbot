import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateLastRoute: (args: unknown) => updateLastRouteMock(args),
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
});
