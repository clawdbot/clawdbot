// Gateway call tests cover connection detail resolution, local/remote URL choice,
// auth token assembly, device identity, and client command metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  loadConfigMock as getRuntimeConfig,
  pickPrimaryLanIPv4Mock as pickPrimaryLanIPv4,
  pickPrimaryTailnetIPv4Mock as pickPrimaryTailnetIPv4,
  resolveGatewayPortMock as resolveGatewayPort,
} from "./gateway-connection.test-mocks.js";

const deviceIdentityState = vi.hoisted(() => ({
  value: {
    deviceId: "test-device-identity",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  } satisfies DeviceIdentity,
  throwOnLoad: false,
}));
const loadDeviceAuthTokenMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => DeviceAuthEntry | null>(() => null),
);

const eventLoopReadyState = vi.hoisted(() => ({
  calls: [] as Array<{ maxWaitMs?: number } | undefined>,
  promise: null as Promise<{
    ready: boolean;
    elapsedMs: number;
    maxDriftMs: number;
    checks: number;
    aborted: boolean;
  }> | null,
  result: {
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  },
}));

const connectAssemblyErrorState = vi.hoisted(() => {
  const errors = new WeakSet<Error>();
  return {
    create(message: string): Error {
      const error = new Error(message);
      errors.add(error);
      return error;
    },
    has(value: unknown): value is Error {
      return value instanceof Error && errors.has(value);
    },
  };
});

let lastClientOptions: {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
  clientName?: string;
  clientDisplayName?: string;
  mode?: string;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  scopes?: string[];
  deviceIdentity?: unknown;
  onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
  onClose?: (code: number, reason: string, info?: StubGatewayClientCloseInfo) => void;
  onConnectError?: (err: Error) => void;
} | null = null;
let lastRequestOptions: {
  method?: string;
  params?: unknown;
  opts?: {
    expectFinal?: boolean;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    onAccepted?: (payload: unknown) => void;
  };
} | null = null;
type StartMode =
  | "hello"
  | "close"
  | "connect-error"
  | "silent"
  | "startup-retry-then-hello"
  | "clean-prehello-close-then-hello"
  | "repeated-clean-prehello-close";
type StubGatewayClientCloseInfo = {
  phase: "pre-hello" | "post-hello";
  transientPreHelloCleanClose: boolean;
};
let startMode: StartMode = "hello";
let startCalls = 0;
let closeCode = 1006;
let closeReason = "";
let helloMethods: string[] | undefined = ["health", "secrets.resolve"];
let connectError: Error | null = null;

function startStubGatewayClient() {
  startCalls += 1;
  if (startMode === "hello") {
    void lastClientOptions?.onHelloOk?.({
      features: {
        methods: helloMethods,
      },
    });
  } else if (startMode === "startup-retry-then-hello") {
    void lastClientOptions?.onHelloOk?.({
      features: {
        methods: helloMethods,
      },
    });
  } else if (startMode === "clean-prehello-close-then-hello") {
    lastClientOptions?.onClose?.(1000, "", {
      phase: "pre-hello",
      transientPreHelloCleanClose: true,
    });
    void lastClientOptions?.onHelloOk?.({
      features: {
        methods: helloMethods,
      },
    });
  } else if (startMode === "repeated-clean-prehello-close") {
    lastClientOptions?.onClose?.(1000, "", {
      phase: "pre-hello",
      transientPreHelloCleanClose: true,
    });
    lastClientOptions?.onClose?.(1000, "", {
      phase: "pre-hello",
      transientPreHelloCleanClose: true,
    });
  } else if (startMode === "connect-error") {
    lastClientOptions?.onConnectError?.(
      connectError ?? connectAssemblyErrorState.create("device private key invalid"),
    );
  } else if (startMode === "close") {
    lastClientOptions?.onClose?.(closeCode, closeReason);
  }
}

vi.mock("./client.js", () => ({
  isGatewayConnectAssemblyError: (value: unknown) => connectAssemblyErrorState.has(value),
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      token?: string;
      password?: string;
      preauthHandshakeTimeoutMs?: number;
      clientName?: string;
      clientDisplayName?: string;
      mode?: string;
      approvalRuntimeToken?: string;
      agentRuntimeIdentityToken?: string;
      scopes?: string[];
      onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
      onClose?: (code: number, reason: string, info?: StubGatewayClientCloseInfo) => void;
      onConnectError?: (err: Error) => void;
    }) {
      lastClientOptions = opts;
    }
    async request(
      method: string,
      params: unknown,
      opts?: { expectFinal?: boolean; timeoutMs?: number | null },
    ) {
      lastRequestOptions = { method, params, opts };
      return { ok: true };
    }
    start() {
      startStubGatewayClient();
    }
    stop() {}
  },
}));

vi.mock("./event-loop-ready.js", () => ({
  waitForEventLoopReady: vi.fn(async (params?: { maxWaitMs?: number }) => {
    eventLoopReadyState.calls.push(params);
    if (eventLoopReadyState.promise) {
      return await eventLoopReadyState.promise;
    }
    return eventLoopReadyState.result;
  }),
}));

const {
  testing,
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  callGatewayCli,
  formatGatewayClientRequestErrorJson,
  formatGatewayTransportErrorJson,
  isGatewayTransportError,
} = await import("./call.js");

class StubGatewayClient {
  constructor(opts: {
    url?: string;
    token?: string;
    password?: string;
    preauthHandshakeTimeoutMs?: number;
    clientName?: string;
    clientDisplayName?: string;
    mode?: string;
    approvalRuntimeToken?: string;
    agentRuntimeIdentityToken?: string;
    scopes?: string[];
    onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
    onClose?: (code: number, reason: string, info?: StubGatewayClientCloseInfo) => void;
    onConnectError?: (err: Error) => void;
  }) {
    lastClientOptions = opts;
  }
  async request(
    method: string,
    params: unknown,
    opts?: {
      expectFinal?: boolean;
      timeoutMs?: number | null;
      signal?: AbortSignal;
      onAccepted?: (payload: unknown) => void;
    },
  ) {
    lastRequestOptions = { method, params, opts };
    return { ok: true };
  }
  start() {
    startStubGatewayClient();
  }
  stop() {}
  async stopAndWait() {}
}

function resetGatewayCallMocks() {
  getRuntimeConfig.mockClear();
  resolveGatewayPort.mockClear();
  pickPrimaryTailnetIPv4.mockClear();
  pickPrimaryLanIPv4.mockClear();
  lastClientOptions = null;
  lastRequestOptions = null;
  eventLoopReadyState.calls = [];
  eventLoopReadyState.promise = null;
  eventLoopReadyState.result = {
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 2,
    aborted: false,
  };
  startMode = "hello";
  startCalls = 0;
  closeCode = 1006;
  closeReason = "";
  helloMethods = ["health", "secrets.resolve"];
  connectError = null;
  const loadConfigForTests = getRuntimeConfig as unknown as () => OpenClawConfig;
  const resolveGatewayPortForTests = resolveGatewayPort as unknown as (
    cfg?: OpenClawConfig,
    env?: NodeJS.ProcessEnv,
  ) => number;
  testing.setDepsForTests({
    createGatewayClient: (opts) =>
      new StubGatewayClient(opts as ConstructorParameters<typeof StubGatewayClient>[0]) as never,
    getRuntimeConfig: loadConfigForTests,
    loadOrCreateDeviceIdentity: () => {
      if (deviceIdentityState.throwOnLoad) {
        throw new Error("read-only identity dir");
      }
      return deviceIdentityState.value;
    },
    loadDeviceAuthToken: loadDeviceAuthTokenMock,
    resolveGatewayPort: resolveGatewayPortForTests,
  });
  deviceIdentityState.throwOnLoad = false;
  loadDeviceAuthTokenMock.mockReset();
  loadDeviceAuthTokenMock.mockReturnValue({
    token: "paired-device-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 123,
  });
}

