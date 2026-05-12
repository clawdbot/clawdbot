import { describe, expect, it, vi } from "vitest";
import { probeGatewayStatus } from "./probe.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

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
    });
  }

  function expectPairingPendingCloseResult(result: Awaited<ReturnType<typeof probeGatewayStatus>>) {
    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      auth: pairingPendingAuth,
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
  });

  it("uses a real status RPC when requireRpc is enabled", async () => {
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

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      tlsFingerprint: "abc123",
      timeoutMs: 5_000,
      json: true,
      requireRpc: true,
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
    });
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
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: "abc123",
      method: "status",
      timeoutMs: 5_000,
      configPath: "/tmp/openclaw-daemon/openclaw.json",
    });
  });

  it("forwards configured handshake timeout to the connect probe and status RPC", async () => {
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
    const config = { gateway: { handshakeTimeoutMs: 30_000 } };

    await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      config,
      preauthHandshakeTimeoutMs: 30_000,
      timeoutMs: 30_000,
      requireRpc: true,
    });

    expect(probeGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      auth: {
        token: "temp-token",
        password: undefined,
      },
      tlsFingerprint: undefined,
      preauthHandshakeTimeoutMs: 30_000,
      timeoutMs: 30_000,
      includeDetails: false,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:19191",
      token: "temp-token",
      password: undefined,
      tlsFingerprint: undefined,
      config,
      method: "status",
      timeoutMs: 30_000,
    });
  });

  it("falls back to read-only when the status RPC succeeds but the auth probe is inconclusive", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });
    probeGatewayMock.mockResolvedValueOnce({
      ok: true,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
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
        role: null,
        scopes: [],
        capability: "unknown",
      },
    });
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

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("connect");
    expect(result.error).toBe("scope upgrade pending approval (requestId: req-123)");
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
      error: "missing scope: operator.admin",
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });
});
