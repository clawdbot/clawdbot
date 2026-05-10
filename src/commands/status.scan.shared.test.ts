import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveGatewayProbeSnapshot,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
  resolveGatewayProbeTarget: vi.fn(),
  probeGateway: vi.fn(),
  callGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  pickGatewaySelfPresence: vi.fn(),
}));

type GatewayCall = {
  clientName?: string;
  config?: unknown;
  deviceIdentity?: unknown;
  method?: string;
  mode?: string;
  password?: string;
  timeoutMs?: number;
  token?: string;
};

type GatewayProbeCall = {
  auth?: unknown;
  detailLevel?: string;
  preauthHandshakeTimeoutMs?: number;
  timeoutMs?: number;
  url?: string;
};

type MemorySearchManagerCall = {
  agentId?: string;
  cfg: {
    plugins?: {
      slots?: unknown;
    };
  };
  purpose?: string;
};

function readGatewayCall(): GatewayCall {
  expect(mocks.callGateway).toHaveBeenCalledOnce();
  const calls = mocks.callGateway.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected gateway call");
  }
  return call as GatewayCall;
}

function readProbeCall(): GatewayProbeCall {
  expect(mocks.probeGateway).toHaveBeenCalledOnce();
  const calls = mocks.probeGateway.mock.calls as unknown as Array<[unknown]>;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected gateway probe call");
  }
  return call as GatewayProbeCall;
}

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetailsWithResolvers,
}));

vi.mock("../gateway/probe-target.js", () => ({
  resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("./gateway-presence.js", () => ({
  pickGatewaySelfPresence: mocks.pickGatewaySelfPresence,
}));

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:18789",
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: true,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: { token: "tok", password: "pw" },
      warning: "warn",
    });
    mocks.pickGatewaySelfPresence.mockReturnValue({ host: "box" });
    mocks.callGateway.mockRejectedValue(new Error("status rpc unavailable"));
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(mocks.resolveGatewayProbeAuthResolution).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result.gatewayConnection.url).toBe("ws://127.0.0.1:18789");
    expect(result.remoteUrlMissing).toBe(true);
    expect(result.gatewayMode).toBe("remote");
    expect(result.gatewayProbeAuth).toEqual({});
    expect(result.gatewayProbeAuthWarning).toBeUndefined();
    expect(result.gatewayProbe).toBeNull();
    expect(result.gatewayReachable).toBe(false);
    expect(result.gatewaySelf).toBeNull();
    expect(result.gatewayCallOverrides).toEqual({
      url: "ws://127.0.0.1:18789",
      token: undefined,
      password: undefined,
    });
  });

  it("can probe the local fallback when remote url is missing", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 12,
      error: null,
      close: null,
      health: {},
      status: {},
      presence: [{ host: "box" }],
      configSnapshot: null,
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {
        detailLevel: "full",
        probeWhenRemoteUrlMissing: true,
        resolveAuthWhenRemoteUrlMissing: true,
        mergeAuthWarningIntoProbeError: false,
      },
    });

    expect(mocks.resolveGatewayProbeAuthResolution).toHaveBeenCalled();
    const probeCall = readProbeCall();
    expect(probeCall.url).toBe("ws://127.0.0.1:18789");
    expect(probeCall.auth).toEqual({ token: "tok", password: "pw" });
    expect(probeCall.detailLevel).toBe("full");
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewaySelf).toEqual({ host: "box" });
    expect(result.gatewayCallOverrides).toEqual({
      url: "ws://127.0.0.1:18789",
      token: "tok",
      password: "pw",
    });
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("merges auth warnings into failed probe errors by default", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(result.gatewayProbe?.error).toBe("timeout; warn");
    expect(result.gatewayProbeAuthWarning).toBeUndefined();
  });

  it("treats scope-limited read probes as reachable", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      close: null,
      auth: {
        role: "operator",
        scopes: [],
        capability: "connected_no_operator_scope",
      },
      server: {
        version: null,
        connId: null,
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewayProbe?.error).toBe("missing scope: operator.read; warn");
  });

  it("uses a bounded local status RPC fallback when the detail probe times out", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {
        timeoutMs: 8000,
      },
    });

    const gatewayCall = readGatewayCall();
    expect(gatewayCall.config).toEqual({});
    expect(gatewayCall.method).toBe("status");
    expect(gatewayCall.token).toBe("tok");
    expect(gatewayCall.password).toBe("pw");
    expect(gatewayCall.timeoutMs).toBe(2000);
    expect(gatewayCall.mode).toBe("backend");
    expect(gatewayCall.clientName).toBe("gateway-client");
    expect(gatewayCall).not.toHaveProperty("deviceIdentity");
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewayProbe?.ok).toBe(true);
    expect(result.gatewayProbe?.error).toBe("timeout");
    expect(result.gatewayProbe?.status).toEqual({ sessions: 1 });
    expect(result.gatewayProbe?.auth?.capability).toBe("read_only");
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("keeps the local status RPC fallback timeout aligned with configured handshake timeout", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    await resolveGatewayProbeSnapshot({
      cfg: { gateway: { handshakeTimeoutMs: 30_000 } },
      opts: {},
    });

    const probeCall = readProbeCall();
    expect(probeCall.preauthHandshakeTimeoutMs).toBe(30_000);
    expect(probeCall.timeoutMs).toBe(30_000);
    const gatewayCall = readGatewayCall();
    expect(gatewayCall.config).toEqual({ gateway: { handshakeTimeoutMs: 30_000 } });
    expect(gatewayCall.timeoutMs).toBe(30_000);
  });

  it("does not raise an explicit local status RPC fallback timeout", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    await resolveGatewayProbeSnapshot({
      cfg: { gateway: { handshakeTimeoutMs: 30_000 } },
      opts: { timeoutMs: 1000 },
    });

    const probeCall = readProbeCall();
    expect(probeCall.preauthHandshakeTimeoutMs).toBe(30_000);
    expect(probeCall.timeoutMs).toBe(1000);
    expect(readGatewayCall().timeoutMs).toBe(1000);
  });

  it("lets callGateway reuse paired-device auth for local status RPC fallback", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: {},
      warning: undefined,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });
    mocks.callGateway.mockResolvedValue({ sessions: 1 });

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    const gatewayCall = readGatewayCall();
    expect(gatewayCall.config).toEqual({});
    expect(gatewayCall.method).toBe("status");
    expect(gatewayCall.token).toBeUndefined();
    expect(gatewayCall.password).toBeUndefined();
    expect(gatewayCall.mode).toBe("backend");
    expect(gatewayCall.clientName).toBe("gateway-client");
    expect(gatewayCall).not.toHaveProperty("deviceIdentity");
    expect(result.gatewayReachable).toBe(true);
  });

  it("does not use the status RPC fallback for remote probe failures", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "remote",
      gatewayMode: "remote",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "wss://gateway.example/ws",
      connectLatencyMs: null,
      error: "timeout",
      close: null,
      auth: {
        role: null,
        scopes: [],
        capability: "unknown",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode: "remote", remote: { url: "wss://gateway.example/ws" } } },
      opts: {},
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayReachable).toBe(false);
  });
});

