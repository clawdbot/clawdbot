// Sessions resolution tests cover alias mapping, session-id lookup, and visibility normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
});
let resolveCurrentSessionClientAlias: typeof import("./sessions-resolution.js").resolveCurrentSessionClientAlias;
let resolveDisplaySessionKey: typeof import("./sessions-resolution.js").resolveDisplaySessionKey;
let resolveInternalSessionKey: typeof import("./sessions-resolution.js").resolveInternalSessionKey;
let resolveMainSessionAlias: typeof import("./sessions-resolution.js").resolveMainSessionAlias;
let resolveSessionReference: typeof import("./sessions-resolution.js").resolveSessionReference;
let resolveVisibleSessionReference: typeof import("./sessions-resolution.js").resolveVisibleSessionReference;
let shouldResolveSessionIdInput: typeof import("./sessions-resolution.js").shouldResolveSessionIdInput;

beforeAll(async () => {
  ({
    resolveCurrentSessionClientAlias,
    resolveDisplaySessionKey,
    resolveInternalSessionKey,
    resolveMainSessionAlias,
    resolveSessionReference,
    resolveVisibleSessionReference,
    shouldResolveSessionIdInput,
  } = await import("./sessions-resolution.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

function expectResolvedSessionReference(
  result: Awaited<ReturnType<typeof resolveSessionReference>>,
  expected: { key: string; displayKey: string; resolvedViaSessionId: boolean },
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected resolved session reference");
  }
  expect(result.key).toBe(expected.key);
  expect(result.displayKey).toBe(expected.displayKey);
  expect(result.resolvedViaSessionId).toBe(expected.resolvedViaSessionId);
}

describe("resolveMainSessionAlias", () => {
  it("uses normalized main key and global alias for global scope", () => {
    const cfg = {
      session: { mainKey: " Primary ", scope: "global" },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "primary",
      alias: "global",
      scope: "global",
    });
  });

  it("falls back to per-sender defaults", () => {
    expect(resolveMainSessionAlias({} as OpenClawConfig)).toEqual({
      mainKey: "main",
      alias: "main",
      scope: "per-sender",
    });
  });

  it("uses session.mainKey over any legacy routing sessions key", () => {
    const cfg = {
      session: { mainKey: "  work ", scope: "per-sender" },
      routing: { sessions: { mainKey: "legacy-main" } },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "work",
      alias: "work",
      scope: "per-sender",
    });
  });
});

describe("session key display/internal mapping", () => {
  it("maps alias and main key to display main", () => {
    expect(resolveDisplaySessionKey({ key: "global", alias: "global", mainKey: "main" })).toBe(
      "main",
    );
    expect(resolveDisplaySessionKey({ key: "main", alias: "global", mainKey: "main" })).toBe(
      "main",
    );
    expect(
      resolveDisplaySessionKey({ key: "agent:ops:main", alias: "global", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });

  it("maps input main to alias for internal routing", () => {
    expect(resolveInternalSessionKey({ key: "main", alias: "global", mainKey: "main" })).toBe(
      "global",
    );
    expect(
      resolveInternalSessionKey({ key: "agent:ops:main", alias: "global", mainKey: "main" }),
    ).toBe("agent:ops:main");
  });

  it("maps current to requester session key", () => {
    expect(
      resolveInternalSessionKey({
        key: "current",
        alias: "global",
        mainKey: "main",
        requesterInternalKey: "agent:support:main",
      }),
    ).toBe("agent:support:main");
  });

  it("preserves literal current when no requester key is provided", () => {
    expect(resolveInternalSessionKey({ key: "current", alias: "global", mainKey: "main" })).toBe(
      "current",
    );
  });

  it("maps interactive client ids to the requester session", () => {
    expect(
      resolveCurrentSessionClientAlias({
        key: "openclaw-tui",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
    expect(resolveCurrentSessionClientAlias({ key: "openclaw-tui" })).toBeUndefined();
    expect(
      resolveCurrentSessionClientAlias({
        key: "node-host",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });
});

describe("session reference shape detection", () => {
  it("detects session ids", () => {
    expect(looksLikeSessionId("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(looksLikeSessionId("not-a-uuid")).toBe(false);
  });

  it("treats non-keys as session-id candidates", () => {
    expect(shouldResolveSessionIdInput("main")).toBe(false);
    expect(shouldResolveSessionIdInput("agent:main:main")).toBe(false);
    expect(shouldResolveSessionIdInput("current")).toBe(false);
    expect(shouldResolveSessionIdInput("cron:daily-report")).toBe(false);
    expect(shouldResolveSessionIdInput("node:macbook")).toBe(false);
    expect(shouldResolveSessionIdInput("forum:group:123")).toBe(false);
    expect(shouldResolveSessionIdInput("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(shouldResolveSessionIdInput("random-slug")).toBe(true);
  });
});

describe("resolved session visibility checks", () => {
  it("rejects incognito targets without consulting Gateway", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";

    await expect(
      resolveVisibleSessionReference({
        action: "history",
        resolvedSession: {
          ok: true,
          key: sessionKey,
          displayKey: sessionKey,
          resolvedViaSessionId: false,
        },
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: sessionKey,
      }),
    ).resolves.toMatchObject({ ok: false, status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("resolveSessionReference", () => {
  it("uses a scoped key's encoded owner before visibility policy", async () => {
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { key?: string; agentId?: string } }) => {
        expect(request.method).toBe("sessions.resolve");
        expect(request.params).toMatchObject({ key: "Agent:ops:main", agentId: "ops" });
        return { key: "agent:ops:main", agentId: "ops" };
      },
    );

    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "Agent:ops:main",
      keyAgentId: "main",
      agentId: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      resolvedViaSessionId: false,
    });
  });

  it("resolves current directly to the requester without probing another owner", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "current",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:subagent:child",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "agent:main:subagent:child",
      displayKey: "agent:main:subagent:child",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not reinterpret a failed custom-key lookup as a sessionId miss", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway unavailable",
        retryable: true,
      }),
    );

    await expect(
      resolveSessionReference({
        action: "send",
        sessionKey: "custom-selector",
        alias: "main",
        mainKey: "main",
        requesterInternalKey: "agent:main:main",
        restrictToSpawned: true,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "forbidden",
      error:
        "Session send denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("treats the TUI client label as the requester session", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "openclaw-tui",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "agent:main:main",
      displayKey: "agent:main:main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("preserves the main alias without probing configured-main bootstrap", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "main",
      displayKey: "main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("defers explicit-key lookup to action-aware visibility resolution", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:main:worker",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });

    expect(result).toEqual({
      ok: true,
      key: "agent:main:worker",
      displayKey: "agent:main:worker",
      resolvedViaSessionId: false,
      requesterOwned: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown explicit session key for history", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "No session found: agent:main:missing",
      }),
    );

    const resolvedSession = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:main:missing",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "history",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:missing",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "No session found: agent:main:missing",
      displayKey: "agent:main:missing",
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

  it("canonicalizes an existing explicit session key", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:OPS:main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:main",
    });

    expect(result).toEqual({
      ok: true,
      agentId: "ops",
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      requesterOwned: false,
    });
  });

  it("rejects an explicit key that canonicalizes to an incognito session", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:dashboard:incognito-private" });

    const resolvedSession = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:OPS:dashboard:private",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "history",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:dashboard:private",
    });

    expect(result).toEqual({
      ok: false,
      status: "forbidden",
      error: "Session not visible from session tools: agent:OPS:dashboard:private",
      displayKey: "agent:ops:dashboard:incognito-private",
    });
  });

  it("propagates explicit-key gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:worker",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:worker",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "gateway unavailable",
      displayKey: "agent:main:worker",
    });
  });

  it("reports an allowed missing explicit key for deliberate bootstrap", async () => {
    callGatewayMock.mockResolvedValueOnce({});

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:main",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:dashboard:requester",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:main",
      allowMissingKey: true,
    });

    expect(result).toEqual({
      ok: true,
      agentId: "main",
      key: "agent:main:main",
      displayKey: "agent:main:main",
      missing: true,
      requesterOwned: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "agent:main:main",
        agentId: "main",
        spawnedBy: undefined,
        allowMissing: true,
      },
    });
  });
});
