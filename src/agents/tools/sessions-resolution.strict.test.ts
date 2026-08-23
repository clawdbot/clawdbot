import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (options: unknown) => callGatewayMock(options),
}));

let resolveSessionReference: typeof import("./sessions-resolution.js").resolveSessionReference;
let resolveVisibleSessionReference: typeof import("./sessions-resolution.js").resolveVisibleSessionReference;

beforeAll(async () => {
  ({ resolveSessionReference, resolveVisibleSessionReference } =
    await import("./sessions-resolution.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

describe("strict explicit session resolution", () => {
  it("resolves current to the requester before any ownership lookup", async () => {
    const result = await resolveSessionReference({
      action: "status",
      sessionKey: "current",
      keyAgentId: "ops",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:research:subagent:child",
      restrictToSpawned: false,
    });

    expect(result).toEqual({
      ok: true,
      agentId: "research",
      key: "agent:research:subagent:child",
      displayKey: "agent:research:subagent:child",
      resolvedViaSessionId: false,
      requesterOwned: true,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("still rejects an unknown non-alias explicit key", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found: agent:main:missing"));
    const resolvedSession = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:main:missing",
      keyAgentId: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("expected literal reference resolution");
    }

    await expect(
      resolveVisibleSessionReference({
        action: "history",
        resolvedSession,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: "agent:main:missing",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "error",
      error: "No session found: agent:main:missing",
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "agent:main:missing",
        agentId: "main",
        spawnedBy: undefined,
      },
    });
  });

  it("carries an allowed missing fact only for deliberate main bootstrap", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:main",
      keyAgentId: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("expected literal reference resolution");
    }

    await expect(
      resolveVisibleSessionReference({
        action: "send",
        resolvedSession,
        requesterSessionKey: "agent:main:dashboard:requester",
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: "agent:main:main",
        allowMissingKey: true,
      }),
    ).resolves.toEqual({
      ok: true,
      agentId: "main",
      key: "agent:main:main",
      displayKey: "agent:main:main",
      missing: true,
      requesterOwned: false,
    });
  });
});
