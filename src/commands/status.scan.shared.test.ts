// Status scan shared tests cover gateway probe snapshots, Tailscale URLs, and shared scan helpers.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { parseStatusRouteArgs } from "../cli/program/route-args.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import {
  buildTailscaleHttpsUrl,
  resolveGatewayProbeSnapshot as resolveGatewayProbeSnapshotOwner,
  resolveSharedMemoryStatusSnapshot,
} from "./status.scan.shared.js";

const tempDirs: string[] = [];
const resolveGatewayProbeSnapshot = (
  params: Omit<Parameters<typeof resolveGatewayProbeSnapshotOwner>[0], "configPath" | "env">,
) =>
  resolveGatewayProbeSnapshotOwner({
    ...params,
    configPath: "/tmp/openclaw.json",
    env: process.env,
  });

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

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
  inspectSources?: boolean;
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
      gatewayReached: true,
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

  it("does not use the local status RPC fallback for dotted localhost", async () => {
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url: "ws://localhost.:18789",
      urlSource: "local loopback",
      message: "Gateway target: ws://localhost.:18789",
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://localhost.:18789",
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
      cfg: {},
      opts: {},
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.gatewayProbe?.ok).toBe(false);
  });

  it("uses built-in probe defaults for the local status RPC fallback", async () => {
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
      cfg: {},
      opts: {},
    });

    const probeCall = readProbeCall();
    expect(probeCall).not.toHaveProperty("preauthHandshakeTimeoutMs");
    expect(probeCall.timeoutMs).toBe(2500);
    const gatewayCall = readGatewayCall();
    expect(gatewayCall.config).toEqual({});
    expect(gatewayCall.timeoutMs).toBe(2000);
  });

  it.each([1, 50, 999, 1000, 2000, 8000])(
    "does not raise an explicit local status RPC fallback timeout (%i ms)",
    async (timeoutMs) => {
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
        cfg: {},
        opts: { timeoutMs },
      });

      const probeCall = readProbeCall();
      expect(probeCall).not.toHaveProperty("preauthHandshakeTimeoutMs");
      expect(probeCall.timeoutMs).toBe(timeoutMs);
      expect(readGatewayCall().timeoutMs).toBe(Math.min(2000, timeoutMs));
    },
  );

  it("enforces an explicit CLI timeout against a real local fallback status RPC", async () => {
    const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(gateway, "listening");
    const address = gateway.address() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;
    const observedMethods: string[] = [];
    gateway.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.type !== "req" || !frame.id || !frame.method) {
          return;
        }
        const requestId = frame.id;
        if (frame.method === "connect") {
          sendMinimalGatewayResponse(
            socket,
            requestId,
            buildMinimalGatewayHelloOkPayload({
              methods: ["system-presence", "status"],
              auth: { role: "operator", scopes: ["operator.read"] },
            }),
          );
          return;
        }
        observedMethods.push(frame.method);
        if (frame.method === "status") {
          const responseTimer = setTimeout(() => {
            if (socket.readyState === socket.OPEN) {
              sendMinimalGatewayResponse(socket, requestId, { sessions: 1 });
            }
          }, 400);
          responseTimer.unref();
        }
      });
    });

    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      url,
      urlSource: "local loopback",
      message: `Gateway target: ${url}`,
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockImplementation(async (...args: unknown[]) => {
      const { probeGateway } =
        await vi.importActual<typeof import("../gateway/probe.js")>("../gateway/probe.js");
      return await probeGateway(...(args as Parameters<typeof probeGateway>));
    });
    mocks.callGateway.mockImplementation(async (...args: unknown[]) => {
      const { callGateway } =
        await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
      return await callGateway(...(args as Parameters<typeof callGateway>));
    });
    const parsed = parseStatusRouteArgs(["node", "openclaw", "status", "--timeout", "250"]);
    expect(parsed?.timeoutMs).toBe(250);

    try {
      const result = await resolveGatewayProbeSnapshot({
        cfg: { gateway: { auth: { mode: "none" } } },
        opts: { timeoutMs: parsed?.timeoutMs },
      });

      expect(readProbeCall().timeoutMs).toBe(250);
      expect(readGatewayCall().timeoutMs).toBe(250);
      expect(observedMethods).toEqual(["system-presence", "status"]);
      expect(result.gatewayProbe?.ok).toBe(false);
      expect(result.gatewayProbe?.error).toContain("timeout");
    } finally {
      await closeMinimalGatewayServer(gateway);
    }
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

