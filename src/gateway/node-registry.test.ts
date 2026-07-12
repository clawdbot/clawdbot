/**
 * Gateway node registry tests.
 */
import { EventEmitter } from "node:events";
import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveNodeContext,
  resetActiveNodeContextForTests,
} from "../infra/active-node-context.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  listConnectedNodePluginTools,
  resetConnectedNodePluginToolsForTest,
} from "./node-plugin-tool-snapshot.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

let testNodeHostCommands: NonNullable<
  ReturnType<typeof createEmptyPluginRegistry>["nodeHostCommands"]
> = [];

function makeClient(
  connId: string,
  nodeId: string,
  sent: string[] = [],
  opts: {
    clientId?: string;
    displayName?: string;
    platform?: string;
    version?: string;
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    declaredCaps?: string[];
    declaredCommands?: string[];
    declaredPermissions?: Record<string, boolean>;
    sessionCapsCeiling?: string[];
    sessionCommandsCeiling?: string[];
    socket?: GatewayWsClient["socket"];
  } = {},
): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket:
      opts.socket ??
      ({
        send(frame: unknown) {
          if (typeof frame === "string") {
            sent.push(frame);
          }
        },
      } as unknown as GatewayWsClient["socket"]),
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: opts.clientId ?? "openclaw-macos",
        version: opts.version ?? "1.0.0",
        platform: opts.platform ?? "darwin",
        mode: "node",
        displayName: opts.displayName,
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      caps: opts.caps ?? [],
      commands: opts.commands ?? [],
      permissions: opts.permissions,
      declaredCaps: opts.declaredCaps,
      declaredCommands: opts.declaredCommands,
      declaredPermissions: opts.declaredPermissions,
      sessionCapsCeiling: opts.sessionCapsCeiling,
      sessionCommandsCeiling: opts.sessionCommandsCeiling,
    } as unknown as GatewayWsClient["connect"],
  };
}

afterEach(() => {
  testNodeHostCommands = [];
  resetConnectedNodePluginToolsForTest();
  resetActiveNodeContextForTests();
});

function registerDemoNodePluginTool(params: {
  name: string;
  command: string;
  description?: string;
  parameters?: Record<string, unknown>;
  dangerous?: boolean;
}) {
  const registry = createEmptyPluginRegistry();
  registry.nodeHostCommands ??= [];
  registry.nodeHostCommands.push({
    pluginId: "demo",
    pluginName: "Demo",
    source: "test",
    rootDir: "test",
    command: {
      command: params.command,
      ...(params.dangerous ? { dangerous: true } : {}),
      agentTool: {
        name: params.name,
        description: params.description ?? "Demo node-host tool",
        ...(params.parameters ? { parameters: params.parameters } : {}),
      },
      handle: async () => "{}",
    },
  });
  testNodeHostCommands = registry.nodeHostCommands;
}

function createTestNodeRegistry(): NodeRegistry {
  return new NodeRegistry({
    listRegisteredNodePluginToolCommands: () => testNodeHostCommands,
  });
}

function makeConnectivitySocket(emitPong: boolean) {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (frame: unknown) => void;
    ping: (data?: Buffer, mask?: boolean, cb?: (err?: Error) => void) => void;
  };
  socket.readyState = 1;
  socket.send = () => {};
  socket.ping = (_dataValue, _mask, cb) => {
    cb?.();
    if (emitPong) {
      queueMicrotask(() => socket.emit("pong"));
    }
  };
  return socket as unknown as GatewayWsClient["socket"];
}

function registerNode(registry: NodeRegistry, opts: Parameters<typeof makeClient>[3] = {}) {
  const frames: string[] = [];
  registry.register(makeClient("conn-1", "node-1", frames, opts), {});
  return frames;
}

function publishNodePluginTools(
  registry: NodeRegistry,
  tools: Parameters<NodeRegistry["updateNodePluginTools"]>[2],
  connId = "conn-1",
) {
  return registry.updateNodePluginTools("node-1", connId, tools);
}

function publishNodeSkills(
  registry: NodeRegistry,
  skills: Parameters<NodeRegistry["updateNodeSkills"]>[2],
  connId = "conn-1",
) {
  return registry.updateNodeSkills("node-1", connId, skills);
}

function nodeSkill(name: string, body = "# Instructions") {
  const description = `${name} description`;
  return {
    name,
    description,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  };
}

function registerLinuxNode(registry: NodeRegistry) {
  return registerNode(registry, {
    clientId: "openclaw-node-host",
    platform: "linux",
  });
}

