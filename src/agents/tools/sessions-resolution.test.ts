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
        action: "history",
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
        action: "history",
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
        action: "history",
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

  it("retries literal current probes without allowMissing for older gateways", async () => {
    const unsupportedAllowMissing = () =>
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid sessions.resolve params: at root: unexpected property 'allowMissing'",
      });
    callGatewayMock
      .mockRejectedValueOnce(unsupportedAllowMissing())
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "No session found: current",
        }),
      )
      .mockRejectedValueOnce(unsupportedAllowMissing())
      .mockResolvedValueOnce({ key: "agent:ops:main" });

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
        key: "current",
        spawnedBy: undefined,
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(3, {
      method: "sessions.resolve",
      params: {
        sessionId: "current",
        spawnedBy: undefined,
        includeGlobal: true,
        includeUnknown: true,
        allowMissing: true,
      },
    });
    expect(callGatewayMock).toHaveBeenNthCalledWith(4, {
      method: "sessions.resolve",
      params: {
        sessionId: "current",
        spawnedBy: undefined,
        includeGlobal: true,
        includeUnknown: true,
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
});
