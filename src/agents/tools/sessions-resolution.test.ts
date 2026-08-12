// Sessions resolution tests cover alias mapping, session-id lookup, visibility
// verification, and requester-spawned access checks.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
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
  it("rejects incognito targets even when the requester is the same session", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";

    await expect(
      resolveVisibleSessionReference({
        action: "status",
        resolvedSession: {
          ok: true,
          key: sessionKey,
          displayKey: sessionKey,
          resolvedViaSessionId: false,
        },
        requesterSessionKey: sessionKey,
        restrictToSpawned: false,
        visibilitySessionKey: sessionKey,
      }),
    ).resolves.toMatchObject({ ok: false, status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("requires spawned-session verification only for sandboxed key-based cross-session access", async () => {
    const cases = [
      {
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
        expectsGateway: true,
      },
      {
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: false,
        resolvedViaSessionId: false,
        expectsGateway: false,
      },
      {
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:worker",
        restrictToSpawned: true,
        resolvedViaSessionId: true,
        expectsGateway: false,
      },
      {
        requesterSessionKey: "agent:main:main",
        targetSessionKey: "agent:main:main",
        restrictToSpawned: true,
        resolvedViaSessionId: false,
        expectsGateway: false,
      },
    ];

    for (const testCase of cases) {
      callGatewayMock.mockResolvedValueOnce({ key: testCase.targetSessionKey });
      const result = resolveVisibleSessionReference({
        action: "status",
        resolvedSession: {
          ok: true,
          key: testCase.targetSessionKey,
          displayKey: testCase.targetSessionKey,
          resolvedViaSessionId: testCase.resolvedViaSessionId,
        },
        requesterSessionKey: testCase.requesterSessionKey,
        restrictToSpawned: testCase.restrictToSpawned,
        visibilitySessionKey: testCase.targetSessionKey,
      });

      await expect(result).resolves.toEqual({
        ok: true,
        key: testCase.targetSessionKey,
        displayKey: testCase.targetSessionKey,
      });
      expect(callGatewayMock).toHaveBeenCalledTimes(testCase.expectsGateway ? 1 : 0);
      callGatewayMock.mockReset();
    }
  });

  it("does not hide an exact spawned target behind the sessions.list visibility cap", async () => {
    // Exact spawned-session resolution should not depend on a truncated list
    // response; otherwise high-volume session stores hide valid children.
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { key?: string } }) => {
        if (request.method === "sessions.resolve") {
          return { key: request.params?.key };
        }
        if (request.method === "sessions.list") {
          return {
            sessions: Array.from({ length: 500 }, (_, index) => ({
              key: `agent:main:subagent:worker-${index}`,
            })),
          };
        }
        return {};
      },
    );

    await expect(
      resolveVisibleSessionReference({
        action: "status",
        resolvedSession: {
          ok: true,
          key: "agent:main:subagent:worker-999",
          displayKey: "agent:main:subagent:worker-999",
          resolvedViaSessionId: false,
        },
        requesterSessionKey: "agent:main:main",
        restrictToSpawned: true,
        visibilitySessionKey: "agent:main:subagent:worker-999",
      }),
    ).resolves.toEqual({
      ok: true,
      key: "agent:main:subagent:worker-999",
      displayKey: "agent:main:subagent:worker-999",
    });
  });

  it("falls back to spawned-session listing when exact resolution is unsupported", async () => {
    callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        throw new Error("unsupported sessions.resolve shape");
      }
      return { sessions: [{ key: "agent:main:subagent:worker" }] };
    });

    await expect(
      resolveVisibleSessionReference({
        action: "status",
        resolvedSession: {
          ok: true,
          key: "agent:main:subagent:worker",
          displayKey: "agent:main:subagent:worker",
          resolvedViaSessionId: false,
        },
        requesterSessionKey: "agent:main:main",
        restrictToSpawned: true,
        visibilitySessionKey: "agent:main:subagent:worker",
      }),
    ).resolves.toMatchObject({ ok: true, key: "agent:main:subagent:worker" });
    expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.resolve",
      "sessions.list",
    ]);
  });
});

describe("resolveSessionReference", () => {
  it("prefers a literal current session key before alias fallback", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "current" });

    const result = await resolveSessionReference({
      sessionKey: "current",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:subagent:child",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "current",
      displayKey: "current",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "current",
        spawnedBy: undefined,
        allowMissing: true,
      },
    });
  });

  it("prefers a literal current sessionId before alias fallback", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const result = await resolveSessionReference({
      sessionKey: "current",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:subagent:child",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      resolvedViaSessionId: true,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.resolve",
      params: {
        key: "current",
        spawnedBy: undefined,
        allowMissing: true,
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(2, {
      method: "sessions.resolve",
      params: {
        sessionId: "current",
        spawnedBy: undefined,
        includeGlobal: true,
        includeUnknown: true,
        allowMissing: true,
      },
    });
  });

  it("does not compatibility-retry unrelated gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway timeout")).mockResolvedValueOnce({});

    const result = await resolveSessionReference({
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
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("skips literal current key lookup when spawned visibility is restricted", async () => {
    const result = await resolveSessionReference({
      sessionKey: "current",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:subagent:child",
      restrictToSpawned: true,
    });
    expectResolvedSessionReference(result, {
      key: "agent:main:subagent:child",
      displayKey: "agent:main:subagent:child",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(1, {
      method: "sessions.resolve",
      params: {
        sessionId: "current",
        spawnedBy: "agent:main:subagent:child",
        includeGlobal: false,
        includeUnknown: false,
        allowMissing: true,
      },
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("treats the TUI client label as the requester session", async () => {
    const result = await resolveSessionReference({
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
        spawnedBy: undefined,
      },
    });
  });

  it("canonicalizes an existing explicit session key", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const resolvedSession = await resolveSessionReference({
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
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:main",
    });

    expect(result).toEqual({
      ok: true,
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
    });
  });

  it("rejects an explicit key that canonicalizes to an incognito session", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:dashboard:incognito-private" });

    const resolvedSession = await resolveSessionReference({
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

  it("conceals a missing explicit key from sandboxed callers", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found: agent:main:missing"));

    const resolvedSession = await resolveSessionReference({
      sessionKey: "agent:main:missing",
      alias: "main",
      mainKey: "main",
      requesterInternalKey: "agent:main:subagent:child",
      restrictToSpawned: true,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      action: "history",
      resolvedSession,
      requesterSessionKey: "agent:main:subagent:child",
      restrictToSpawned: true,
      visibilitySessionKey: "agent:main:missing",
    });

    expect(result).toEqual({
      ok: false,
      status: "forbidden",
      error: "Session not visible from this sandboxed agent session: agent:main:missing",
      displayKey: "agent:main:missing",
    });
  });

  it("propagates explicit-key gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));

    const resolvedSession = await resolveSessionReference({
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
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:main",
      allowMissingKey: true,
    });

    expect(result).toEqual({
      ok: true,
      key: "agent:main:main",
      displayKey: "agent:main:main",
      missing: true,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "agent:main:main",
        spawnedBy: undefined,
        allowMissing: true,
      },
    });
  });
});
