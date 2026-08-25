// Onboarding Gateway probe tests cover reachability and configured-model classification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { probeGatewayConfiguredModel, probeGatewayReachable } from "./onboard-helpers.js";

const mocks = vi.hoisted(() => ({ probeGateway: vi.fn() }));

vi.mock("../gateway/probe.js", () => ({ probeGateway: mocks.probeGateway }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("probeGatewayReachable", () => {
  it("uses a hello-only probe for onboarding reachability", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 42,
      error: null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
      token: "tok_test",
      timeoutMs: 2500,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 2500,
      auth: {
        token: "tok_test",
        password: undefined,
      },
      detailLevel: "none",
    });
  });

  it("forwards configured remote edge auth to the gateway probe", async () => {
    mocks.probeGateway.mockResolvedValueOnce({ ok: true, configSnapshot: null });
    const config: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    };

    await expect(probeGatewayReachable({ url: "wss://gateway.example", config })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wss://gateway.example", config }),
    );
  });

  it("returns the probe error detail on failure", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
    });

    expect(result).toEqual({
      ok: false,
      detail: "connect failed: timeout",
    });
  });

  it("bounds thrown probe errors without splitting UTF-16", async () => {
    const detail = `${"x".repeat(118)}…`;
    const params = { url: "ws://127.0.0.1:18789" };
    mocks.probeGateway.mockRejectedValue(new Error(`${"x".repeat(118)}🚀tail\nignored`));
    expect(await probeGatewayReachable(params)).toEqual({ ok: false, detail });
    expect(await probeGatewayConfiguredModel(params)).toEqual({ kind: "unreachable", detail });
  });

  it("forwards a configured TLS fingerprint to the gateway probe", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        tlsFingerprint: "sha256:11:22:33:44",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 1500,
      auth: {
        token: undefined,
        password: undefined,
      },
      tlsFingerprint: "sha256:11:22:33:44",
      detailLevel: "none",
    });
  });

  it("lets a configured preauth handshake timeout widen the default probe budget", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 30_000,
      auth: {
        token: undefined,
        password: undefined,
      },
      preauthHandshakeTimeoutMs: 30_000,
      detailLevel: "none",
    });
  });

  it("classifies configured and missing default-agent models from config-only probes", async () => {
    mocks.probeGateway
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-configured" },
        configSnapshot: {
          valid: true,
          config: { agents: { list: [{ id: "work", default: true, model: "openai/gpt-5.5" }] } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-missing" },
        configSnapshot: { valid: true, config: { gateway: { mode: "local" } } },
      });

    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({ kind: "configured" });
    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "config" }),
    );
  });

  it("keeps post-Hello config read failures on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "config.get: unauthorized",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });
  });

  it("keeps typed pre-Hello Gateway auth failures on the reachable path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "device pairing required",
      connectErrorDetails: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      auth: { role: null, scopes: [], capability: "pairing_pending" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "device pairing required",
    });
  });

  it("does not mistake an arbitrary open WebSocket for a Gateway", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "websocket closed",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "websocket closed",
    });
  });

  it("does not trust an unrecognized connect error code as Gateway evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "foreign protocol error",
      connectErrorDetails: { code: "NOT_AN_OPENCLAW_CONNECT_ERROR" },
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "foreign protocol error",
    });
  });

  it("does not trust a config-shaped response without Gateway handshake evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      error: null,
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "foreign-server", connId: null },
      configSnapshot: {
        valid: true,
        config: { agents: { defaults: { model: "openai/foreign-model" } } },
      },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("keeps a first-time connect-only auth result on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "missing scope: operator.read",
      auth: { role: "operator", scopes: [], capability: "connected_no_operator_scope" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "missing scope: operator.read",
    });
  });

  it("treats an invalid config snapshot as reachable but unverified", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      server: { version: "2026.7.2", connId: "conn-1" },
      configSnapshot: { valid: false },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    });
  });

  it("distinguishes pre-Hello connection failures from reachable Gateway failures", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: null,
      error: "connect failed: timeout",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "connect failed: timeout",
    });
  });
});
