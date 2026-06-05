// Gateway probe tests cover bootstrap auth, pairing prompts, startup retries,
// event-loop readiness checks, and close/error reporting.
import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  startCalls: 0,
  startMode: "hello" as "hello" | "close" | "connect-error-close" | "startup-retry-then-hello",
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
  stopCalls: 0,
  stopAndWaitCalls: [] as Array<{ timeoutMs?: number } | undefined>,
  stopAndWaitMode: "resolve" as "resolve" | "defer" | "reject",
  resolveStopAndWait: null as (() => void) | null,
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
  identityPaths: [] as unknown[],
  tokenParams: [] as unknown[],
}));

const eventLoopReadyState = vi.hoisted(() => ({
  calls: [] as Array<{ maxWaitMs?: number } | undefined>,
  result: {
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  },
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

  private async emitHelloOk(): Promise<void> {
    const onHelloOk = this.opts.onHelloOk;
    if (typeof onHelloOk === "function") {
      await onHelloOk({
        type: "hello-ok",
        server: gatewayClientState.helloServer,
        auth: gatewayClientState.helloAuth,
      });
    }
  }

  private emitClose(): void {
    const onClose = this.opts.onClose;
    if (typeof onClose === "function") {
      onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
    }
  }

  start(): void {
    gatewayClientState.startCalls += 1;
    void Promise.resolve()
      .then(async () => {
        if (gatewayClientState.startMode === "close") {
          this.emitClose();
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
          this.emitClose();
          return;
        }
        if (gatewayClientState.startMode === "startup-retry-then-hello") {
          await this.emitHelloOk();
          return;
        }
        await this.emitHelloOk();
      })
      .catch(() => {});
  }

  stop(): void {
    gatewayClientState.stopCalls += 1;
  }

  async stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    gatewayClientState.stopAndWaitCalls.push(opts);
    if (gatewayClientState.stopAndWaitMode === "reject") {
      throw new Error("close drain failed");
    }
    if (gatewayClientState.stopAndWaitMode === "defer") {
      await new Promise<void>((resolve) => {
        gatewayClientState.resolveStopAndWait = resolve;
      });
    }
  }

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
  loadDeviceIdentityIfPresent: (filePath: unknown) => {
    deviceIdentityState.identityPaths.push(filePath);
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
}));

vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthToken: (params: unknown) => {
    deviceIdentityState.tokenParams.push(params);
    return deviceIdentityState.cachedToken;
  },
}));

vi.mock("./event-loop-ready.js", () => ({
  waitForEventLoopReady: vi.fn((params?: { maxWaitMs?: number }) => {
    eventLoopReadyState.calls.push(params);
    return Promise.resolve(eventLoopReadyState.result);
  }),
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

type ProbeGatewayParams = Parameters<typeof probeGateway>[0];

function expectProbeResultFields(
  result: Awaited<ReturnType<typeof probeGateway>>,
  fields: Partial<Awaited<ReturnType<typeof probeGateway>>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(result[key as keyof typeof result]).toEqual(value);
  }
}

function expectProbeAuthFields(
  result: Awaited<ReturnType<typeof probeGateway>>,
  fields: Partial<Awaited<ReturnType<typeof probeGateway>>["auth"]>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(result.auth[key as keyof typeof result.auth]).toEqual(value);
  }
}

let probeUrlSeq = 0;

function nextProbeUrl(label: string): string {
  probeUrlSeq += 1;
  return `ws://127.0.0.1:18789/${label}-${probeUrlSeq}`;
}

function setDeviceRequiredProbeMode(): void {
  deviceIdentityState.cachedToken = null;
  gatewayClientState.startMode = "close";
  gatewayClientState.close = { code: 1008, reason: "device identity required" };
}

function lastGatewayClientOptions(): Record<string, unknown> | null {
  return gatewayClientState.options;
}

async function runLightweightProbe(url: string): Promise<Awaited<ReturnType<typeof probeGateway>>> {
  return await probeGateway({
    url,
    timeoutMs: 1_000,
    includeDetails: false,
  });
}

async function runTokenProbe(
  params: Partial<ProbeGatewayParams> = {},
): Promise<Awaited<ReturnType<typeof probeGateway>>> {
  return await probeGateway({
    url: "ws://127.0.0.1:18789",
    auth: { token: "secret" },
    timeoutMs: 1_000,
    ...params,
  });
}

async function runTokenLightweightProbe(
  params: Partial<ProbeGatewayParams> = {},
): Promise<Awaited<ReturnType<typeof probeGateway>>> {
  return await runTokenProbe({
    includeDetails: false,
    ...params,
  });
}

function expectLightweightProbeResult(result: Awaited<ReturnType<typeof probeGateway>>): void {
  expect(result.ok).toBe(true);
  expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  expect(gatewayClientState.requests).toStrictEqual([]);
}

async function primeDeviceRequiredProbeFailures(url: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await runLightweightProbe(url);
  }
}