describe("resolveSharedMemoryStatusSnapshot", () => {
  it("asks custom memory-slot runtimes for status without requiring built-in memorySearch", async () => {
    const manager = {
      probeVectorStoreAvailability: vi.fn(async () => true),
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({
        backend: "builtin" as const,
        provider: "memory-lancedb-pro",
        files: 66,
        chunks: 128,
        vector: { enabled: true, available: true },
        fts: { enabled: true, available: true },
      })),
      close: vi.fn(async () => {}),
    };
    const resolveMemoryConfig = vi.fn(() => null);
    const getMemorySearchManager = vi.fn(async () => ({ manager }));
    const requireDefaultStore = vi.fn(() => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`);

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {
        plugins: {
          slots: { memory: "memory-lancedb-pro" },
        },
        agents: {
          defaults: {
            memorySearch: { enabled: false },
          },
        },
      },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultStore,
    });

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(requireDefaultStore).not.toHaveBeenCalled();
    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    const managerCalls = getMemorySearchManager.mock.calls as unknown as Array<
      [MemorySearchManagerCall]
    >;
    const managerCall = managerCalls[0]?.[0];
    expect(managerCall?.cfg.plugins?.slots).toEqual({ memory: "memory-lancedb-pro" });
    expect(managerCall?.agentId).toBe("main");
    expect(managerCall?.purpose).toBe("status");
    expect(manager.probeVectorStoreAvailability).toHaveBeenCalled();
    expect(manager.probeVectorAvailability).not.toHaveBeenCalled();
    expect(manager.status).toHaveBeenCalled();
    expect(manager.close).toHaveBeenCalled();
    expect(result).toEqual({
      agentId: "main",
      backend: "builtin",
      provider: "memory-lancedb-pro",
      files: 66,
      chunks: 128,
      vector: { enabled: true, available: true },
      fts: { enabled: true, available: true },
    });
  });

  it("uses semantic vector probes for non-builtin memory-slot runtimes", async () => {
    const manager = {
      probeVectorStoreAvailability: vi.fn(async () => true),
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({
        backend: "qmd" as const,
        provider: "qmd",
        files: 5,
        chunks: 5,
        vector: { enabled: true, available: true, semanticAvailable: true },
      })),
      close: vi.fn(async () => {}),
    };
    const getMemorySearchManager = vi.fn(async () => ({ manager }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: { plugins: { slots: { memory: "qmd" } } },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "qmd" },
      resolveMemoryConfig: vi.fn(() => null),
      getMemorySearchManager,
      requireDefaultStore: vi.fn(),
    });

    expect(manager.probeVectorStoreAvailability).not.toHaveBeenCalled();
    expect(manager.probeVectorAvailability).toHaveBeenCalled();
    expect(result).toEqual({
      agentId: "main",
      backend: "qmd",
      provider: "qmd",
      files: 5,
      chunks: 5,
      vector: { enabled: true, available: true, semanticAvailable: true },
    });
  });

  it("keeps default memory-core on the cold-start store shortcut", async () => {
    const resolveMemoryConfig = vi.fn(() => null);
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultStore: () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    });

    expect(result).toBeNull();
    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });
});
