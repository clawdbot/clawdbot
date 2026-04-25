import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn());

type SessionContextModule = typeof import("./session-context.js");

let buildOutboundSessionContext: SessionContextModule["buildOutboundSessionContext"];

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

beforeAll(async () => {
  ({ buildOutboundSessionContext } = await import("./session-context.js"));
});

beforeEach(() => {
  resolveSessionAgentIdMock.mockReset();
});

describe("buildOutboundSessionContext", () => {
  it("returns undefined when both session key and agent id are blank", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "  ",
        agentId: null,
      }),
    ).toBeUndefined();
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("returns only the explicit trimmed agent id when no session key is present", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "  ",
        agentId: "  explicit-agent  ",
      }),
    ).toEqual({
      agentId: "explicit-agent",
    });
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("derives the agent id from the trimmed session key when no explicit agent is given", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        cfg: { agents: {} } as never,
        sessionKey: "  session:main:123  ",
      }),
    ).toEqual({
      key: "session:main:123",
      agentId: "derived-agent",
    });
    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "session:main:123",
      config: { agents: {} },
    });
  });

  it("prefers an explicit trimmed agent id over the derived one", () => {
    resolveSessionAgentIdMock.mockReturnValueOnce("derived-agent");

    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "session:main:123",
        agentId: "  explicit-agent  ",
      }),
    ).toEqual({
      key: "session:main:123",
      agentId: "explicit-agent",
    });
  });

  it("preserves a trimmed requester sender id when provided", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        requesterSenderId: "  sender-123  ",
      }),
    ).toEqual({
      requesterSenderId: "sender-123",
    });
  });

  it("preserves a trimmed requester account id when provided", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        requesterAccountId: "  work  ",
      }),
    ).toEqual({
      requesterAccountId: "work",
    });
  });

  it("preserves trimmed non-id sender fields for e164/username/name policy matching", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        requesterSenderId: "id:forum:123",
        requesterSenderName: "  Alice  ",
        requesterSenderUsername: "  alice_u  ",
        requesterSenderE164: "  +15551234567  ",
      }),
    ).toEqual({
      requesterSenderId: "id:forum:123",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
    });
  });

  it("normalizes explicit conversation type for policy resolution", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "agent:main:generic",
        conversationType: "channel",
      }),
    ).toEqual({
      key: "agent:main:generic",
      conversationType: "group",
    });

    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        conversationType: "dm",
      }),
    ).toEqual({
      conversationType: "direct",
    });
  });

  it("falls back to isGroup when no explicit conversation type is provided", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        sessionKey: "agent:main:generic",
        isGroup: true,
      }),
    ).toEqual({
      key: "agent:main:generic",
      conversationType: "group",
    });
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        isGroup: false,
      }),
    ).toEqual({
      conversationType: "direct",
    });
  });

  it("returns undefined when all sender and session fields are blank", () => {
    expect(
      buildOutboundSessionContext({
        cfg: {} as never,
        requesterSenderId: "  ",
        requesterSenderName: "  ",
        requesterSenderUsername: "  ",
        requesterSenderE164: "  ",
      }),
    ).toBeUndefined();
  });
});