function setGatewayNetworkDefaults(port = 18789) {
  resolveGatewayPort.mockReturnValue(port);
  pickPrimaryTailnetIPv4.mockReturnValue(undefined);
}

function setLocalLoopbackGatewayConfig(port = 18789) {
  getRuntimeConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
  setGatewayNetworkDefaults(port);
}

function makeRemotePasswordGatewayConfig(remotePassword: string, localPassword = "from-config") {
  return {
    gateway: {
      mode: "remote",
      remote: { url: "wss://remote.example:18789", password: remotePassword },
      auth: { password: localPassword },
    },
  };
}

describe("callGateway url resolution", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_STATE_DIR",
  ]);

  beforeEach(() => {
    envSnapshot.restore();
    deleteTestEnvValue("OPENCLAW_ALLOW_INSECURE_PRIVATE_WS");
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    resetGatewayCallMocks();
  });

  afterEach(() => {
    envSnapshot.restore();
    testing.resetDepsForTests();
  });

  it.each([
    {
      label: "keeps loopback when local bind is auto even if tailnet is present",
      tailnetIp: "100.64.0.1",
    },
    {
      label: "falls back to loopback when local bind is auto without tailnet IP",
      tailnetIp: undefined,
    },
  ])("local auto-bind: $label", async ({ tailnetIp }) => {
    getRuntimeConfig.mockReturnValue({ gateway: { mode: "local", bind: "auto" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it.each([
    {
      label: "tailnet with TLS",
      gateway: { mode: "local", bind: "tailnet", tls: { enabled: true } },
      tailnetIp: "100.64.0.1",
      lanIp: undefined,
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "tailnet without TLS",
      gateway: { mode: "local", bind: "tailnet" },
      tailnetIp: "100.64.0.1",
      lanIp: undefined,
      expectedUrl: "ws://127.0.0.1:18800",
    },
    {
      label: "lan with TLS",
      gateway: { mode: "local", bind: "lan", tls: { enabled: true } },
      tailnetIp: undefined,
      lanIp: "192.168.1.42",
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "lan without TLS",
      gateway: { mode: "local", bind: "lan" },
      tailnetIp: undefined,
      lanIp: "192.168.1.42",
      expectedUrl: "ws://127.0.0.1:18800",
    },
    {
      label: "lan without discovered LAN IP",
      gateway: { mode: "local", bind: "lan" },
      tailnetIp: undefined,
      lanIp: undefined,
      expectedUrl: "ws://127.0.0.1:18800",
    },
  ])("uses loopback for $label", async ({ gateway, tailnetIp, lanIp, expectedUrl }) => {
    getRuntimeConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);
    pickPrimaryLanIPv4.mockReturnValue(lanIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe(expectedUrl);
  });

  it("uses url override in remote mode even when remote url is missing", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("wss://override.example/ws");
    expect(lastClientOptions?.token).toBe("explicit-token");
  });

  it("skips config loading when explicit url and token are provided", async () => {
    getRuntimeConfig.mockImplementation(() => {
      throw new Error("getRuntimeConfig should not run");
    });

    await callGatewayCli({
      method: "health",
      url: "ws://127.0.0.1:18800",
      token: "test-token",
    });

    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
    expect(lastClientOptions?.token).toBe("test-token");
  });

  it("keeps direct-local backend shared-token auth independent of paired device state", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "health",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("fails before opening a websocket when backend token auth has no shared or paired credential", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
    });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue(null);

    await expect(callGateway({ method: "sessions.list" })).rejects.toThrow(
      "requires credentials before opening a websocket",
    );

    expect(lastClientOptions).toBeNull();
    expect(startCalls).toBe(0);
    expect(loadDeviceAuthTokenMock).toHaveBeenCalledWith({
      deviceId: "test-device-identity",
      role: "operator",
      env: process.env,
    });
  });

  it("fails before opening a websocket when default token auth has no shared or paired credential", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback" },
    });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue(null);

    await expect(callGateway({ method: "sessions.list" })).rejects.toThrow(
      "requires credentials before opening a websocket",
    );

    expect(lastClientOptions).toBeNull();
    expect(startCalls).toBe(0);
  });

  it("allows paired backend device auth without explicit shared credentials", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
    });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "paired-device-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 123,
    });

    await callGateway({ method: "sessions.list" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("allows Tailscale-authenticated backend calls without client-side credentials", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://openclaw.example.test" },
        auth: { mode: "token", allowTailscale: true },
      },
    });
    setGatewayNetworkDefaults();

    await callGateway({ method: "sessions.list" });

    expect(lastClientOptions?.url).toBe("wss://openclaw.example.test");
    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("allows Tailscale Serve backend calls without explicit allowTailscale", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://openclaw.example.test" },
        auth: { mode: "token" },
        tailscale: { mode: "serve" },
      },
    });
    setGatewayNetworkDefaults();

    await callGateway({ method: "sessions.list" });

    expect(lastClientOptions?.url).toBe("wss://openclaw.example.test");
    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("omits device identity for explicit CLI loopback shared-token auth", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "health",
      token: "explicit-token",
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("keeps CLI device identity when an ambient token is inactive under auth mode none", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
    });
    setGatewayNetworkDefaults();
    process.env.OPENCLAW_GATEWAY_TOKEN = "inactive-env-token";

    await callGatewayCli({ method: "health" });

    expect(lastClientOptions?.token).toBe("inactive-env-token");
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    setLocalLoopbackGatewayConfig();
    deviceIdentityState.throwOnLoad = true;

    await callGateway({
      method: "health",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceIdentity).toBeNull();
    expect(lastRequestOptions?.method).toBe("health");
  });

  it("keeps backend device identity enabled for remote shared-token auth", async () => {
    getRuntimeConfig.mockReturnValue(makeRemotePasswordGatewayConfig("remote-password"));
    setGatewayNetworkDefaults();

    await callGateway({
      method: "health",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("wss://remote.example:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("honors an explicit null device identity override", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "health",
      token: "explicit-token",
      deviceIdentity: null,
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("uses OPENCLAW_GATEWAY_URL env override in remote mode when remote URL is missing", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.url).toBe("wss://gateway-in-container.internal:9443/ws");
    expect(lastClientOptions?.token).toBe("env-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("lets an explicit local port override bypass gateway env URL and port", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback" },
    });
    resolveGatewayPort.mockImplementation((_config?: unknown, env?: unknown) => {
      const candidateEnv = env as NodeJS.ProcessEnv | undefined;
      return Number(candidateEnv?.OPENCLAW_GATEWAY_PORT ?? 18789);
    });
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_PORT = "19001";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
      token: "explicit-token",
      localPortOverride: 19082,
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:19082");
    expect(lastClientOptions?.token).toBe("explicit-token");
  });

  it("uses env URL override credentials without resolving local password SecretRefs", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.url).toBe("wss://gateway-in-container.internal:9443/ws");
    expect(lastClientOptions?.token).toBe("env-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("uses remote tlsFingerprint with env URL override", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example:9443/ws",
          tlsFingerprint: "remote-fingerprint",
        },
      },
    });
    setGatewayNetworkDefaults(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.tlsFingerprint).toBe("remote-fingerprint");
  });

  it("does not apply remote tlsFingerprint for CLI url override", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example:9443/ws",
          tlsFingerprint: "remote-fingerprint",
        },
      },
    });
    setGatewayNetworkDefaults(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      url: "wss://override.example:9443/ws",
      token: "explicit-token",
    });

    expect(lastClientOptions?.tlsFingerprint).toBeUndefined();
  });

  it.each([
    {
      label: "uses least-privilege scopes by default for non-CLI callers",
      call: () => callGateway({ method: "health" }),
      expectedScopes: ["operator.read"],
    },
    {
      label: "uses least-privilege scopes by default for explicit CLI callers",
      call: () => callGatewayCli({ method: "health" }),
      expectedScopes: ["operator.read"],
    },
  ])("scope selection: $label", async ({ call, expectedScopes }) => {
    setLocalLoopbackGatewayConfig();
    await call();
    expect(lastClientOptions?.scopes).toEqual(expectedScopes);
  });

  it("keeps legacy broad scopes for unclassified explicit CLI methods", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayCli({ method: "plugin.custom.unclassified" });

    expect(lastClientOptions?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("falls back to broad operator scopes for unresolved plugin session actions", async () => {
    setLocalLoopbackGatewayConfig();
    setActivePluginRegistry(createEmptyPluginRegistry());

    await callGatewayCli({
      method: "plugins.sessionAction",
      params: {
        pluginId: "remote-plugin",
        actionId: "approve",
      },
    });

    expect(lastClientOptions?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("passes explicit scopes through, including empty arrays", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "health", scopes: ["operator.read"] });
    expect(lastClientOptions?.scopes).toEqual(["operator.read"]);

    await callGateway({ method: "health", scopes: [] });
    expect(lastClientOptions?.scopes).toStrictEqual([]);
  });

  it("reuses stored device auth without requesting stronger scopes", async () => {
    setLocalLoopbackGatewayConfig();
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "paired-device-token",
      role: "operator",
      scopes: ["operator.read", "operator.pairing"],
      updatedAtMs: 123,
    });

    await callGatewayCli({ method: "node.list", useStoredDeviceAuth: true });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
    expect(lastClientOptions?.scopes).toBeUndefined();
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("does not replace explicit credentials with stored device auth", async () => {
    setLocalLoopbackGatewayConfig();

    await expect(
      callGatewayCli({
        method: "node.list",
        token: "explicit-token",
        useStoredDeviceAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayStoredDeviceAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("prefers stored device auth over configured local credentials", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "configured-token" },
      },
    });
    setGatewayNetworkDefaults();

    await callGatewayCli({ method: "node.list", useStoredDeviceAuth: true });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.scopes).toBeUndefined();
  });

  it("does not resolve configured local SecretRefs when using stored device auth", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);
    setGatewayNetworkDefaults();

    await callGatewayCli({ method: "node.list", useStoredDeviceAuth: true });

    expect(lastClientOptions?.password).toBeUndefined();
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("rejects stored device auth that lacks caller-required scopes", async () => {
    setLocalLoopbackGatewayConfig();
    loadDeviceAuthTokenMock.mockReturnValue({
      token: "paired-device-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 123,
    });

    await expect(
      callGatewayCli({
        method: "node.list",
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
      }),
    ).rejects.toMatchObject({ name: "GatewayStoredDeviceAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("does not send stored device auth to configured remote gateways", async () => {
    getRuntimeConfig.mockReturnValue(makeRemotePasswordGatewayConfig("remote-password"));
    setGatewayNetworkDefaults();

    await expect(
      callGatewayCli({ method: "node.list", useStoredDeviceAuth: true }),
    ).rejects.toMatchObject({ name: "GatewayStoredDeviceAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("fails before connecting when stored device auth is unavailable", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
    });
    setGatewayNetworkDefaults();
    loadDeviceAuthTokenMock.mockReturnValue(null);

    await expect(
      callGatewayCli({ method: "node.list", useStoredDeviceAuth: true }),
    ).rejects.toThrow("requires credentials before opening a websocket");

    expect(lastClientOptions).toBeNull();
    expect(startCalls).toBe(0);
  });

  it("uses local backend shared auth without a device identity when required", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "node.list",
      token: "explicit-token",
      scopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
    });

    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("uses local backend auth-none without a device identity when required", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
    });
    setGatewayNetworkDefaults();

    await callGateway({
      method: "node.list",
      scopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
    });

    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("rejects required local backend shared auth for remote targets", async () => {
    await expect(
      callGateway({
        method: "node.list",
        url: "wss://remote.example.test",
        token: "explicit-token",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("rejects required local backend shared auth for loopback URL overrides", async () => {
    await expect(
      callGateway({
        method: "node.list",
        url: "ws://127.0.0.1:18789",
        token: "explicit-token",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("rejects required local backend shared auth for remote-mode loopback tunnels", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://127.0.0.1:18789",
          token: "remote-token",
        },
      },
    });
    setGatewayNetworkDefaults();

    await expect(
      callGateway({
        method: "node.list",
        scopes: ["operator.read", "operator.pairing"],
        requireLocalBackendSharedAuth: true,
      }),
    ).rejects.toMatchObject({ name: "GatewayLocalBackendSharedAuthUnavailableError" });

    expect(lastClientOptions).toBeNull();
  });

  it("uses backend client metadata for explicit scoped default calls", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "sessions.delete",
      scopes: ["operator.admin"],
      token: "explicit-token",
    });

    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastClientOptions?.clientDisplayName).toBe("gateway:sessions.delete");
    expect(lastClientOptions?.scopes).toEqual(["operator.admin"]);
    expect(lastClientOptions?.deviceIdentity).toBeNull();
  });

  it("labels default backend calls with the requested method", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "sessions.delete" });

    expect(lastClientOptions?.clientDisplayName).toBe("gateway:sessions.delete");
  });

  it("sends internal agent handoffs as backend gateway calls", async () => {
    setLocalLoopbackGatewayConfig();
    helloMethods = ["agent"];

    await callGateway({
      method: "agent",
      params: {
        message: "resume",
        sessionEffects: "internal",
        suppressPromptPersistence: true,
      },
    });

    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT);
    expect(lastClientOptions?.mode).toBe(GATEWAY_CLIENT_MODES.BACKEND);
    expect(lastRequestOptions?.method).toBe("agent");
    expect(lastRequestOptions?.params).toMatchObject({
      sessionEffects: "internal",
      suppressPromptPersistence: true,
    });
  });

  it("passes approval runtime tokens to backend gateway clients", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "exec.approval.waitDecision",
      scopes: ["operator.approvals"],
      approvalRuntimeToken: "runtime-token",
    });

    expect(lastClientOptions?.approvalRuntimeToken).toBe("runtime-token");
  });

  it("does not synthesize display names for CLI calls", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayCli({ method: "health" });

    expect(lastClientOptions?.clientDisplayName).toBeUndefined();
  });

  it("waits for event-loop readiness before starting CLI pairing requests", async () => {
    setLocalLoopbackGatewayConfig();

    let resolveReady:
      | ((result: {
          ready: boolean;
          elapsedMs: number;
          maxDriftMs: number;
          checks: number;
          aborted: boolean;
        }) => void)
      | undefined;
    eventLoopReadyState.promise = new Promise((resolve) => {
      resolveReady = resolve;
    });

    const promise = callGateway({
      method: "device.pair.list",
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
    });

    await vi.waitFor(() => {
      expect(eventLoopReadyState.calls).toHaveLength(1);
    });
    expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(10_000);
    expect(lastClientOptions?.clientName).toBe(GATEWAY_CLIENT_NAMES.CLI);
    expect(startCalls).toBe(0);

    if (!resolveReady) {
      throw new Error("Expected gateway event-loop readiness resolver to be initialized");
    }
    resolveReady({ ready: true, elapsedMs: 0, maxDriftMs: 0, checks: 2, aborted: false });
    await promise;

    expect(startCalls).toBe(1);
  });
});

