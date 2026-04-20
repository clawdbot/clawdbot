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
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: null,
      close: { code: 1008, reason: "pairing required" },
      auth: {
        role: null,
        scopes: [],
        capability: "pairing_pending",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      auth: {
        role: null,
        scopes: [],
        capability: "pairing_pending",
      },
      error: "gateway closed (1008): pairing required",
    });
  });

  it("prefers the close reason over a generic timeout when both are present", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      ok: false,
      error: "timeout",
      close: { code: 1008, reason: "pairing required" },
      auth: {
        role: null,
        scopes: [],
        capability: "pairing_pending",
      },
    });

    const result = await probeGatewayStatus({
      url: "ws://127.0.0.1:19191",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      ok: false,
      kind: "connect",
      capability: "pairing_pending",
      auth: {
        role: null,
        scopes: [],
        capability: "pairing_pending",
      },
      error: "gateway closed (1008): pairing required",
    });
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

    expect(result).toMatchObject({
      ok: false,
      kind: "connect",
      error: "scope upgrade pending approval (requestId: req-123)",
    });
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