function expectDeviceRequiredClose(
  result: Awaited<ReturnType<typeof probeGateway>>,
  hint?: string,
): void {
  expect(result.close).toEqual(
    hint
      ? { code: 1008, reason: "device identity required", hint }
      : { code: 1008, reason: "device identity required" },
  );
}

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
    deviceIdentityState.cachedToken = {
      token: "cached-operator-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    };
    deviceIdentityState.identityPaths = [];
    deviceIdentityState.tokenParams = [];
    gatewayClientState.startMode = "hello";
    gatewayClientState.options = null;
    gatewayClientState.requests = [];
    gatewayClientState.startCalls = 0;
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
    gatewayClientState.stopCalls = 0;
    gatewayClientState.stopAndWaitCalls = [];
    gatewayClientState.stopAndWaitMode = "resolve";
    gatewayClientState.resolveStopAndWait = null;
    eventLoopReadyState.calls = [];
    eventLoopReadyState.result = {
      ready: true,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 2,
      aborted: false,
    };
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });
  it("waits for event-loop readiness before connecting", async () => {
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(eventLoopReadyState.calls).toHaveLength(1);
    expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(1_000);
    expect(gatewayClientState.options?.url).toBe("ws://127.0.0.1:18789");
    expect(gatewayClientState.startCalls).toBe(1);
  });

  it("fails before connecting when event-loop readiness consumes the initial probe budget", async () => {
    eventLoopReadyState.result = {
      ready: false,
      elapsedMs: 250,
      maxDriftMs: 500,
      checks: 1,
      aborted: false,
    };

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1,
      includeDetails: false,
    });

    expectProbeResultFields(result, {
      ok: false,
      error: "timeout",
      close: null,
    });
    expectProbeAuthFields(result, {
      role: null,
      scopes: [],
      capability: "unknown",
    });
    expect(eventLoopReadyState.calls).toHaveLength(1);
    expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(250);
    expect(gatewayClientState.options?.url).toBe("ws://127.0.0.1:18789");
    expect(gatewayClientState.startCalls).toBe(0);
  });

  it("connects with operator.read scope", async () => {
    const result = await runTokenProbe();

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
    expectProbeAuthFields(result, {
      role: "operator",
      scopes: ["operator.read"],
      capability: "read_only",
    });
    expect(result.server).toEqual({
      version: "2026.4.24",
      connId: "conn-test",
    });
  });

  it("loads probe identity and cached device auth from the provided env", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: "/tmp/openclaw-probe-service-state",
    } as NodeJS.ProcessEnv;

    await runTokenProbe({ env });

    expect(deviceIdentityState.identityPaths).toEqual([
      "/tmp/openclaw-probe-service-state/identity/device.json",
    ]);
    expect(deviceIdentityState.tokenParams).toEqual([
      {
        deviceId: "test-device-identity",
        role: "operator",
        env,
      },
    ]);
    expect(gatewayClientState.options?.env).toBe(env);
  });

  it("keeps device identity enabled for remote probes", async () => {
    await runTokenProbe({
      url: "wss://gateway.example/ws",
    });

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("does not create or attach a device identity for first-time authenticated probes", async () => {
    deviceIdentityState.cachedToken = null;

    await runTokenProbe();

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
  });

  it("reuses cached device identity for unauthenticated loopback probes", async () => {
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("keeps device identity disabled for first-time unauthenticated loopback probes", async () => {
    deviceIdentityState.cachedToken = null;

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

    expectLightweightProbeResult(result);
  });

  it("keeps device identity enabled for authenticated lightweight probes", async () => {
    const result = await runTokenLightweightProbe();

    expectLightweightProbeResult(result);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;

    const result = await runTokenProbe();

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
    await runTokenLightweightProbe({
      url: "wss://gateway.example/ws",
      tlsFingerprint: "sha256:abc",
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:abc");
  });

  it("surfaces immediate close failures before the probe timeout", async () => {
    gatewayClientState.startMode = "close";

    const result = await runTokenLightweightProbe({
      timeoutMs: 5_000,
    });

    expectProbeResultFields(result, {
      ok: false,
      error: "gateway closed (1008): pairing required",
      close: { code: 1008, reason: "pairing required" },
    });
    expectProbeAuthFields(result, { capability: "pairing_pending" });
    expect(gatewayClientState.requests).toStrictEqual([]);
  });

  it("waits for gateway client close drain before resolving", async () => {
    gatewayClientState.stopAndWaitMode = "defer";

    const probePromise = runTokenLightweightProbe({
      url: nextProbeUrl("close-drain"),
    });
    let resolved = false;
    void probePromise.then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      expect(gatewayClientState.stopAndWaitCalls).toHaveLength(1);
    });
    expect(gatewayClientState.stopAndWaitCalls[0]).toEqual({ timeoutMs: 1_000 });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gatewayClientState.resolveStopAndWait?.();
    const result = await probePromise;

    expect(result.ok).toBe(true);
    expect(resolved).toBe(true);
    expect(gatewayClientState.stopCalls).toBe(0);
  });

  it("falls back to stop when close drain fails", async () => {
    gatewayClientState.stopAndWaitMode = "reject";

    const result = await runTokenLightweightProbe({
      url: nextProbeUrl("close-drain-fallback"),
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.stopAndWaitCalls).toHaveLength(1);
    expect(gatewayClientState.stopCalls).toBe(1);
  });

  it("reports write-capable auth when hello-ok scopes include operator.write", async () => {
    gatewayClientState.helloAuth = {
      role: "operator",
      scopes: ["operator.write"],
    };

    const result = await runTokenLightweightProbe();

    expectProbeAuthFields(result, {
      scopes: ["operator.write"],
      capability: "write_capable",
    });
  });

  it("keeps capability unknown when hello-ok omits auth metadata", async () => {
    gatewayClientState.helloAuth = undefined;

    const result = await runTokenLightweightProbe();

    expectProbeAuthFields(result, {
      role: null,
      scopes: [],
      capability: "unknown",
    });
  });

  it("reports connect-only only when hello-ok explicitly includes empty auth metadata", async () => {
    gatewayClientState.helloAuth = {};

    const result = await runTokenLightweightProbe();

    expectProbeAuthFields(result, {
      role: null,
      scopes: [],
      capability: "connected_no_operator_scope",
    });
  });

  it("prefers the structured connect error over the generic close reason", async () => {
    gatewayClientState.startMode = "connect-error-close";

    const result = await runTokenLightweightProbe({
      timeoutMs: 5_000,
    });

    expectProbeResultFields(result, {
      ok: false,
      error: "scope upgrade pending approval (requestId: req-123)",
      close: { code: 1008, reason: "pairing required" },
    });
  });

  it("keeps probing through internally retried startup-unavailable handshakes", async () => {
    gatewayClientState.startMode = "startup-retry-then-hello";

    const result = await runTokenLightweightProbe();

    expectProbeResultFields(result, {
      ok: true,
      error: null,
      close: null,
    });
  });

  it("short-circuits later unpaired probes after repeated device-required closes", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("device-required");

    for (let i = 0; i < 3; i += 1) {
      gatewayClientState.options = null;
      const result = await runLightweightProbe(url);

      expectProbeResultFields(result, {
        ok: false,
        error: "gateway closed (1008): device identity required",
      });
      expectDeviceRequiredClose(result);
      expect(lastGatewayClientOptions()?.url).toBe(url);
    }

    const startCalls = gatewayClientState.startCalls;
    gatewayClientState.options = null;

    const result = await runLightweightProbe(url);

    expectProbeResultFields(result, {
      ok: false,
      connectLatencyMs: null,
      error: "gateway closed (1008): device identity required",
      close: {
        code: 1008,
        reason: "device identity required",
        hint: "probe short-circuited by recent device-required rejections",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    expectProbeAuthFields(result, {
      role: null,
      scopes: [],
      capability: "unknown",
    });
    expect(gatewayClientState.startCalls).toBe(startCalls);
    expect(lastGatewayClientOptions()).toBeNull();
  });

  it("does not cache other policy-close reasons", async () => {
    deviceIdentityState.cachedToken = null;
    gatewayClientState.startMode = "close";
    gatewayClientState.close = { code: 1008, reason: "pairing required" };
    const url = nextProbeUrl("pairing-required");

    for (let i = 0; i < 4; i += 1) {
      gatewayClientState.options = null;
      const result = await runLightweightProbe(url);

      expect(result.close).toEqual({ code: 1008, reason: "pairing required" });
      expect(lastGatewayClientOptions()?.url).toBe(url);
    }
  });

  it("keeps device-required probe cache entries per URL", async () => {
    setDeviceRequiredProbeMode();
    const firstUrl = nextProbeUrl("first-device-required");
    const secondUrl = nextProbeUrl("second-device-required");

    await primeDeviceRequiredProbeFailures(firstUrl);

    gatewayClientState.options = null;
    const result = await runLightweightProbe(secondUrl);

    expectDeviceRequiredClose(result);
    expect(result.close?.hint).toBeUndefined();
    expect(lastGatewayClientOptions()?.url).toBe(secondUrl);
  });

  it("expires device-required probe cache entries after the TTL", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("ttl-device-required");
    let nowMs = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await primeDeviceRequiredProbeFailures(url);

      nowMs += 5 * 60_000;
      gatewayClientState.options = null;
      const result = await runLightweightProbe(url);

      expectDeviceRequiredClose(result);
      expect(result.close?.hint).toBeUndefined();
      expect(lastGatewayClientOptions()?.url).toBe(url);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("lets paired probes clear prior device-required failures", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("paired-device-required");

    await primeDeviceRequiredProbeFailures(url);

    deviceIdentityState.cachedToken = {
      token: "cached-operator-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    };
    gatewayClientState.startMode = "hello";
    gatewayClientState.options = null;

    const success = await runLightweightProbe(url);

    expect(success.ok).toBe(true);
    expect(lastGatewayClientOptions()?.url).toBe(url);
    expect(lastGatewayClientOptions()?.deviceIdentity).toEqual(deviceIdentityState.value);

    setDeviceRequiredProbeMode();
    gatewayClientState.options = null;
    const afterSuccess = await runLightweightProbe(url);

    expectDeviceRequiredClose(afterSuccess);
    expect(afterSuccess.close?.hint).toBeUndefined();
    expect(lastGatewayClientOptions()?.url).toBe(url);
  });

  it("does not short-circuit explicit-auth probes after unauthenticated failures", async () => {
    setDeviceRequiredProbeMode();
    const url = nextProbeUrl("explicit-auth-device-required");

    await primeDeviceRequiredProbeFailures(url);

    gatewayClientState.startMode = "hello";
    gatewayClientState.helloAuth = {};
    gatewayClientState.options = null;

    const result = await runTokenLightweightProbe({
      url,
      auth: { token: "explicit-token" },
    });

    expect(result.ok).toBe(true);
    expectProbeAuthFields(result, { capability: "connected_no_operator_scope" });
    expect(lastGatewayClientOptions()?.url).toBe(url);
    expect(lastGatewayClientOptions()?.token).toBe("explicit-token");
    expect(lastGatewayClientOptions()?.deviceIdentity).toBeNull();
  });
});