describe("buildGatewayConnectionDetails", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  it("uses explicit url overrides and omits bind details", () => {
    setLocalLoopbackGatewayConfig(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    const details = buildGatewayConnectionDetails({
      url: "wss://example.com/ws",
    });

    expect(details.url).toBe("wss://example.com/ws");
    expect(details.urlSource).toBe("cli --url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
    expect(details.message).toContain("Gateway target: wss://example.com/ws");
    expect(details.message).toContain("Source: cli --url");
  });

  it("reuses gateway call TLS resolution for local probe connection details", async () => {
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        tls: { enabled: true },
        handshakeTimeoutMs: 4321,
      },
    } satisfies OpenClawConfig;
    resolveGatewayPort.mockReturnValue(18800);
    testing.setDepsForTests({
      getRuntimeConfig: () => config,
      resolveGatewayPort: () => 18800,
      loadGatewayTlsRuntime: async () => ({
        enabled: true,
        fingerprintSha256: "sha256:test-local-gateway-fingerprint",
        required: true,
      }),
    });

    const details = await buildGatewayProbeConnectionDetails({ config });

    expect(details.url).toBe("wss://127.0.0.1:18800");
    expect(details.tlsFingerprint).toBe("sha256:test-local-gateway-fingerprint");
    expect(details.preauthHandshakeTimeoutMs).toBe(4321);
  });

  it("lets probe details local port override bypass gateway env URL and port", async () => {
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
      },
    } satisfies OpenClawConfig;
    resolveGatewayPort.mockImplementation((_config?: unknown, env?: unknown) => {
      const candidateEnv = env as NodeJS.ProcessEnv | undefined;
      return Number(candidateEnv?.OPENCLAW_GATEWAY_PORT ?? 18789);
    });
    testing.setDepsForTests({
      getRuntimeConfig: () => config,
      resolveGatewayPort: (_config?: unknown, env?: NodeJS.ProcessEnv) =>
        Number(env?.OPENCLAW_GATEWAY_PORT ?? 18789),
    });
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    const prevPort = process.env.OPENCLAW_GATEWAY_PORT;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://env-gateway.example/ws";
      process.env.OPENCLAW_GATEWAY_PORT = "19001";

      const details = await buildGatewayProbeConnectionDetails({
        config,
        localPortOverride: 19082,
      });

      expect(details.url).toBe("ws://127.0.0.1:19082");
      expect(details.urlSource).toBe("local loopback");
    } finally {
      if (prevUrl === undefined) {
        delete process.env.OPENCLAW_GATEWAY_URL;
      } else {
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
      }
      if (prevPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = prevPort;
      }
    }
  });

  it("lets a bound remote call keep its config URL over the gateway env override", async () => {
    const config = {
      gateway: {
        mode: "remote",
        remote: { url: "wss://selected-gateway.example/ws" },
      },
    } satisfies OpenClawConfig;
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://unrelated-gateway.example/ws";

      const details = await buildGatewayProbeConnectionDetails({
        config,
        ignoreEnvUrlOverride: true,
      });

      expect(details.url).toBe("wss://selected-gateway.example/ws");
      expect(details.urlSource).toBe("config gateway.remote.url");
    } finally {
      if (prevUrl === undefined) {
        delete process.env.OPENCLAW_GATEWAY_URL;
      } else {
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
      }
    }
  });

  it("redacts credential-bearing target URLs from connection messages", () => {
    setLocalLoopbackGatewayConfig(18800);

    const details = buildGatewayConnectionDetails({
      url: "wss://user:pass@example.com/ws?token=secret-token&keep=visible",
    });

    expect(details.url).toBe("wss://user:pass@example.com/ws?token=secret-token&keep=visible");
    expect(details.message).toContain(
      "Gateway target: wss://***:***@example.com/ws?token=***&keep=visible",
    );
    expect(details.message).not.toContain("user:pass");
    expect(details.message).not.toContain("secret-token");
  });

  it("emits a remote fallback note when remote url is missing", () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
    expect(details.urlSource).toBe("missing gateway.remote.url (fallback local)");
    expect(details.bindDetail).toBe("Bind: loopback");
    expect(details.remoteFallbackNote).toContain(
      "gateway.mode=remote but gateway.remote.url is missing",
    );
    expect(details.message).toContain("Gateway target: ws://127.0.0.1:18789");
  });

  it.each([
    {
      label: "with TLS",
      gateway: { mode: "local", bind: "lan", tls: { enabled: true } },
      expectedUrl: "wss://127.0.0.1:18800",
    },
    {
      label: "without TLS",
      gateway: { mode: "local", bind: "lan" },
      expectedUrl: "ws://127.0.0.1:18800",
    },
  ])("uses loopback URL for bind=lan $label", ({ gateway, expectedUrl }) => {
    getRuntimeConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe(expectedUrl);
    expect(details.urlSource).toBe("local loopback");
    expect(details.bindDetail).toBe("Bind: lan");
  });

  it("prefers remote url when configured", () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "tailnet",
        remote: { url: "wss://remote.example.com/ws" },
      },
    });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.9");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("wss://remote.example.com/ws");
    expect(details.urlSource).toBe("config gateway.remote.url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
  });

  it("uses env OPENCLAW_GATEWAY_URL when set", () => {
    getRuntimeConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://browser-gateway.local:9443/ws";

      const details = buildGatewayConnectionDetails();

      expect(details.url).toBe("wss://browser-gateway.local:9443/ws");
      expect(details.urlSource).toBe("env OPENCLAW_GATEWAY_URL");
      expect(details.bindDetail).toBeUndefined();
    } finally {
      if (prevUrl === undefined) {
        delete process.env.OPENCLAW_GATEWAY_URL;
      } else {
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
      }
    }
  });

  it("lets a local port override bypass gateway env URL and port in connection details", () => {
    getRuntimeConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
    resolveGatewayPort.mockImplementation((_config?: unknown, env?: unknown) => {
      const candidateEnv = env as NodeJS.ProcessEnv | undefined;
      return Number(candidateEnv?.OPENCLAW_GATEWAY_PORT ?? 18789);
    });
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    const prevPort = process.env.OPENCLAW_GATEWAY_PORT;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://browser-gateway.local:9443/ws";
      process.env.OPENCLAW_GATEWAY_PORT = "19001";

      const details = buildGatewayConnectionDetails({ localPortOverride: 19082 });

      expect(details.url).toBe("ws://127.0.0.1:19082");
      expect(details.urlSource).toBe("local loopback");
      expect(details.bindDetail).toBe("Bind: loopback");
    } finally {
      if (prevUrl === undefined) {
        delete process.env.OPENCLAW_GATEWAY_URL;
      } else {
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
      }
      if (prevPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = prevPort;
      }
    }
  });

  it("falls back to the default config loader when test deps drift", () => {
    const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-call-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(tempStateDir, "missing-config.json"));
    try {
      getRuntimeConfig.mockReturnValue({ gateway: { mode: "local", bind: "loopback" } });
      resolveGatewayPort.mockReturnValue(18800);
      testing.setDepsForTests({
        getRuntimeConfig: {} as never,
        resolveGatewayPort: () => 18789,
      });

      const details = buildGatewayConnectionDetails();

      expect(details.url).toBe("ws://127.0.0.1:18789");
      expect(details.urlSource).toBe("local loopback");
    } finally {
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    }
  });

  it("throws for insecure ws:// remote URLs (CWE-319)", () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: { url: "ws://remote.example.com:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    let thrown: unknown;
    try {
      buildGatewayConnectionDetails();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("SECURITY ERROR");
    expect((thrown as Error).message).toContain("plaintext ws://");
    expect((thrown as Error).message).toContain("wss://");
    expect((thrown as Error).message).toContain("Tailscale Serve/Funnel");
    expect((thrown as Error).message).toContain("openclaw doctor --fix");
  });

  it("redacts credential-bearing target URLs from insecure ws:// errors", () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: { url: "ws://user:pass@remote.example.com:18789/ws?token=secret-token" },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);

    expect(() => buildGatewayConnectionDetails()).toThrow(
      'Gateway URL "ws://***:***@remote.example.com:18789/ws?token=***" uses plaintext',
    );
    try {
      buildGatewayConnectionDetails();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("user:pass");
      expect((error as Error).message).not.toContain("secret-token");
    }
  });

  it("allows ws:// private remote URLs for trusted LAN and Tailnet configs", () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: { url: "ws://10.0.0.8:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://10.0.0.8:18789");
    expect(details.urlSource).toBe("config gateway.remote.url");
  });

  it("allows ws:// hostname remote URLs when OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        remote: { url: "ws://openclaw-gateway.ai:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18789);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://openclaw-gateway.ai:18789");
    expect(details.urlSource).toBe("config gateway.remote.url");
  });

  it("allows ws:// for loopback addresses in local mode", () => {
    setLocalLoopbackGatewayConfig();

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
  });
});

