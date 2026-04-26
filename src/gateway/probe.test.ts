import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  startMode: "hello" as "hello" | "close" | "connect-error-close",
  close: { code: 1008, reason: "pairing required" },
  helloAuth: {
    role: "operator",
    scopes: ["operator.read"],
  } as { role?: string; scopes?: string[] } | undefined,
  helloServer: {
    version: "2026.4.24",
    connId: "conn-test",
  },
  connectError: "scope upgrade pending approval (requestId: req-123)",
  connectErrorDetails: {
    code: "PAIRING_REQUIRED",
    reason: "scope-upgrade",
    requestId: "req-123",
  } as Record<string, unknown> | null,
}));

const deviceIdentityState = vi.hoisted(() => ({
  value: { deviceId: "test-device-identity" } as Record<string, unknown>,
  throwOnLoad: false,
  cachedToken: {
    token: "cached-operator-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 1,
  } as Record<string, unknown> | null,
}));

class MockGatewayClientRequestError extends Error {
  readonly details?: unknown;

  constructor(error: { message?: string; details?: unknown }) {
    super(error.message ?? "gateway request failed");
    this.details = error.details;
  }
}

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.requests = [];
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (gatewayClientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
          }
          return;
        }
        if (gatewayClientState.startMode === "connect-error-close") {
          const onConnectError = this.opts.onConnectError;
          if (typeof onConnectError === "function") {
            onConnectError(
              new MockGatewayClientRequestError({
                message: gatewayClientState.connectError,
                details: gatewayClientState.connectErrorDetails,
              }),
            );
          }
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
          }
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk({
            type: "hello-ok",
            server: gatewayClientState.helloServer,
            auth: gatewayClientState.helloAuth,
          });
        }
      })
      .catch(() => {});
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
  GatewayClientRequestError: MockGatewayClientRequestError,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => {
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
  loadDeviceIdentityIfPresent: () => {
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
}));

vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthToken: () => deviceIdentityState.cachedToken,
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
    deviceIdentityState.cachedToken = {
      token: "cached-operator-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    };
    gatewayClientState.startMode = "hello";
    gatewayClientState.close = { code: 1008, reason: "pairing required" };
    gatewayClientState.helloAuth = {
      role: "operator",
      scopes: ["operator.read"],
    };
    gatewayClientState.connectError = "scope upgrade pending approval (requestId: req-123)";
    gatewayClientState.connectErrorDetails = {
      code: "PAIRING_REQUIRED",
      reason: "scope-upgrade",
      requestId: "req-123",
    };
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
    expect(result.auth).toMatchObject({
      role: "operator",
      scopes: ["operator.read"],
      capability: "read_only",
    });
    expect(result.server).toEqual({
      version: "2026.4.24",
      connId: "conn-test",
    });
  });

  it("keeps device identity enabled for remote probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("does not create or attach a device identity for first-time authenticated probes", async () => {
    deviceIdentityState.cachedToken = null;

    await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
  });

  it("keeps device identity disabled for unauthenticated loopback probes", async () => {
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
  });

  it("skips detail RPCs for lightweight reachability probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("keeps device identity enabled for authenticated lightweight probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
  });

  it("fetches only presence for presence-only probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      detailLevel: "presence",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual(["system-presence"]);
    expect(result.health).toBeNull();
    expect(result.status).toBeNull();
    expect(result.configSnapshot).toBeNull();
  });

  it("passes through tls fingerprints for secure daemon probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      tlsFingerprint: "sha256:abc",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:abc");
  });

  it("surfaces immediate close failures before the probe timeout", async () => {
    gatewayClientState.startMode = "close";

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5_000,
      includeDetails: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "gateway closed (1008): pairing required",
      close: { code: 1008, reason: "pairing required" },
      auth: { capability: "pairing_pending" },
    });
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("reports write-capable auth when hello-ok scopes include operator.write", async () => {
    gatewayClientState.helloAuth = {
      role: "operator",
      scopes: ["operator.write"],
    };

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.auth).toMatchObject({
      scopes: ["operator.write"],
      capability: "write_capable",
    });
  });

  it("keeps capability unknown when hello-ok omits auth metadata", async () => {
    gatewayClientState.helloAuth = undefined;

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.auth).toMatchObject({
      role: null,
      scopes: [],
      capability: "unknown",
    });
  });

  it("reports connect-only only when hello-ok explicitly includes empty auth metadata", async () => {
    gatewayClientState.helloAuth = {};

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.auth).toMatchObject({
      role: null,
      scopes: [],
      capability: "connected_no_operator_scope",
    });
  });

  it("prefers the structured connect error over the generic close reason", async () => {
    gatewayClientState.startMode = "connect-error-close";

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5_000,
      includeDetails: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "scope upgrade pending approval (requestId: req-123)",
      close: { code: 1008, reason: "pairing required" },
    });
  });
});
