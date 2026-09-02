// Daemon probe tests cover gateway probe command behavior and output.
import { assert, describe, expect, it, vi } from "vitest";
import { gatewayProbeResultSawGateway } from "../../commands/gateway-health-auth-diagnostic.js";
import { probeGatewayStatus } from "./probe.js";
import type { DaemonStatus } from "./status.gather.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/probe.js")>()),
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

function createDaemonStatus(rpc: NonNullable<DaemonStatus["rpc"]>): DaemonStatus {
  return {
    service: {
      label: "test service",
      loaded: true,
      loadState: { status: "loaded" },
      loadedText: "loaded",
      notLoadedText: "not loaded",
    },
    rpc,
    extraServices: [],
  };
}

describe("probeGatewayStatus", () => {
  const pairingPendingAuth = {
    role: null,
    scopes: [],
    capability: "pairing_pending",
  } as const;

  function mockPairingPendingCloseProbe(error: string | null) {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error,
      close: { code: 1008, reason: "pairing required" },
      auth: pairingPendingAuth,
      gatewayReached: true,
    });
  }

  function expectPairingPendingCloseResult(result: Awaited<ReturnType<typeof probeGatewayStatus>>) {
    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      gatewayReached: true,
      auth: pairingPendingAuth,
      connectFailure: { kind: "pairing-required" },
      error: "gateway closed (1008): pairing required",
    });
  }

  it("uses lightweight token-only probing for daemon status", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "connect",
      capability: "write_capable",
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(probeGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      auth: {
        token: "temp-token",
        password: undefined,
      },
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      includeDetails: false,
    });
  });

  it("projects allowlisted connect failure details without serializing raw payloads", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: { code: 1008, reason: "connect failed" },
      connectErrorDetails: {
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        secret: "do-not-print",
      },
      auth: pairingPendingAuth,
      gatewayReached: true,
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
      json: true,
    });

    assert(!result.ok);
    if (result.ok) {
      throw new Error("expected failed gateway probe");
    }
    expect(result.connectFailure).toEqual({
      kind: "pairing-required",
      detailCode: "PAIRING_REQUIRED",
    });
    expect(result).not.toHaveProperty("connectErrorDetails");
    expect(gatewayProbeResultSawGateway(result)).toBe(true);

    const json = JSON.stringify(createDaemonStatus(result));
    expect(json).not.toContain("do-not-print");
    expect(json).not.toContain('"secret"');
    expect(json).not.toContain("scope-upgrade");
  });

  it("classifies a legacy pairing close without treating its prose as Gateway evidence", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: { code: 1008, reason: "pairing required" },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
      json: true,
    });

    assert(!result.ok);
    if (result.ok) {
      throw new Error("expected failed gateway probe");
    }
    expect(result.error).toBe("connect failed");
    expect(result.connectFailure).toEqual({ kind: "pairing-required" });
    expect(gatewayProbeResultSawGateway(result)).toBe(false);
  });

  it.each(["connect ECONNREFUSED 127.0.0.1:19191", "gateway closed (1006): ", null])(
    "does not treat an unvalidated transport close with error %s as a Gateway response",
    async (error) => {
      probeGatewayMock.mockResolvedValueOnce({
        ok: false,
        error,
        close: { code: 1006, reason: "" },
      });

      const result = await probeGatewayStatus({
        url: "ws://127.0.0.1:19191",
        timeoutMs: 5_000,
        json: true,
      });

      assert(!result.ok);
      if (result.ok) {
        throw new Error("expected failed gateway probe");
      }
      expect(gatewayProbeResultSawGateway(result)).toBe(false);
    },
  );

  it("projects authentication rate limits as reachable temporary lockouts", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: {
        code: 1008,
        reason: "unauthorized: too many failed authentication attempts (retry later)",
      },
      connectErrorDetails: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
        retryAfterMs: 60_000,
      },
      gatewayReached: true,
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
      json: true,
    });

    assert(!result.ok);
    if (result.ok) {
      throw new Error("expected failed gateway probe");
    }
    expect(result.connectFailure).toEqual({
      kind: "rate-limited",
      detailCode: "AUTH_RATE_LIMITED",
    });
    expect(gatewayProbeResultSawGateway(result)).toBe(true);
    expect(JSON.stringify(createDaemonStatus(result))).not.toContain("retryAfterMs");
  });

  it("omits unknown detail codes from serialized daemon status", async () => {
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed",
      close: { code: 1008, reason: "connect failed" },
      connectErrorDetails: {
        code: "FUTURE_SENSITIVE_CODE",
        secret: "do-not-print-unknown",
      },
      auth: pairingPendingAuth,
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
      json: true,
    });

    assert(!result.ok);
    if (result.ok) {
      throw new Error("expected failed gateway probe");
    }
    expect(result.connectFailure).toEqual({ kind: "gateway-rejected" });

    const json = JSON.stringify(createDaemonStatus(result));
    expect(json).not.toContain("FUTURE_SENSITIVE_CODE");
    expect(json).not.toContain("do-not-print-unknown");
  });

  it("preserves gateway server version from the connect probe", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
      server: { version: "2026.5.6", connId: "conn-1" },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      json: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("server" in result)) {
      throw new Error("expected successful probe with server details");
    }
    expect(result.server?.version).toBe("2026.5.6");
    expect(result.server?.connId).toBe("conn-1");
    expect(result.version).toBe("2026.5.6");
  });

  it.each([undefined, 19191])(
    "uses a status RPC with local port override %s when requireRpc is enabled",
    async (localPortOverride) => {
      callGatewayMock.mockReset();
      probeGatewayMock.mockReset();
      callGatewayMock.mockImplementationOnce(async (opts) => {
        opts.onHelloOk?.({
          server: { version: "2026.8.1", buildId: "build-1", connId: "conn-1" },
          auth: { role: "operator", scopes: ["operator.admin"] },
        });
        return { runtimeVersion: "2026.8.1", status: "ok" };
      });

      const result = await probeGatewayStatus({
        url: "ws://127.0.0.1:19191",
        token: "temp-token",
        tlsFingerprint: "abc123",
        timeoutMs: 5_000,
        json: true,
        requireRpc: true,
        localPortOverride,
        configPath: "/tmp/openclaw-daemon/openclaw.json",
      });

      expect(result).toEqual({
        ok: true,
        kind: "read",
        capability: "admin_capable",
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          capability: "admin_capable",
        },
        server: {
          version: "2026.8.1",
          buildId: "build-1",
          connId: "conn-1",
        },
        version: "2026.8.1",
      });
      expect(probeGatewayMock).not.toHaveBeenCalled();
      expect(callGatewayMock).toHaveBeenCalledOnce();
      expect(callGatewayMock).toHaveBeenCalledWith({
        url: "ws://127.0.0.1:19191",
        localPortOverride,
        token: "temp-token",
        password: undefined,
        tlsFingerprint: "abc123",
        preauthHandshakeTimeoutMs: undefined,
        method: "status",
        timeoutMs: 5_000,
        sharedStateMode: "read-only",
        configPath: "/tmp/openclaw-daemon/openclaw.json",
        onHelloOk: expect.any(Function),
      });
    },
  );

  it("keeps required status to one timeout-bound RPC", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    const config = {};

    await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      config,
      preauthHandshakeTimeoutMs: 30_000,
      timeoutMs: 30_000,
      requireRpc: true,
    });

    expect(probeGatewayMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: undefined,
      preauthHandshakeTimeoutMs: 30_000,
      config,
      localPortOverride: undefined,
      method: "status",
      timeoutMs: 30_000,
      sharedStateMode: "read-only",
      onHelloOk: expect.any(Function),
    });
  });

  it("omits config-backed credentials from the status RPC when disabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: "operator",
        scopes: ["operator.admin"],
        capability: "admin_capable",
      },
    });
    const config = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    } as const;

    await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      config,
      timeoutMs: 5_000,
      requireRpc: true,
      allowRpcConfigCredentials: false,
    });

    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: undefined,
      preauthHandshakeTimeoutMs: undefined,
      method: "status",
      timeoutMs: 5_000,
      sharedStateMode: "read-only",
      onHelloOk: expect.any(Function),
      localPortOverride: undefined,
    });
  });

  it("fails before the status RPC when config credentials are disabled without explicit auth", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "exec", provider: "vault", id: "gateway/token" },
          },
        },
        secrets: {
          providers: {
            vault: { source: "exec", command: "/bin/false" },
          },
        },
      },
      timeoutMs: 5_000,
      requireRpc: true,
      allowRpcConfigCredentials: false,
    });

    expect(result).toEqual({
      ok: false,
      kind: "read",
      connectFailure: { kind: "unreachable" },
      error:
        "gateway status RPC skipped because configured gateway credentials are disabled for this status request",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });

  it("falls back to read-only when hello scopes are inconclusive", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockImplementationOnce(async (opts) => {
      opts.onHelloOk?.({
        server: { version: "2026.8.1", connId: "conn-1" },
        auth: { role: "operator", scopes: [] },
      });
      return { status: "ok" };
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      requireRpc: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "read",
      capability: "read_only",
      auth: {
        role: "operator",
        scopes: [],
        capability: "unknown",
      },
      server: { version: "2026.8.1", connId: "conn-1" },
      version: "2026.8.1",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });

  it("prefers same-connection server metadata over status.runtimeVersion", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockImplementationOnce(async (opts) => {
      opts.onHelloOk?.({
        server: { version: "2026.4.24", connId: "conn-1" },
        auth: { role: "operator", scopes: ["operator.read"] },
      });
      return { runtimeVersion: "2026.4.23", status: "ok" };
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      requireRpc: true,
    });

    expect(result).toEqual({
      ok: true,
      kind: "read",
      capability: "read_only",
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
      server: {
        version: "2026.4.24",
        connId: "conn-1",
      },
      version: "2026.4.24",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });

  it("surfaces probe close details when the handshake fails", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    mockPairingPendingCloseProbe(null);

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expectPairingPendingCloseResult(result);
  });

  it("prefers the close reason over a generic timeout when both are present", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    mockPairingPendingCloseProbe("timeout");

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expectPairingPendingCloseResult(result);
  });

  it("keeps actionable probe errors when the close reason stays generic", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "scope upgrade pending approval (requestId: req-123)",
      close: { code: 1008, reason: "pairing required" },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    assert(!result.ok);
    expect(result.kind).toBe("connect");
    expect(result.error).toBe("scope upgrade pending approval (requestId: req-123)");
  });

  it("redacts credential-bearing URLs echoed in probe failure text", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "connect failed to ws://user:secret@gw.example.com:18789?token=abc123",
      close: null,
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    assert(!result.ok);
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("abc123");
    expect(result.error).toContain("ws://***:***@gw.example.com:18789?token=***");
  });

  it("redacts credential-bearing URLs in thrown probe errors", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockRejectedValueOnce(
      new Error("dial ws://user:secret@gw.example.com:18789 refused"),
    );

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    assert(!result.ok);
    expect(result.error).not.toContain("secret");
    expect(result.error).toContain("ws://***:***@gw.example.com:18789");
  });

  it("surfaces status RPC errors when requireRpc is enabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockRejectedValueOnce(new Error("missing scope: operator.admin"));

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      timeoutMs: 5_000,
      requireRpc: true,
    });

    expect(result).toEqual({
      ok: false,
      kind: "read",
      connectFailure: { kind: "unreachable" },
      error: "missing scope: operator.admin",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });
});