describe("buildTailscaleHttpsUrl", () => {
  it("uses the device hostname and configured Control UI base path", () => {
    expect(
      buildTailscaleHttpsUrl({
        tailscaleMode: "serve",
        tailscaleDns: "node.tailnet.ts.net",
        controlUiBasePath: "/control",
      }),
    ).toBe("https://node.tailnet.ts.net/control");
  });

  it("uses a Tailscale IP when MagicDNS is unavailable", () => {
    expect(
      buildTailscaleHttpsUrl({
        tailscaleMode: "serve",
        tailscaleDns: "100.64.0.8",
      }),
    ).toBe("https://100.64.0.8");
  });
});

describe("resolveSharedMemoryStatusSnapshot", () => {
  it("skips agent-scoped memory when an explicit fleet has no selected owner", async () => {
    const resolveMemoryConfig = vi.fn();
    const getMemorySearchManager = vi.fn();

    await expect(
      resolveSharedMemoryStatusSnapshot({
        cfg: {
          agents: {
            ownership: "explicit",
            entries: { alpha: {}, beta: {} },
          },
        },
        agentStatus: { defaultId: null },
        memoryPlugin: { enabled: true, slot: "memory-core" },
        resolveMemoryConfig,
        getMemorySearchManager,
      }),
    ).resolves.toBeNull();

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "top-level defaults",
      cfg: { memory: { search: { provider: "local" } } },
    },
    {
      name: "per-agent overrides",
      cfg: {
        agents: {
          entries: { main: { memory: { search: { provider: "local" } } } },
        },
      },
    },
  ])("inspects explicitly configured memory from $name", async ({ cfg }) => {
    const manager = {
      probeVectorStoreAvailability: vi.fn(async () => true),
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({
        backend: "builtin" as const,
        provider: "local",
        files: 0,
        chunks: 0,
        dirty: true,
      })),
      close: vi.fn(async () => {}),
    };
    const resolveMemoryConfig = vi.fn(() => ({
      store: { databasePath: `/tmp/openclaw-missing-memory-${process.pid}.sqlite` },
    }));
    const getMemorySearchManager = vi.fn(async () => ({ manager }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg,
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath: () =>
        `/tmp/openclaw-missing-default-memory-${process.pid}.sqlite`,
    });

    expect(resolveMemoryConfig).toHaveBeenCalledOnce();
    expect(getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "status", inspectSources: true }),
    );
    expect(result?.provider).toBe("local");
    expect(result?.dirty).toBe(true);
  });

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
    const requireDefaultDatabasePath = vi.fn(
      () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    );

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {
        plugins: {
          slots: { memory: "memory-lancedb-pro" },
        },
        memory: { search: { enabled: false } },

        agents: {
          defaults: {},
        },
      },
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath,
    });

    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(requireDefaultDatabasePath).not.toHaveBeenCalled();
    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    const managerCalls = getMemorySearchManager.mock.calls as unknown as Array<
      [MemorySearchManagerCall]
    >;
    const managerCall = managerCalls[0]?.[0];
    expect(managerCall?.cfg.plugins?.slots).toEqual({ memory: "memory-lancedb-pro" });
    expect(managerCall?.agentId).toBe("main");
    expect(managerCall?.purpose).toBe("status");
    expect(managerCall?.inspectSources).toBe(true);
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

  it("keeps default memory-core on the cold-start store shortcut", async () => {
    const resolveMemoryConfig = vi.fn(() => null);
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig,
      getMemorySearchManager,
      requireDefaultDatabasePath: () => `/tmp/openclaw-missing-memory-${process.pid}.sqlite`,
    });

    expect(result).toBeNull();
    expect(resolveMemoryConfig).not.toHaveBeenCalled();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("recognizes shipped memory tables before the manager migrates them", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-status-memory-");
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO files VALUES ('MEMORY.md', 'memory', 'file-hash', 10, 20);
    `);
    db.close();
    const manager = {
      probeVectorStoreAvailability: vi.fn(async () => true),
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({
        backend: "builtin" as const,
        provider: "openai",
        files: 1,
        chunks: 0,
        vector: { enabled: true, available: true },
        fts: { enabled: true, available: true },
      })),
      close: vi.fn(async () => {}),
    };
    const getMemorySearchManager = vi.fn(async () => ({ manager }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => ({ store: { databasePath } })),
      getMemorySearchManager,
      requireDefaultDatabasePath: () => databasePath,
    });

    expect(getMemorySearchManager).toHaveBeenCalledOnce();
    expect(result?.files).toBe(1);
  });

  it("does not initialize memory status for an agent database owned by another feature", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-status-memory-");
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE cache_entries (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
    db.close();
    const getMemorySearchManager = vi.fn(async () => ({ manager: null }));

    const result = await resolveSharedMemoryStatusSnapshot({
      cfg: {},
      agentStatus: { defaultId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: vi.fn(() => ({ store: { databasePath } })),
      getMemorySearchManager,
      requireDefaultDatabasePath: () => databasePath,
    });

    expect(result).toBeNull();
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });
});