function invokeSystemRun(
  registry: NodeRegistry,
  frames: string[],
  params: Record<string, unknown>,
  timeoutMs = 1_000,
) {
  const invoke = registry.invoke({
    nodeId: "node-1",
    command: "system.run",
    params,
    timeoutMs,
  });
  const request = JSON.parse(frames[0] ?? "{}") as {
    payload?: { id?: string; paramsJSON?: string | null };
  };
  return { invoke, request };
}

type SystemRunEvent = Parameters<NodeRegistry["authorizeSystemRunEvent"]>[0];

function authorizeSystemRun(registry: NodeRegistry, overrides: Partial<SystemRunEvent> = {}) {
  return registry.authorizeSystemRunEvent({
    nodeId: "node-1",
    connId: "conn-1",
    sessionKey: "agent:main:main",
    terminal: true,
    ...overrides,
  });
}

describe("gateway/node-registry", () => {
  it("ranks connected nodes by gateway-derived input activity", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        displayName: "Desk Mac",
        permissions: { accessibility: true },
      }),
      {},
    );
    registry.register(
      makeClient("conn-2", "node-2", [], {
        displayName: "Laptop",
        permissions: { accessibility: true },
      }),
      {},
    );

    expect(
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-1",
        idleSeconds: 10,
        observedAtMs: 100_000,
      }),
    ).toMatchObject({ lastActiveAtMs: 90_000, presenceUpdatedAtMs: 100_000 });
    registry.updatePresenceActivity({
      nodeId: "node-2",
      connId: "conn-2",
      idleSeconds: 2,
      observedAtMs: 105_000,
    });

    expect(registry.getActiveNode()?.nodeId).toBe("node-2");
    expect(getActiveNodeContext()).toEqual({ nodeId: "node-2" });
    expect(registry.unregister("conn-2")).toBe("node-2");
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getActiveNodeContext()).toEqual({ nodeId: "node-1" });
  });

  it("recomputes active context when a same-id connection replaces reported presence", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-old", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-old",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registry.register(
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(registry.getActiveNode()).toBeUndefined();
    expect(getActiveNodeContext()).toBeNull();
    expect(registry.unregister("conn-old")).toBeNull();
    expect(getActiveNodeContext()).toBeNull();
  });

  it("rejects presence updates from stale node connections", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-old",
        idleSeconds: 0,
        observedAtMs: 100_000,
      }),
    ).toBeNull();
    expect(registry.getActiveNode()).toBeUndefined();
  });

  it("does not advance a bounded estimate on saturated idle keepalives", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    const first = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_000_000,
    });
    const keepalive = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_180_000,
    });

    expect(first?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.presenceUpdatedAtMs).toBe(3_000_180_000);
  });

  it("clears reported presence when Accessibility permission is removed", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        permissions: { accessibility: true },
        declaredPermissions: { accessibility: true },
      }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registry.updateSurface("node-1", { commands: [], permissions: { accessibility: false } });

    expect(registry.get("node-1")?.lastActiveAtMs).toBeUndefined();
    expect(registry.get("node-1")?.presenceUpdatedAtMs).toBeUndefined();
    expect(registry.getActiveNode()).toBeUndefined();
    expect(getActiveNodeContext()).toBeNull();
  });

  it("checks node websocket connectivity with ping/pong", async () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: makeConnectivitySocket(true),
      }),
      {},
    );

    await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({ ok: true });
  });

  it("reports stale node websocket connectivity before invoke timeout", async () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: makeConnectivitySocket(false),
      }),
      {},
    );

    const result = await registry.checkConnectivity("node-1", 1);

    expect(result).toEqual({
      ok: false,
      error: { code: "TIMEOUT", message: "node connectivity probe timed out" },
    });
  });

  it("keeps a reconnected node when the old connection unregisters", async () => {
    const registry = createTestNodeRegistry();
    const oldFrames: string[] = [];
    const newClient = makeClient("conn-new", "node-1");

    registry.register(makeClient("conn-old", "node-1", oldFrames), {});
    const oldInvoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 1_000,
    });
    const oldDisconnected = oldInvoke.catch((err: unknown) => err);
    const oldRequest = JSON.parse(oldFrames[0] ?? "{}") as { payload?: { id?: string } };
    const newSession = registry.register(newClient, {});

    expect(
      registry.handleInvokeResult({
        id: oldRequest.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-new",
        ok: true,
      }),
    ).toBe(false);
    expect(registry.unregister("conn-old")).toBeNull();
    expect(registry.get("node-1")).toBe(newSession);
    await expect(oldDisconnected).resolves.toBeInstanceOf(Error);
  });

  it("rejects invoke when the node connection changed before dispatch", async () => {
    const registry = new NodeRegistry();
    const replacementFrames: string[] = [];
    registry.register(makeClient("conn-old", "node-1"), {});
    registry.register(makeClient("conn-new", "node-1", replacementFrames), {});

    await expect(
      registry.invoke({
        nodeId: "node-1",
        expectedConnId: "conn-old",
        command: "system.run",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
    });
    expect(replacementFrames).toEqual([]);
  });

  it("matches pending system.run events to the issuing connection", async () => {
    const registry = createTestNodeRegistry();
    const frames = registerLinuxNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      runId: "run-1",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(true);
    expect(
      authorizeSystemRun(registry, {
        connId: "conn-other",
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(false);
    expect(
      authorizeSystemRun(registry, {
        runId: "run-other",
        terminal: false,
      }),
    ).toBe(false);

    registry.handleInvokeResult({
      id: request.payload?.id ?? "",
      nodeId: "node-1",
      connId: "conn-1",
      ok: true,
    });
    await expect(invoke).resolves.toEqual({
      ok: true,
      payload: undefined,
      payloadJSON: null,
      error: null,
    });
    expect(
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: true,
      }),
    ).toBe(true);
    expect(
      authorizeSystemRun(registry, {
        runId: "run-1",
        terminal: false,
      }),
    ).toBe(false);
  });

  it("keeps no-timeout system.run event authorization after invoke timeout", async () => {
    vi.useFakeTimers();
    const registry = createTestNodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke, request } = invokeSystemRun(
        registry,
        frames,
        { runId: "run-timeout", sessionKey: "agent:main:main", timeoutMs: 0 },
        1,
      );
      const forwarded = JSON.parse(request.payload?.paramsJSON ?? "{}") as {
        timeoutMs?: number | null;
      };

      expect(forwarded.timeoutMs).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(
        authorizeSystemRun(registry, {
          runId: "run-timeout",
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps zero-timeout invokes pending until the node responds", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "debug.ping",
        timeoutMs: 0,
      });
      const request = JSON.parse(frames[0] ?? "{}") as {
        payload?: { id?: string; timeoutMs?: number };
      };

      expect(request.payload?.timeoutMs).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        registry.handleInvokeResult({
          id: request.payload?.id ?? "",
          nodeId: "node-1",
          connId: "conn-1",
          ok: true,
        }),
      ).toBe(true);
      await expect(invoke).resolves.toEqual({
        ok: true,
        payload: undefined,
        payloadJSON: null,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects zero-timeout invokes when the node disconnects", async () => {
    const registry = new NodeRegistry();
    registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 0,
    });
    const disconnected = invoke.catch((error: unknown) => error);

    expect(registry.unregister("conn-1")).toBe("node-1");
    const error = await disconnected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("node disconnected (debug.ping)");
  });

  it("returns a structured unavailable result when a node disconnects during an MCP call", async () => {
    const registry = new NodeRegistry();
    registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "mcp.tools.call.v1",
      timeoutMs: 0,
    });

    expect(registry.unregister("conn-1")).toBe("node-1");
    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "MCP_SERVER_UNAVAILABLE",
        message: "node host disconnected during MCP tool call",
      },
    });
  });

  it("caps oversized invoke and system.run authorization timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const registry = createTestNodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke } = invokeSystemRun(
        registry,
        frames,
        {
          runId: "run-oversized",
          sessionKey: "agent:main:main",
          timeoutMs: Number.MAX_SAFE_INTEGER,
        },
        Number.MAX_SAFE_INTEGER,
      );
      const request = JSON.parse(frames[0] ?? "{}") as {
        payload?: { paramsJSON?: string | null; timeoutMs?: number };
      };
      const forwarded = JSON.parse(request.payload?.paramsJSON ?? "{}") as {
        timeoutMs?: number | null;
      };

      expect(request.payload?.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(forwarded.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      expect(
        authorizeSystemRun(registry, {
          runId: "run-oversized",
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires system.run authorization when the process clock is invalid", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-invalid-clock",
      sessionKey: "agent:main:main",
      timeoutMs: 1_000,
    });
    void invoke.catch(() => {});

    try {
      expect(
        authorizeSystemRun(registry, {
          runId: "run-invalid-clock",
        }),
      ).toBe(false);
    } finally {
      registry.unregister("conn-1");
      nowSpy.mockRestore();
    }
  });

  it("expires system.run authorization when the expiry would exceed the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MAX_DATE_TIMESTAMP_MS);
    const registry = createTestNodeRegistry();
    try {
      const frames = registerNode(registry);
      const { invoke } = invokeSystemRun(registry, frames, {
        runId: "run-overflow",
        sessionKey: "agent:main:main",
        timeoutMs: 1_000,
      });
      void invoke.catch(() => {});

      expect(
        authorizeSystemRun(registry, {
          runId: "run-overflow",
        }),
      ).toBe(false);
      registry.unregister("conn-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches a single system.run event when legacy payload omits runId", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-legacy",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events for non-legacy nodes", () => {
    const registry = createTestNodeRegistry();
    const frames = registerLinuxNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-required",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("generates and forwards a runId when system.run params omit it", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      command: ["/bin/sh", "-lc", "printf ok"],
      sessionKey: "agent:main:main",
    });
    const forwarded = JSON.parse(request.payload?.paramsJSON ?? "{}") as { runId?: unknown };

    expect(typeof forwarded.runId).toBe("string");
    expect(
      authorizeSystemRun(registry, {
        runId: forwarded.runId as string,
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("clears system.run event authorization when invoke result fails", async () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      runId: "run-failed",
      sessionKey: "agent:main:main",
      timeoutMs: 0,
    });

    expect(
      registry.handleInvokeResult({
        id: request.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid params" },
      }),
    ).toBe(true);
    await expect(invoke).resolves.toEqual({
      ok: false,
      payload: undefined,
      payloadJSON: null,
      error: { code: "INVALID_REQUEST", message: "invalid params" },
    });
    expect(
      authorizeSystemRun(registry, {
        runId: "run-failed",
      }),
    ).toBe(false);
  });

  it("matches legacy macOS exec events with runtime-generated runId when single pending run matches", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "gateway-run",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "legacy-runtime-run",
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects mismatched runId fallback for non-macOS nodes", () => {
    const registry = createTestNodeRegistry();
    const frames = registerLinuxNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "gateway-run",
      sessionKey: "agent:main:main",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "runtime-run",
      }),
    ).toBe(false);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("matches system.run events with emitted session key when invoke omitted sessionKey", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-without-session",
    });

    expect(
      authorizeSystemRun(registry, {
        runId: "run-without-session",
      }),
    ).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
  });

  it("rejects runId-less system.run events when the connection has multiple matches", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke: first } = invokeSystemRun(registry, frames, {
      runId: "run-a",
      sessionKey: "agent:main:main",
    });
    const { invoke: second } = invokeSystemRun(registry, frames, {
      runId: "run-b",
      sessionKey: "agent:main:main",
    });

    expect(authorizeSystemRun(registry)).toBe(false);
    registry.unregister("conn-1");
    void first.catch(() => {});
    void second.catch(() => {});
  });

  it("sends raw event payload JSON without changing the envelope shape", () => {
    const registry = createTestNodeRegistry();
    const frames: string[] = [];
    registry.register(makeClient("conn-1", "node-1", frames), {});
    const payload = serializeEventPayload({ foo: "bar" });
    const nullPayload = serializeEventPayload(null);
    const falsePayload = serializeEventPayload(false);
    const zeroPayload = serializeEventPayload(0);
    const emptyStringPayload = serializeEventPayload("");

    expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "nullish", nullPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "flag", falsePayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "count", zeroPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "empty", emptyStringPayload)).toBe(true);
    expect(registry.sendEventRaw("missing-node", "chat", payload)).toBe(false);
    expect(registry.sendEventRaw("node-1", "heartbeat", null)).toBe(true);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        "not-json" as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        '{"x":1},"seq":999' as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);

    expect(frames).toEqual([
      '{"type":"event","event":"chat","payload":{"foo":"bar"}}',
      '{"type":"event","event":"nullish","payload":null}',
      '{"type":"event","event":"flag","payload":false}',
      '{"type":"event","event":"count","payload":0}',
      '{"type":"event","event":"empty","payload":""}',
      '{"type":"event","event":"heartbeat"}',
    ]);
  });

  it("rejects raw event sends when the node socket buffer is saturated", () => {
    resetDiagnosticEventsForTest();
    const diagnosticEvents: unknown[] = [];
    const stopDiagnostics = onDiagnosticEvent((event) => diagnosticEvents.push(event));
    const registry = createTestNodeRegistry();
    const socket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    registry.register(
      makeClient("conn-1", "node-1", [], {
        socket: socket as unknown as GatewayWsClient["socket"],
      }),
      {},
    );
    const payload = serializeEventPayload({ foo: "bar" });

    try {
      expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      expect(diagnosticEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "payload.large",
            action: "rejected",
            surface: "gateway.ws.outbound_buffer",
            bytes: MAX_BUFFERED_BYTES + 1,
            limitBytes: MAX_BUFFERED_BYTES,
            reason: "ws_send_buffer_close",
          }),
        ]),
      );
    } finally {
      stopDiagnostics();
      resetDiagnosticEventsForTest();
    }
  });

  it("refreshes effective live surface within the declared surface", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["talk"],
      declaredCommands: ["talk.ptt.start"],
      declaredPermissions: { microphone: true, camera: false },
    });

    const session = registry.register(client, {});
    expect(session.caps).toEqual([]);
    expect(session.commands).toEqual([]);

    const updated = registry.updateSurface("node-1", {
      caps: ["talk", "screen"],
      commands: ["talk.ptt.start", "system.run"],
      permissions: { microphone: true, camera: true },
    });

    expect(updated?.caps).toEqual(["talk"]);
    expect(updated?.commands).toEqual(["talk.ptt.start"]);
    expect(updated?.permissions).toEqual({ microphone: true, camera: false });
    expect(client.connect.caps).toEqual(["talk"]);
    expect((client.connect as { commands?: string[] }).commands).toEqual(["talk.ptt.start"]);
  });

  it("keeps node-hosted plugin tools inside the approved command surface", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["demo.echo"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the node",
        command: "demo.echo",
      },
      {
        pluginId: "demo",
        name: "demo_blocked",
        description: "Blocked command",
        command: "demo.blocked",
      },
    ]);

    expect(session.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_echo",
    ]);

    registry.updateSurface("node-1", {
      caps: [],
      commands: [],
    });

    expect(registry.get("node-1")?.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("keeps dangerous node-hosted plugin tools once explicitly approved", () => {
    registerDemoNodePluginTool({
      name: "demo_dangerous",
      command: "demo.dangerous",
      dangerous: true,
    });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["demo.dangerous"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_dangerous",
        description: "Dangerous command",
        command: "demo.dangerous",
      },
    ]);

    expect(session.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_dangerous"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_dangerous",
    ]);
  });

  it("drops node-hosted plugin tools with provider-unsafe names", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["demo.echo"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo.echo",
        description: "Invalid provider tool name",
        command: "demo.echo",
      },
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Valid provider tool name",
        command: "demo.echo",
      },
    ]);

    expect(session.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_echo",
    ]);
  });

  it("accepts unregistered descriptors only inside the approved command surface", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["system.run"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Allowed command",
        command: "system.run",
      },
      {
        pluginId: "demo",
        name: "demo_blocked",
        description: "Blocked command",
        command: "demo.blocked",
      },
    ]);

    expect(session.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_echo",
    ]);
  });

  it("uses registry metadata for node-hosted plugin tool descriptors", () => {
    registerDemoNodePluginTool({
      name: "demo_echo",
      command: "demo.echo",
      description: "Trusted registry description",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
      },
    });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["demo.echo"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Injected node description",
        parameters: {
          type: "object",
          properties: { secret: { type: "string" } },
        },
        command: "demo.echo",
      },
    ]);

    expect(session.nodePluginTools).toEqual([
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Trusted registry description",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
        },
        command: "demo.echo",
      },
    ]);
  });

  it("keeps declared node-hosted plugin tools for later command approval", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: [],
      declaredCommands: ["demo.echo"],
    });

    const session = registry.register(client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the node",
        command: "demo.echo",
      },
    ]);
    expect(session.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);

    registry.updateSurface("node-1", {
      caps: [],
      commands: ["demo.echo"],
    });

    expect(registry.get("node-1")?.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_echo",
    ]);
  });

  it("enriches published node tools after matching plugin descriptors load", () => {
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-1", "node-1", [], {
        commands: ["demo.echo"],
      }),
      {},
    );
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Published description",
        command: "demo.echo",
      },
    ]);

    expect(registry.get("node-1")?.nodePluginTools[0]?.description).toBe("Published description");

    registerDemoNodePluginTool({
      name: "demo_echo",
      command: "demo.echo",
      description: "Registered description",
    });
    registry.refreshNodePluginTools();

    expect(registry.get("node-1")?.nodePluginTools[0]?.description).toBe("Registered description");
  });

  it("ignores published node tools when gateway publication is disabled", () => {
    const registry = new NodeRegistry({ nodePluginToolsEnabled: false });
    registry.register(
      makeClient("conn-1", "node-1", [], {
        commands: ["demo.echo"],
      }),
      {},
    );

    const updated = publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the node",
        command: "demo.echo",
      },
    ]);

    expect(updated?.declaredNodePluginTools).toEqual([]);
    expect(updated?.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("ignores node plugin tool updates from stale connections", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    registry.register(
      makeClient("conn-old", "node-1", [], {
        commands: ["demo.echo"],
      }),
      {},
    );
    registry.register(
      makeClient("conn-new", "node-1", [], {
        commands: ["demo.echo"],
      }),
      {},
    );

    const updated = registry.updateNodePluginTools("node-1", "conn-old", [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the old node connection",
        command: "demo.echo",
      },
    ]);

    expect(updated).toBeNull();
    expect(registry.get("node-1")?.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("stores bounded node-hosted skill updates on the current session", () => {
    const registry = createTestNodeRegistry();
    const session = registry.register(makeClient("conn-1", "node-1"), {});

    const updated = publishNodeSkills(registry, [
      nodeSkill("release-helper"),
      { ...nodeSkill("broken"), content: "x".repeat(64 * 1024 + 1) },
    ]);

    expect(updated).toBe(session);
    expect(session.nodeSkills.map((skill) => skill.name)).toEqual(["release-helper"]);
  });

  it("enforces node skill count and total-content caps", () => {
    const registry = createTestNodeRegistry();
    registry.register(makeClient("conn-1", "node-1"), {});

    const countUpdate = publishNodeSkills(
      registry,
      Array.from({ length: 65 }, (_, index) =>
        nodeSkill(`count-${String(index).padStart(2, "0")}`),
      ),
    );
    expect(countUpdate?.nodeSkills).toHaveLength(64);

    const totalUpdate = publishNodeSkills(
      registry,
      Array.from({ length: 9 }, (_, index) =>
        nodeSkill(`large-${String(index).padStart(2, "0")}`, "x".repeat(60 * 1024)),
      ),
    );
    expect(totalUpdate?.nodeSkills).toHaveLength(8);
  });

  it("ignores node skills when publication is disabled or the connection is stale", () => {
    const disabled = new NodeRegistry({ nodeSkillsEnabled: false });
    disabled.register(makeClient("conn-1", "node-1"), {});
    expect(publishNodeSkills(disabled, [nodeSkill("disabled")])?.nodeSkills).toEqual([]);

    const registry = createTestNodeRegistry();
    registry.register(makeClient("conn-old", "node-1"), {});
    registry.register(makeClient("conn-new", "node-1"), {});
    expect(publishNodeSkills(registry, [nodeSkill("stale")], "conn-old")).toBeNull();
    expect(registry.get("node-1")?.nodeSkills).toEqual([]);
  });

  it("clears effective permissions when explicitly removed", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      permissions: { camera: false },
      declaredPermissions: { camera: false },
    });

    registry.register(client, {});
    const updated = registry.updateSurface("node-1", {
      caps: [],
      commands: [],
      permissions: undefined,
    });

    expect(updated?.permissions).toBeUndefined();
    expect(
      (client.connect as { permissions?: Record<string, boolean> }).permissions,
    ).toBeUndefined();
  });

  it("preserves a legacy session feature ceiling across surface approvals", () => {
    const registry = new NodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["canvas", "device"],
      declaredCommands: ["canvas.snapshot", "device.info"],
      sessionCapsCeiling: ["device"],
      sessionCommandsCeiling: ["device.info"],
    });

    registry.register(client, {});
    const updated = registry.updateSurface("node-1", {
      caps: ["canvas", "device"],
      commands: ["canvas.snapshot", "device.info"],
    });

    expect(updated?.declaredCaps).toEqual(["canvas", "device"]);
    expect(updated?.declaredCommands).toEqual(["canvas.snapshot", "device.info"]);
    expect(updated?.caps).toEqual(["device"]);
    expect(updated?.commands).toEqual(["device.info"]);
  });
});