describe("callGateway error details", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes connection details when the gateway closes", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    setLocalLoopbackGatewayConfig();

    let err: Error | null = null;
    try {
      await callGateway({ method: "health" });
    } catch (caught) {
      err = caught as Error;
    }

    expect(err?.message).toContain("gateway closed (1006");
    expect(err?.message).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(err?.message).toContain("Source: local loopback");
    expect(err?.message).toContain("Bind: loopback");
    expect(isGatewayTransportError(err)).toBe(true);
    const transportError = err as {
      name?: string;
      kind?: string;
      code?: number;
      reason?: string;
    };
    expect(transportError.name).toBe("GatewayTransportError");
    expect(transportError.kind).toBe("closed");
    expect(transportError.code).toBe(1006);
    expect(transportError.reason).toBe("no close reason");
  });

  it("keeps the request alive through internally retried startup-unavailable handshakes", async () => {
    startMode = "startup-retry-then-hello";
    setLocalLoopbackGatewayConfig();

    await expect(callGateway({ method: "health" })).resolves.toEqual({ ok: true });

    expect(lastRequestOptions?.method).toBe("health");
  });

  it("keeps the request alive through one transient pre-hello clean close", async () => {
    startMode = "clean-prehello-close-then-hello";
    setLocalLoopbackGatewayConfig();

    await expect(callGateway({ method: "health" })).resolves.toEqual({ ok: true });

    expect(lastRequestOptions?.method).toBe("health");
  });

  it("surfaces repeated transient pre-hello clean closes", async () => {
    startMode = "repeated-clean-prehello-close";
    setLocalLoopbackGatewayConfig();

    let err: Error | null = null;
    try {
      await callGateway({ method: "health" });
    } catch (caught) {
      err = caught as Error;
    }

    expect(err?.message).toContain("gateway closed (1000 normal closure): no close reason");
    expect(lastRequestOptions).toBeNull();
  });

  it("rejects immediately when the client reports a connect error", async () => {
    startMode = "connect-error";
    setLocalLoopbackGatewayConfig();

    let err: unknown;
    await callGateway({ method: "health", timeoutMs: 10_000 }).catch((caught: unknown) => {
      err = caught;
    });

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("device private key invalid");
    expect(lastRequestOptions).toBeNull();
  });

  it("surfaces agent runtime identity connect request errors", async () => {
    startMode = "connect-error";
    connectError = new Error(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );
    setLocalLoopbackGatewayConfig();

    await expect(
      callGateway({
        method: "cron.remove",
        token: "explicit-token",
        agentRuntimeIdentityToken: "identity-token",
      }),
    ).rejects.toThrow(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );

    expect(lastClientOptions?.agentRuntimeIdentityToken).toBe("identity-token");
    expect(lastRequestOptions).toBeNull();
  });

  it("surfaces stored device auth handshake failures for credential fallback", async () => {
    startMode = "connect-error";
    connectError = Object.assign(new Error("unauthorized: device token mismatch"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    });
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    const promise = callGatewayCli({
      method: "node.list",
      timeoutMs: 5,
      useStoredDeviceAuth: true,
    });
    const rejection = expect(promise).rejects.toMatchObject({
      name: "GatewayClientRequestError",
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
    });
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
  });

  it("includes connection details on timeout", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(errMessage).toContain("gateway timeout after 5ms");
    expect(errMessage).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(errMessage).toContain("Source: local loopback");
    expect(errMessage).toContain("Bind: loopback");
  });

  it("marks wrapper timeouts as typed gateway transport errors", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let err: unknown;
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      err = caught;
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(isGatewayTransportError(err)).toBe(true);
    const transportError = err as { name?: string; kind?: string; timeoutMs?: number };
    expect(transportError.name).toBe("GatewayTransportError");
    expect(transportError.kind).toBe("timeout");
    expect(transportError.timeoutMs).toBe(5);
  });

  it("formats typed transport errors for CLI JSON output", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    setLocalLoopbackGatewayConfig();

    let err: unknown;
    await callGateway({ method: "health" }).catch((caught: unknown) => {
      err = caught;
    });

    expect(formatGatewayTransportErrorJson(err)).toEqual({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        code: 1006,
        reason: "no close reason",
      },
      gateway: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        bindDetail: "Bind: loopback",
      },
    });
  });

  it("does not over-claim a gateway crash on a 1006 abnormal close", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    setLocalLoopbackGatewayConfig();

    let err: unknown;
    await callGateway({ method: "health" }).catch((caught: unknown) => {
      err = caught;
    });

    const message = (err as { message: string }).message;
    expect(message).toContain(
      "Connection dropped without a close frame (retry; check network and gateway load)",
    );
    expect(message).not.toContain("crashed or was terminated unexpectedly");
    expect(message).toContain("Run `openclaw doctor`");
  });

  it("formats typed request errors for CLI JSON output", () => {
    const error = Object.assign(new Error("unauthorized role: operator"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      details: { method: "skills.bins" },
      retryable: false,
      retryAfterMs: 250,
    });

    expect(formatGatewayClientRequestErrorJson(error)).toEqual({
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "INVALID_REQUEST",
        message: "unauthorized role: operator",
        details: { method: "skills.bins" },
        retryable: false,
        retryAfterMs: 250,
      },
    });
    expect(
      formatGatewayClientRequestErrorJson(
        Object.assign(new Error("unauthorized role: operator"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          retryable: "no",
        }),
      ),
    ).toBeNull();
    expect(
      formatGatewayClientRequestErrorJson(
        Object.assign(new Error("unauthorized role: operator"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          retryable: false,
          retryAfterMs: -1,
        }),
      ),
    ).toBeNull();
  });

  it("charges event-loop readiness against the wrapper timeout", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();
    eventLoopReadyState.promise = new Promise(() => {});

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.waitFor(() => {
      expect(eventLoopReadyState.calls).toHaveLength(1);
    });
    expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(5);
    expect(startCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(startCalls).toBe(0);
    expect(errMessage).toContain("gateway timeout after 5ms");
  });

  it("fails before connecting when event-loop readiness consumes the wrapper timeout", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();
    eventLoopReadyState.result = {
      ready: false,
      elapsedMs: 5,
      maxDriftMs: 400,
      checks: 1,
      aborted: false,
    };

    let err: unknown;
    await callGateway({ method: "health", timeoutMs: 5 }).catch((caught: unknown) => {
      err = caught;
    });
    expect(isGatewayTransportError(err)).toBe(true);
    const transportError = err as { name?: string; kind?: string; timeoutMs?: number };
    expect(transportError.name).toBe("GatewayTransportError");
    expect(transportError.kind).toBe("timeout");
    expect(transportError.timeoutMs).toBe(5);
    expect(eventLoopReadyState.calls).toHaveLength(1);
    expect(eventLoopReadyState.calls[0]?.maxWaitMs).toBe(5);
    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(startCalls).toBe(0);
  });

  it("keeps the default wrapper timeout aligned with configured handshake timeout", async () => {
    startMode = "silent";
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", handshakeTimeoutMs: 30_000 },
    });
    setGatewayNetworkDefaults();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health" }).catch((caught: unknown) => {
      errMessage = caught instanceof Error ? caught.message : String(caught);
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(errMessage).toBe("");
    await vi.advanceTimersByTimeAsync(20_000);
    await promise;

    expect(errMessage).toContain("gateway timeout after 30000ms");
  });

  it("keeps the default wrapper timeout aligned with env handshake timeout", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_HANDSHAKE_TIMEOUT_MS"]);
    try {
      process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "30000";
      startMode = "silent";
      setLocalLoopbackGatewayConfig();

      vi.useFakeTimers();
      let errMessage = "";
      const promise = callGateway({ method: "health" }).catch((caught: unknown) => {
        errMessage = caught instanceof Error ? caught.message : String(caught);
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(errMessage).toBe("");
      await vi.advanceTimersByTimeAsync(20_000);
      await promise;

      expect(errMessage).toContain("gateway timeout after 30000ms");
    } finally {
      envSnapshot.restore();
    }
  });

  it("does not overflow very large timeout values", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 2_592_010_000 }).catch(
      (caught: unknown) => {
        errMessage = caught instanceof Error ? caught.message : String(caught);
      },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(errMessage).toBe("");

    lastClientOptions?.onClose?.(1006, "");
    await promise;

    expect(errMessage).toContain("gateway closed (1006");
  });

  it("forwards caller timeout to client requests", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "health", timeoutMs: 45_000 });

    expect(lastRequestOptions?.method).toBe("health");
    expect(lastRequestOptions?.opts?.timeoutMs).toBe(45_000);
  });

  it("keeps the startup deadline when the request timeout is disabled", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();
    vi.useFakeTimers();
    let err: unknown;

    const promise = callGateway({ method: "health", timeoutMs: null }).catch((caught: unknown) => {
      err = caught;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(isGatewayTransportError(err)).toBe(true);
    expect(err).toMatchObject({ kind: "timeout", timeoutMs: 10_000 });
    expect(lastRequestOptions).toBeNull();
  });

  it("disables the request and wrapper deadline when timeout is null", async () => {
    setLocalLoopbackGatewayConfig();
    vi.useFakeTimers();
    let releaseRequest: (() => void) | undefined;

    testing.setDepsForTests({
      createGatewayClient: (opts) =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: { expectFinal?: boolean; timeoutMs?: number | null },
          ) {
            lastRequestOptions = { method, params, opts: requestOpts };
            await new Promise<void>((resolve) => {
              releaseRequest = resolve;
            });
            return { ok: true };
          },
          start() {
            opts.onHelloOk?.({
              features: {
                methods: helloMethods ?? [],
                events: [],
              },
            } as unknown as Parameters<NonNullable<typeof opts.onHelloOk>>[0]);
          },
          stop() {},
          async stopAndWait() {},
        }) as never,
      getRuntimeConfig: getRuntimeConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      loadDeviceAuthToken: loadDeviceAuthTokenMock,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    let settled = false;
    const promise = callGateway({ method: "health", timeoutMs: null }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(lastRequestOptions?.opts?.timeoutMs).toBeNull();
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    if (!releaseRequest) {
      throw new Error("Expected request release callback to be initialized");
    }
    releaseRequest();
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("forwards caller abort signal and accepted callback to client requests", async () => {
    setLocalLoopbackGatewayConfig();
    const controller = new AbortController();
    const onAccepted = vi.fn();

    await callGateway({
      method: "agent",
      expectFinal: true,
      signal: controller.signal,
      onAccepted,
    });

    expect(lastRequestOptions?.method).toBe("agent");
    expect(lastRequestOptions?.opts?.signal).toBe(controller.signal);
    expect(lastRequestOptions?.opts?.onAccepted).toBe(onAccepted);
  });

  it("runs the signal abort hook on the active gateway connection before teardown", async () => {
    setLocalLoopbackGatewayConfig();

    const controller = new AbortController();
    const abortRequests: Array<{
      method: string;
      params: unknown;
      opts?: { timeoutMs?: number | null };
    }> = [];
    let stopStarted = false;

    testing.setDepsForTests({
      createGatewayClient: (opts) =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: {
              expectFinal?: boolean;
              timeoutMs?: number | null;
              signal?: AbortSignal;
            },
          ) {
            lastRequestOptions = { method, params, opts: requestOpts };
            if (method === "agent") {
              return await new Promise((_, reject) => {
                requestOpts?.signal?.addEventListener(
                  "abort",
                  () => {
                    const err = new Error("gateway request aborted for agent");
                    err.name = "AbortError";
                    reject(err);
                  },
                  { once: true },
                );
              });
            }
            abortRequests.push({ method, params, opts: requestOpts });
            return { ok: true };
          },
          start() {
            opts.onHelloOk?.({
              features: {
                methods: helloMethods ?? [],
                events: [],
              },
            } as unknown as Parameters<NonNullable<typeof opts.onHelloOk>>[0]);
          },
          stop() {},
          async stopAndWait() {
            stopStarted = true;
          },
        }) as never,
      getRuntimeConfig: getRuntimeConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      loadDeviceAuthToken: loadDeviceAuthTokenMock,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    const promise = callGateway({
      method: "agent",
      expectFinal: true,
      signal: controller.signal,
      onSignalAbort: async (request) => {
        await request("chat.abort", { sessionKey: "main", runId: "run-1" }, { timeoutMs: 5_000 });
      },
    });

    await vi.waitFor(() => {
      expect(lastRequestOptions?.method).toBe("agent");
    });
    controller.abort();

    await expect(promise).rejects.toThrow("gateway request aborted for agent");
    expect(abortRequests).toEqual([
      {
        method: "chat.abort",
        params: { sessionKey: "main", runId: "run-1" },
        opts: { timeoutMs: 5_000 },
      },
    ]);
    expect(stopStarted).toBe(true);
  });

  it("skips the signal abort hook before the primary request starts", async () => {
    setLocalLoopbackGatewayConfig();

    const controller = new AbortController();
    const onSignalAbort = vi.fn(async () => undefined);
    let startCalled = false;
    let stopStarted = false;

    testing.setDepsForTests({
      createGatewayClient: () =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: {
              expectFinal?: boolean;
              timeoutMs?: number | null;
              signal?: AbortSignal;
            },
          ) {
            lastRequestOptions = { method, params, opts: requestOpts };
            return { ok: true };
          },
          start() {
            startCalled = true;
          },
          stop() {},
          async stopAndWait() {
            stopStarted = true;
          },
        }) as never,
      getRuntimeConfig: getRuntimeConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      loadDeviceAuthToken: loadDeviceAuthTokenMock,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    const promise = callGateway({
      method: "agent",
      expectFinal: true,
      signal: controller.signal,
      onSignalAbort,
    });

    await vi.waitFor(() => {
      expect(startCalled).toBe(true);
    });
    controller.abort();

    await expect(promise).rejects.toThrow("gateway request aborted for agent");
    expect(onSignalAbort).not.toHaveBeenCalled();
    expect(lastRequestOptions).toBeNull();
    expect(stopStarted).toBe(true);
  });

  it("passes configured gateway handshake timeout to the client watchdog", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "local", bind: "loopback", handshakeTimeoutMs: 30_000 },
    });
    setGatewayNetworkDefaults();

    await callGateway({ method: "health" });

    expect(lastClientOptions?.preauthHandshakeTimeoutMs).toBe(30_000);
  });

  it("does not inject wrapper timeout defaults into expectFinal requests", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "health", expectFinal: true });

    expect(lastRequestOptions?.method).toBe("health");
    expect(lastRequestOptions?.opts?.expectFinal).toBe(true);
    expect(lastRequestOptions?.opts?.timeoutMs).toBeUndefined();
  });

  it("waits for gateway client teardown before resolving", async () => {
    setLocalLoopbackGatewayConfig();

    let releaseStop: (() => void) | undefined;
    let stopStarted = false;
    let stopFinished = false;
    let callResolved = false;

    testing.setDepsForTests({
      createGatewayClient: (opts) =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: { expectFinal?: boolean; timeoutMs?: number | null },
          ) {
            lastRequestOptions = { method, params, opts: requestOpts };
            return { ok: true };
          },
          start() {
            opts.onHelloOk?.({
              features: {
                methods: helloMethods ?? [],
                events: [],
              },
            } as unknown as Parameters<NonNullable<typeof opts.onHelloOk>>[0]);
          },
          stop() {},
          async stopAndWait() {
            stopStarted = true;
            await new Promise<void>((resolve) => {
              releaseStop = () => {
                stopFinished = true;
                resolve();
              };
            });
          },
        }) as never,
      getRuntimeConfig: getRuntimeConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      loadDeviceAuthToken: loadDeviceAuthTokenMock,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    const promise = callGateway({ method: "health" }).then(() => {
      callResolved = true;
    });

    await vi.waitFor(() => {
      expect(stopStarted).toBe(true);
    });
    expect(callResolved).toBe(false);

    if (!releaseStop) {
      throw new Error("Expected gateway stop release callback to be initialized");
    }
    releaseStop();
    await promise;

    expect(stopFinished).toBe(true);
    expect(callResolved).toBe(true);
  });

  it("clears the wrapper timeout before awaiting gateway teardown", async () => {
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let releaseStop: (() => void) | undefined;
    let stopStarted = false;

    testing.setDepsForTests({
      createGatewayClient: (opts) =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: { expectFinal?: boolean; timeoutMs?: number | null },
          ) {
            lastRequestOptions = { method, params, opts: requestOpts };
            return { ok: true };
          },
          start() {
            opts.onHelloOk?.({
              features: {
                methods: helloMethods ?? [],
                events: [],
              },
            } as unknown as Parameters<NonNullable<typeof opts.onHelloOk>>[0]);
          },
          stop() {},
          async stopAndWait() {
            stopStarted = true;
            await new Promise<void>((resolve) => {
              releaseStop = resolve;
            });
          },
        }) as never,
      getRuntimeConfig: getRuntimeConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      loadDeviceAuthToken: loadDeviceAuthTokenMock,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    const promise = callGateway<{ ok: true }>({ method: "health", timeoutMs: 5 });

    await vi.waitFor(() => {
      expect(stopStarted).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(5);

    if (!releaseStop) {
      throw new Error("Expected gateway stop release callback to be initialized");
    }
    releaseStop();

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("fails fast when remote mode is missing remote url", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", bind: "loopback", remote: {} },
    });
    await expect(
      callGateway({
        method: "health",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("gateway remote mode misconfigured");
  });

  it("fails before request when a required gateway method is missing", async () => {
    setLocalLoopbackGatewayConfig();
    helloMethods = ["health"];
    await expect(
      callGateway({
        method: "secrets.resolve",
        requiredMethods: ["secrets.resolve"],
      }),
    ).rejects.toThrow(/does not support required method "secrets\.resolve"/i);
  });
});

describe("callGateway url override auth requirements", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_URL",
    ]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_URL;
    setGatewayNetworkDefaults(18789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("throws when url override is set without explicit credentials", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "local-token", password: "local-password" },
      },
    });

    await expect(
      callGateway({ method: "health", url: "wss://override.example/ws" }),
    ).rejects.toThrow(/remove --url to use the configured target/i);
  });

  it("throws when env URL override is set without env credentials", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://override.example/ws";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth: { token: "local-token", password: "local-password" },
      },
    });

    await expect(callGateway({ method: "health" })).rejects.toThrow(
      /OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD/i,
    );
  });
});

