/**
 * Gateway node registry tests.
 */
import { EventEmitter } from "node:events";
import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentActiveNodeContext, setActiveNodeContext } from "../infra/active-node-context.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { listConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

let testNodeHostCommands: NonNullable<
  ReturnType<typeof createEmptyPluginRegistry>["nodeHostCommands"]
> = [];
const activeTestRegistries = new Set<NodeRegistry>();

function createNodeRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]): NodeRegistry {
  const registry = new NodeRegistry(options);
  activeTestRegistries.add(registry);
  return registry;
}

afterEach(() => {
  for (const registry of activeTestRegistries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  activeTestRegistries.clear();
  testNodeHostCommands = [];
  setActiveNodeContext(null);
});

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

function registerNodeSession(
  registry: NodeRegistry,
  client: GatewayWsClient,
  opts: Partial<Parameters<NodeRegistry["register"]>[1]> = {},
) {
  const { pairingIdentity = "identity-a", ...registration } = opts;
  return registry.register(client, { ...registration, pairingIdentity });
}

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
  return createNodeRegistry({
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
  registerNodeSession(registry, makeClient("conn-1", "node-1", frames, opts), {});
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
  it("rejects registration without an authenticated pairing identity", () => {
    const registry = new NodeRegistry();
    const client = makeClient("conn-unbound", "node-unbound");

    expect(() => registry.register(client, {} as never)).toThrow(
      "node session registration requires pairing identity",
    );
    expect(registry.listConnected()).toEqual([]);
  });

  it("rejects dispatch through an invalidated node connection", async () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    const client = makeClient("conn-invalidated", "node-invalidated", frames);
    registerNodeSession(registry, client, {});
    client.invalidated = true;

    expect(registry.get("node-invalidated")).toBeUndefined();
    expect(registry.listConnected()).toEqual([]);
    expect(registry.sendEvent("node-invalidated", "node.test", { ok: true })).toBe(false);
    await expect(
      registry.invoke({ nodeId: "node-invalidated", command: "system.run" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PAIRING_CHANGED" },
    });
    expect(frames).toEqual([]);
  });

  it("rejects generation-mismatched lookup and dispatch without invalidating the session", async () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    const client = makeClient("conn-old-generation", "node-generation", frames);
    registerNodeSession(registry, client, { pairingGeneration: "generation-a" });

    expect(registry.getForPairingGeneration("node-generation", "generation-b")).toBeUndefined();
    expect(client.invalidated).not.toBe(true);
    await expect(
      registry.invoke({
        nodeId: "node-generation",
        expectedPairingGeneration: "generation-b",
        command: "system.run",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PAIRING_CHANGED" },
    });
    expect(client.invalidated).not.toBe(true);
    expect(frames).toEqual([]);
  });

  it("does not let a stale operation invalidate the valid replacement generation", () => {
    const registry = new NodeRegistry();
    const frames: string[] = [];
    const replacement = makeClient("conn-replacement", "node-replaced", frames);
    registerNodeSession(registry, replacement, { pairingGeneration: "generation-b" });

    expect(registry.getForPairingGeneration("node-replaced", "generation-a")).toBeUndefined();
    expect(replacement.invalidated).not.toBe(true);
    expect(registry.getForPairingGeneration("node-replaced", "generation-b")?.connId).toBe(
      "conn-replacement",
    );
  });

  it("revalidates the persistent generation immediately before dispatch", async () => {
    const frames: string[] = [];
    const resolveCurrentPairingState = vi.fn().mockResolvedValue({
      identity: "identity-a",
      generation: "generation-b",
    });
    const registry = new NodeRegistry({ resolveCurrentPairingState });
    const client = makeClient("conn-generation", "node-generation", frames);
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    await expect(
      registry.invoke({
        nodeId: "node-generation",
        expectedConnId: "conn-generation",
        expectedPairingGeneration: "generation-a",
        command: "system.run",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PAIRING_CHANGED" },
    });
    expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-generation");
    expect(frames).toEqual([]);
  });

  it("revalidates persistent generation ownership for inbound node RPCs", async () => {
    const resolveCurrentPairingState = vi.fn().mockResolvedValue({
      identity: "identity-a",
      generation: "generation-a",
    });
    const registry = createNodeRegistry({ resolveCurrentPairingState });
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    await expect(registry.isConnectionCurrentPairingState("conn-generation")).resolves.toBe(true);
    resolveCurrentPairingState.mockResolvedValue({
      identity: "identity-a",
      generation: "generation-b",
    });
    await expect(registry.isConnectionCurrentPairingState("conn-generation")).resolves.toBe(false);
    expect(client.invalidated).toBe(true);
    expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-generation");
  });

  it("removes an externally replaced session from connected and active projections", async () => {
    let currentPairingGeneration = "generation-a";
    const onPairingInvalidated = vi.fn();
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => ({
        identity: "identity-a",
        generation: currentPairingGeneration,
      }),
      onPairingInvalidated,
    });
    const client = makeClient("conn-generation", "node-generation", [], {
      permissions: { accessibility: true },
    });
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    registry.updatePresenceActivity({
      nodeId: "node-generation",
      connId: "conn-generation",
      idleSeconds: 0,
    });
    expect(registry.getActiveNode()?.nodeId).toBe("node-generation");

    currentPairingGeneration = "generation-b";
    await expect(registry.listCurrentConnected()).resolves.toEqual([]);
    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
    expect(client.invalidated).toBe(true);
    expect(onPairingInvalidated).toHaveBeenCalledWith({
      nodeId: "node-generation",
      connId: "conn-generation",
    });
  });

  it("does not invalidate a session promoted while persistent generation is loading", async () => {
    let resolveLookup: ((value: { identity: string; generation: string }) => void) | undefined;
    const resolveCurrentPairingState = vi.fn(
      () =>
        new Promise<{ identity: string; generation: string }>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const onPairingInvalidated = vi.fn();
    const registry = createNodeRegistry({
      resolveCurrentPairingState,
      onPairingInvalidated,
    });
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    const connected = registry.listCurrentConnected();
    expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-generation");
    expect(
      registry.updateSurface(
        "node-generation",
        { commands: [] },
        {
          expectedConnId: "conn-generation",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    resolveLookup?.({ identity: "identity-a", generation: "generation-a" });

    await expect(connected).resolves.toEqual([]);
    expect(registry.get("node-generation")?.pairingGeneration).toBe("generation-b");
    expect(client.invalidated).not.toBe(true);
    expect(onPairingInvalidated).not.toHaveBeenCalled();
  });

  it("revalidates the active node at the prompt projection boundary", () => {
    let currentPairingGeneration = "generation-a";
    const registry = createNodeRegistry({
      isPairingStateCurrent: (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    });
    registerNodeSession(
      registry,
      makeClient("conn-generation", "node-generation", [], {
        permissions: { accessibility: true },
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    registry.updatePresenceActivity({
      nodeId: "node-generation",
      connId: "conn-generation",
      idleSeconds: 0,
    });

    expect(getCurrentActiveNodeContext()).toMatchObject({
      nodeId: "node-generation",
      pairingGeneration: "generation-a",
    });
    currentPairingGeneration = "generation-b";
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("filters an already-loaded pairing snapshot without invalidating a newer session", () => {
    const registry = createNodeRegistry();
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-b",
      pairingGeneration: "generation-b",
    });

    expect(
      registry.listConnectedForPairingStates(
        new Map([["node-generation", { identity: "identity-a", generation: "generation-a" }]]),
      ),
    ).toEqual([]);
    expect(client.invalidated).not.toBe(true);
  });

  it("distinguishes a pending surface from a missing paired-device row", () => {
    const registry = createNodeRegistry();
    const client = makeClient("conn-pending-surface", "node-pending-surface");
    registerNodeSession(registry, client, { pairingIdentity: "identity-a" });

    expect(
      registry.listConnectedForPairingStates(
        new Map([["node-pending-surface", { identity: "identity-a" }]]),
      ),
    ).toHaveLength(1);
    expect(registry.listConnectedForPairingStates(new Map())).toEqual([]);
    expect(client.invalidated).not.toBe(true);
  });

  it("fails closed without invalidating a session when pairing persistence is unavailable", async () => {
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => {
        throw new Error("pairing store unavailable");
      },
    });
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    await expect(registry.listCurrentConnected()).resolves.toEqual([]);
    expect(client.invalidated).not.toBe(true);
    expect(registry.listConnected()).toHaveLength(1);
  });

  it("reconciles stale persistent generations synchronously for prompt projections", () => {
    let currentPairingGeneration = "generation-a";
    const onPairingInvalidated = vi.fn();
    const registry = createNodeRegistry({
      isPairingStateCurrent: (_nodeId, expected) =>
        expected.generation === currentPairingGeneration,
      onPairingInvalidated,
    });
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, { pairingGeneration: "generation-a" });

    expect(registry.listCurrentConnectedSync()).toHaveLength(1);
    currentPairingGeneration = "generation-b";
    expect(registry.listCurrentConnectedSync()).toEqual([]);
    expect(client.invalidated).toBe(true);
    expect(onPairingInvalidated).toHaveBeenCalledWith({
      nodeId: "node-generation",
      connId: "conn-generation",
    });
  });

  it("fails closed synchronously when pairing persistence is unavailable", () => {
    const registry = createNodeRegistry({
      isPairingStateCurrent: () => {
        throw new Error("pairing store unavailable");
      },
    });
    const client = makeClient("conn-generation", "node-generation");
    registerNodeSession(registry, client, { pairingGeneration: "generation-a" });

    expect(registry.listCurrentConnectedSync()).toEqual([]);
    expect(client.invalidated).not.toBe(true);
    expect(registry.listConnected()).toHaveLength(1);
  });

  it("invalidates a generation-less session after external pairing deletion", async () => {
    let currentPairingState: { identity: string } | undefined = { identity: "identity-a" };
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => currentPairingState,
    });
    const client = makeClient("conn-pending-surface", "node-pending-surface");
    registerNodeSession(registry, client, { pairingIdentity: "identity-a" });

    await expect(registry.listCurrentConnected()).resolves.toHaveLength(1);
    currentPairingState = undefined;
    await expect(registry.listCurrentConnected()).resolves.toEqual([]);
    expect(client.invalidated).toBe(true);
  });

  it("invalidates a generation-less session synchronously after pairing deletion", () => {
    let pairingExists = true;
    const registry = createNodeRegistry({
      isPairingStateCurrent: (_nodeId, expected) =>
        pairingExists && expected.identity === "identity-a",
    });
    const client = makeClient("conn-pending-surface", "node-pending-surface");
    registerNodeSession(registry, client, { pairingIdentity: "identity-a" });

    expect(registry.listCurrentConnectedSync()).toHaveLength(1);
    pairingExists = false;
    expect(registry.listCurrentConnectedSync()).toEqual([]);
    expect(client.invalidated).toBe(true);
  });

  it("routes ordered input to the pending invoke connection and rejects unknown invokes", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "codex.terminal.resume.v1",
      timeoutMs: 0,
      signal: controller.signal,
      onProgress: () => {},
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    registry.sendInvokeInput(invokeId, { kind: "data", data: "a" });
    registry.sendInvokeInput(invokeId, { kind: "resize", cols: 90, rows: 30 });
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: {
        id: invokeId,
        nodeId: "node-1",
        seq: 0,
        payloadJSON: JSON.stringify({ kind: "data", data: "a" }),
      },
    });
    expect(JSON.parse(frames[2] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: { id: invokeId, nodeId: "node-1", seq: 1 },
    });
    expect(() => registry.sendInvokeInput("missing", { kind: "data", data: "x" })).toThrow(
      "node invoke is not pending",
    );

    controller.abort();
    await expect(invoke).resolves.toMatchObject({ ok: false, error: { code: "ABORTED" } });
  });

  it("rejects node invoke input above 16 KiB", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "codex.terminal.resume.v1",
      timeoutMs: 0,
      signal: controller.signal,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(() =>
      registry.sendInvokeInput(request.payload?.id ?? "", {
        kind: "data",
        data: "x".repeat(17 * 1024),
      }),
    ).toThrow("exceeds 16 KiB");
    controller.abort();
    await invoke;
  });

  it("rejects node invoke input that cannot be serialized", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "codex.terminal.resume.v1",
      timeoutMs: 0,
      signal: controller.signal,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

    expect(() => registry.sendInvokeInput(request.payload?.id ?? "", undefined)).toThrow(
      "node invoke input is not serializable",
    );
    controller.abort();
    await invoke;
  });

  it("ranks connected nodes by gateway-derived input activity", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        displayName: "Desk Mac",
        permissions: { accessibility: true },
      }),
      {},
    );
    registerNodeSession(
      registry,
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
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-2" });
    expect(registry.unregister("conn-2")).toBe("node-2");
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-1" });
  });

  it("recomputes active context when a same-id connection replaces reported presence", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-old", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-old",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
    expect(registry.unregister("conn-old")).toBeNull();
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("rejects presence updates from stale node connections", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
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
    registerNodeSession(
      registry,
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
    registerNodeSession(
      registry,
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
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("clears presence only for the current connection and selects the next active Mac", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registerNodeSession(
      registry,
      makeClient("conn-2", "node-2", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 10,
      observedAtMs: 100_000,
    });
    registry.updatePresenceActivity({
      nodeId: "node-2",
      connId: "conn-2",
      idleSeconds: 0,
      observedAtMs: 105_000,
    });

    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-old" })).toBeNull();
    expect(registry.getActiveNode()?.nodeId).toBe("node-2");
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(true);
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-1" });
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(false);
  });

  it("checks node websocket connectivity with ping/pong", async () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        socket: makeConnectivitySocket(true),
      }),
      {},
    );

    await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({ ok: true });
  });

  it("reports stale node websocket connectivity before invoke timeout", async () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
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

    registerNodeSession(registry, makeClient("conn-old", "node-1", oldFrames), {});
    const oldInvoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 1_000,
    });
    const oldDisconnected = oldInvoke.catch((err: unknown) => err);
    const oldRequest = JSON.parse(oldFrames[0] ?? "{}") as { payload?: { id?: string } };
    const newSession = registerNodeSession(registry, newClient, {});

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
    const registry = createNodeRegistry();
    const replacementFrames: string[] = [];
    registerNodeSession(registry, makeClient("conn-old", "node-1"), {});
    registerNodeSession(registry, makeClient("conn-new", "node-1", replacementFrames), {});

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
    const registry = createNodeRegistry();
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

  it("forwards the agent session that owns a stateful node invoke", async () => {
    const registry = createNodeRegistry();
    const frames = registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 0,
      sessionKey: "agent:main:canvas",
    });
    const request = JSON.parse(frames[0] ?? "{}") as {
      payload?: { id?: string; sessionKey?: string };
    };

    expect(request.payload?.sessionKey).toBe("agent:main:canvas");
    expect(
      registry.handleInvokeResult({
        id: request.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
      }),
    ).toBe(true);
    await expect(invoke).resolves.toMatchObject({ ok: true });
  });

  it("rejects zero-timeout invokes when the node disconnects", async () => {
    const registry = createNodeRegistry();
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

  it("orders streamed invoke progress and drops state after the final result", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const chunks: string[] = [];
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
      onProgress: (chunk) => chunks.push(chunk),
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 1,
        chunk: "second",
      }),
    ).toBe(true);
    expect(chunks).toEqual([]);
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "first",
      }),
    ).toBe(true);
    expect(chunks).toEqual(["first", "second"]);
    expect(
      registry.handleInvokeResult({
        id: invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
      }),
    ).toBe(true);
    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 2,
        chunk: "late",
      }),
    ).toBe(false);
  });

  it("rejects duplicate buffered progress frames without resetting the idle deadline", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "agent.cli.claude.run.v1",
        timeoutMs: 10_000,
        idleTimeoutMs: 50,
        onProgress: () => {},
      });
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      const invokeId = request.payload?.id ?? "";
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 0,
          chunk: "start",
        }),
      ).toBe(true);
      // seq 2 buffers behind the missing seq 1; replaying it forever must not
      // extend the idle deadline, or a stalled sender could suppress it.
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 2,
          chunk: "gap",
        }),
      ).toBe(true);
      for (let round = 0; round < 3; round += 1) {
        await vi.advanceTimersByTimeAsync(20);
        expect(
          registry.handleInvokeProgress({
            invokeId,
            nodeId: "node-1",
            connId: "conn-1",
            seq: 2,
            chunk: "gap",
          }),
        ).toBe(false);
      }
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds future progress behind a permanent sequence gap until idle teardown", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "agent.cli.claude.run.v1",
        timeoutMs: 10_000,
        idleTimeoutMs: 50,
        onProgress: () => {},
      });
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      const invokeId = request.payload?.id ?? "";
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 0,
          chunk: "start",
        }),
      ).toBe(true);

      for (let seq = 2; seq < 130; seq += 1) {
        expect(
          registry.handleInvokeProgress({
            invokeId,
            nodeId: "node-1",
            connId: "conn-1",
            seq,
            chunk: `future-${seq}`,
          }),
        ).toBe(true);
      }
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 130,
          chunk: "over-cap",
        }),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops draining buffered progress once onProgress aborts the invoke", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const abortController = new AbortController();
    const chunks: string[] = [];
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
      signal: abortController.signal,
      onProgress: (chunk) => {
        chunks.push(chunk);
        abortController.abort();
      },
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 1,
        chunk: "buffered",
      }),
    ).toBe(true);
    // seq 0 drains and aborts the invoke; the buffered seq 1 must not reach
    // the consumer after cancellation.
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "first",
      }),
    ).toBe(true);
    expect(chunks).toEqual(["first"]);
    await expect(invoke).resolves.toEqual({
      ok: false,
      error: { code: "ABORTED", message: "node invoke cancelled" },
    });
  });

  it("resets streamed invoke idle timeout on progress", async () => {
    vi.useFakeTimers();
    const registry = new NodeRegistry();
    try {
      const frames = registerNode(registry);
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "agent.cli.claude.run.v1",
        timeoutMs: 1_000,
        idleTimeoutMs: 50,
        onProgress: () => {},
      });
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
      const invokeId = request.payload?.id ?? "";

      // Approval can outlive the idle window; inactivity starts with execution progress.
      await vi.advanceTimersByTimeAsync(200);
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 0,
          chunk: "still running",
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(40);
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 1,
          chunk: "still running",
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(51);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans streamed invoke state when the node disconnects", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
      onProgress: () => {},
    });
    const disconnected = invoke.catch((error: unknown) => error);
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    expect(registry.unregister("conn-1")).toBe("node-1");
    await expect(disconnected).resolves.toBeInstanceOf(Error);
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "late",
      }),
    ).toBe(false);
  });

  it("forwards cancellation and drops streamed invoke state", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
      onProgress: () => {},
      signal: controller.signal,
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    controller.abort();

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: { code: "ABORTED", message: "node invoke cancelled" },
    });
    const cancel = JSON.parse(frames[1] ?? "{}") as {
      event?: string;
      payload?: { invokeId?: string; nodeId?: string };
    };
    expect(cancel).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId, nodeId: "node-1" },
    });
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "late",
      }),
    ).toBe(false);
  });

  it("cancels the node when a streamed progress consumer fails", async () => {
    const registry = new NodeRegistry();
    const frames = registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      onProgress: () => {
        throw new Error("parser failed");
      },
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "bad jsonl",
      }),
    ).toBe(true);
    await expect(invoke).rejects.toThrow("parser failed");
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId, nodeId: "node-1" },
    });
  });

  it("returns a structured unavailable result when a node disconnects during an MCP call", async () => {
    const registry = createNodeRegistry();
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
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {});
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

  it("drops a delayed voice-wake snapshot after persistent generation changes", async () => {
    let resolveCurrent!: (state: { identity: string; generation?: string } | undefined) => void;
    const currentPairingState = new Promise<{ identity: string; generation?: string } | undefined>(
      (resolve) => {
        resolveCurrent = resolve;
      },
    );
    const resolveCurrentPairingState = vi.fn(() => currentPairingState);
    const registry = createNodeRegistry({ resolveCurrentPairingState });
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    const send = registry.sendEventRawForPairingGeneration(
      "node-1",
      "generation-a",
      "voicewake.changed",
      serializeEventPayload({ triggers: ["openclaw"] }),
    );
    await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledTimes(1));
    resolveCurrent({ identity: "identity-a", generation: "generation-b" });

    await expect(send).resolves.toBe(false);
    expect(frames).toEqual([]);
  });

  it("drops a delayed command-free snapshot after pairing identity deletion", async () => {
    let resolveCurrent!: (state: { identity: string } | undefined) => void;
    const currentPairingState = new Promise<{ identity: string } | undefined>((resolve) => {
      resolveCurrent = resolve;
    });
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => await currentPairingState,
    });
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
      pairingIdentity: "identity-a",
    });

    const send = registry.sendEventForPairingIdentity({
      nodeId: "node-1",
      connId: "conn-1",
      pairingIdentity: "identity-a",
      event: "voicewake.changed",
      payload: { triggers: ["openclaw"] },
    });
    resolveCurrent(undefined);

    await expect(send).resolves.toBe(false);
    expect(frames).toEqual([]);
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
    registerNodeSession(
      registry,
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

    const session = registerNodeSession(registry, client, {});
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

  it("advances the exact live session with its approved surface generation", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      declaredCommands: ["device.info"],
    });
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });

    const updated = registry.updateSurface(
      "node-1",
      { commands: ["device.info"] },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-a",
        expectedPairingGeneration: "generation-a",
        nextPairingGeneration: "generation-b",
      },
    );

    expect(updated?.pairingGeneration).toBe("generation-b");
    expect(
      registry.updateSurface(
        "node-1",
        { commands: [] },
        {
          expectedConnId: "conn-stale",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-c",
        },
      ),
    ).toBeNull();
    expect(registry.get("node-1")?.commands).toEqual(["device.info"]);
    expect(registry.get("node-1")?.pairingGeneration).toBe("generation-b");
  });

  it("rebinds active-node presence when a live session advances generations", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      permissions: { accessibility: true },
      declaredPermissions: { accessibility: true },
    });
    registerNodeSession(registry, client, {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registry.updateSurface(
      "node-1",
      { commands: [], permissions: { accessibility: true } },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-a",
        expectedPairingGeneration: "generation-a",
        nextPairingGeneration: "generation-b",
      },
    );

    expect(getCurrentActiveNodeContext()).toMatchObject({
      nodeId: "node-1",
      pairingGeneration: "generation-b",
    });
  });

  it("does not promote a generation-less session from a retired pairing identity", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      declaredCommands: ["device.info"],
    });
    registerNodeSession(registry, client, { pairingIdentity: "identity-a" });

    expect(
      registry.updateSurface(
        "node-1",
        { commands: ["device.info"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-b",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).toBeNull();
    expect(registry.get("node-1")).toMatchObject({
      pairingIdentity: "identity-a",
      commands: [],
    });
    expect(registry.get("node-1")?.pairingGeneration).toBeUndefined();
  });

  it("keeps node-hosted plugin tools inside the approved command surface", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: ["demo.echo"],
    });

    const session = registerNodeSession(registry, client, {});
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

  it("retires node-hosted plugin tools immediately when a connection is invalidated", () => {
    registerDemoNodePluginTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], { commands: ["demo.echo"] });
    registerNodeSession(registry, client, {});
    publishNodePluginTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the node",
        command: "demo.echo",
      },
    ]);
    expect(listConnectedNodePluginTools()).toHaveLength(1);

    expect(registry.invalidateConnectionForPairingChange("conn-1", "device-token-revoked")).toBe(
      true,
    );

    expect(client.invalidated).toBe(true);
    expect(client.invalidatedReason).toBe("device-token-revoked");
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

    const session = registerNodeSession(registry, client, {});
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

    const session = registerNodeSession(registry, client, {});
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

    const session = registerNodeSession(registry, client, {});
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

    const session = registerNodeSession(registry, client, {});
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

    const session = registerNodeSession(registry, client, {});
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
    registerNodeSession(
      registry,
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
    const registry = createNodeRegistry({ nodePluginToolsEnabled: false });
    registerNodeSession(
      registry,
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
    registerNodeSession(
      registry,
      makeClient("conn-old", "node-1", [], {
        commands: ["demo.echo"],
      }),
      {},
    );
    registerNodeSession(
      registry,
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
    const session = registerNodeSession(registry, makeClient("conn-1", "node-1"), {});

    const updated = publishNodeSkills(registry, [
      nodeSkill("release-helper"),
      { ...nodeSkill("broken"), content: "x".repeat(64 * 1024 + 1) },
    ]);

    expect(updated).toBe(session);
    expect(session.nodeSkills.map((skill) => skill.name)).toEqual(["release-helper"]);
  });

  it("enforces node skill count and total-content caps", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(registry, makeClient("conn-1", "node-1"), {});

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
    const disabled = createNodeRegistry({ nodeSkillsEnabled: false });
    registerNodeSession(disabled, makeClient("conn-1", "node-1"), {});
    expect(publishNodeSkills(disabled, [nodeSkill("disabled")])?.nodeSkills).toEqual([]);

    const registry = createTestNodeRegistry();
    registerNodeSession(registry, makeClient("conn-old", "node-1"), {});
    registerNodeSession(registry, makeClient("conn-new", "node-1"), {});
    expect(publishNodeSkills(registry, [nodeSkill("stale")], "conn-old")).toBeNull();
    expect(registry.get("node-1")?.nodeSkills).toEqual([]);
  });

  it("clears effective permissions when explicitly removed", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      permissions: { camera: false },
      declaredPermissions: { camera: false },
    });

    registerNodeSession(registry, client, {});
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
    const registry = createNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["canvas", "device"],
      declaredCommands: ["canvas.snapshot", "device.info"],
      sessionCapsCeiling: ["device"],
      sessionCommandsCeiling: ["device.info"],
    });

    registerNodeSession(registry, client, {});
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