describe("callGateway password resolution", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const explicitAuthCases = [
    {
      label: "password",
      authKey: "password", // pragma: allowlist secret
      envKey: "OPENCLAW_GATEWAY_PASSWORD",
      envValue: "from-env",
      configValue: "from-config",
      explicitValue: "explicit-password",
    },
    {
      label: "token",
      authKey: "token", // pragma: allowlist secret
      envKey: "OPENCLAW_GATEWAY_TOKEN",
      envValue: "env-token",
      configValue: "local-token",
      explicitValue: "explicit-token",
    },
  ] as const;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_TOKEN",
      "LOCAL_REMOTE_FALLBACK_TOKEN",
      "LOCAL_REF_PASSWORD",
      "REMOTE_REF_TOKEN",
      "REMOTE_REF_PASSWORD",
    ]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.LOCAL_REMOTE_FALLBACK_TOKEN;
    delete process.env.LOCAL_REF_PASSWORD;
    delete process.env.REMOTE_REF_TOKEN;
    delete process.env.REMOTE_REF_PASSWORD;
    setGatewayNetworkDefaults(18789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([
    {
      label: "uses local config password when env is unset",
      envPassword: undefined,
      config: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { password: "secret" },
        },
      },
      expectedPassword: "secret",
    },
    {
      label: "prefers env password over local config password",
      envPassword: "from-env",
      config: {
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { password: "from-config" },
        },
      },
      expectedPassword: "from-env",
    },
    {
      label: "uses remote password in remote mode when env is unset",
      envPassword: undefined,
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      expectedPassword: "remote-secret",
    },
    {
      label: "prefers env password over remote password in remote mode",
      envPassword: "from-env",
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      expectedPassword: "from-env",
    },
  ])("$label", async ({ envPassword, config, expectedPassword }) => {
    if (envPassword !== undefined) {
      process.env.OPENCLAW_GATEWAY_PASSWORD = envPassword;
    }
    getRuntimeConfig.mockReturnValue(config);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe(expectedPassword);
  });

  it("resolves gateway.auth.password SecretInput refs for gateway calls", async () => {
    process.env.LOCAL_REF_PASSWORD = "resolved-local-ref-password"; // pragma: allowlist secret
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "LOCAL_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("resolved-local-ref-password");
  });

  it("does not resolve local password ref when env password takes precedence", async () => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("from-env");
  });

  it("does not resolve local password ref when token auth can win", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "token",
          token: "token-auth",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("token-auth");
  });

  it("resolves local password ref before unresolved local token ref can block auth", async () => {
    process.env.LOCAL_FALLBACK_PASSWORD = "resolved-local-fallback-password"; // pragma: allowlist secret
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          token: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_TOKEN" },
          password: { source: "env", provider: "default", id: "LOCAL_FALLBACK_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBe("resolved-local-fallback-password"); // pragma: allowlist secret
  });

  it("fails closed when unresolved local token SecretRef would otherwise fall back to remote token", async () => {
    process.env.LOCAL_REMOTE_FALLBACK_TOKEN = "resolved-local-remote-fallback-token";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_TOKEN" },
        },
        remote: {
          token: { source: "env", provider: "default", id: "LOCAL_REMOTE_FALLBACK_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await expect(callGateway({ method: "health" })).rejects.toThrow("gateway.auth.token");
  });

  it("ignores unresolved local password ref when auth mode is none", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "none",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("resolves local password refs when auth mode is trusted-proxy", async () => {
    process.env.LOCAL_TRUSTED_PROXY_PASSWORD = "resolved-trusted-proxy-password";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "LOCAL_TRUSTED_PROXY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBe("resolved-trusted-proxy-password"); // pragma: allowlist secret
  });

  it("fails closed when trusted-proxy local password ref cannot resolve", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await expect(callGateway({ method: "health" })).rejects.toThrow("gateway.auth.password");
  });

  it("does not resolve local password ref when remote password is already configured", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_LOCAL_REF_PASSWORD" },
        },
        remote: {
          url: "wss://remote.example:18789",
          password: "remote-secret",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("remote-secret");
  });

  it("resolves gateway.remote.token SecretInput refs when remote token is required", async () => {
    process.env.REMOTE_REF_TOKEN = "resolved-remote-ref-token";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {},
        remote: {
          url: "wss://remote.example:18789",
          token: { source: "env", provider: "default", id: "REMOTE_REF_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-remote-ref-token");
  });

  it("resolves gateway.remote.password SecretInput refs when remote password is required", async () => {
    process.env.REMOTE_REF_PASSWORD = "resolved-remote-ref-password"; // pragma: allowlist secret
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {},
        remote: {
          url: "wss://remote.example:18789",
          password: { source: "env", provider: "default", id: "REMOTE_REF_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("resolved-remote-ref-password");
  });

  it("does not resolve remote token ref when remote password already wins", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {},
        remote: {
          url: "wss://remote.example:18789",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          password: "remote-password", // pragma: allowlist secret
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBe("remote-password");
  });

  it("resolves remote token ref before unresolved remote password ref can block auth", async () => {
    process.env.REMOTE_REF_TOKEN = "resolved-remote-ref-token";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {},
        remote: {
          url: "wss://remote.example:18789",
          token: { source: "env", provider: "default", id: "REMOTE_REF_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-remote-ref-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("does not resolve remote password ref when remote token already wins", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        bind: "loopback",
        auth: {},
        remote: {
          url: "wss://remote.example:18789",
          token: "remote-token",
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("remote-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("resolves remote token refs on local-mode calls when fallback token can win", async () => {
    process.env.LOCAL_FALLBACK_REMOTE_TOKEN = "resolved-local-fallback-remote-token";
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: {},
        remote: {
          token: { source: "env", provider: "default", id: "LOCAL_FALLBACK_REMOTE_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-local-fallback-remote-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("does not resolve remote refs on non-remote gateway calls when auth mode is none", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "none" },
        remote: {
          url: "wss://remote.example:18789",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("does not resolve remote refs on non-remote gateway calls when auth mode is trusted-proxy", async () => {
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "trusted-proxy" },
        remote: {
          url: "wss://remote.example:18789",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it.each(explicitAuthCases)("uses explicit $label when url override is set", async (testCase) => {
    setTestEnvValue(testCase.envKey, testCase.envValue);
    const auth = { [testCase.authKey]: testCase.configValue } as {
      password?: string;
      token?: string;
    };
    getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "local",
        auth,
      },
    });

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      [testCase.authKey]: testCase.explicitValue,
    });

    expect(lastClientOptions?.[testCase.authKey]).toBe(testCase.explicitValue);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
