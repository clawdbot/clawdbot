/**
 * Gateway node registry tests.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getCurrentActiveNodeContext, setActiveNodeContext } from "../infra/active-node-context.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_PRIVATE_COMMANDS,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { listConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import {
  createNodeRegistryRuntime,
  isNodeRunnerSessionHost,
  setNodeRunnerStateChangedListener,
  updateNodeRunnerInventory,
} from "./node-registry-private.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

let testNodeHostCommands: NonNullable<
  ReturnType<typeof createEmptyPluginRegistry>["nodeHostCommands"]
> = [];
const activeTestRegistries = new Set<NodeRegistry>();

type TestNodeSocket = {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const NON_OPEN_NODE_SOCKET_STATES = [
  { state: "connecting", readyState: WebSocket.CONNECTING },
  { state: "closing", readyState: WebSocket.CLOSING },
  { state: "closed", readyState: WebSocket.CLOSED },
];

function createTestNodeSocket(
  sent: string[] = [],
  readyState: TestNodeSocket["readyState"] = WebSocket.OPEN,
): TestNodeSocket {
  return {
    readyState,
    bufferedAmount: 0,
    send: vi.fn((frame: unknown) => {
      if (typeof frame === "string") {
        sent.push(frame);
      }
    }),
    close: vi.fn(),
  };
}

function createNodeRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]): NodeRegistry {
  const registry = new NodeRegistry(options);
  activeTestRegistries.add(registry);
  return registry;
}

function createPrivateNodeRegistryRuntime(options?: ConstructorParameters<typeof NodeRegistry>[0]) {
  const runtime = createNodeRegistryRuntime(() => new NodeRegistry(options));
  activeTestRegistries.add(runtime.nodeRegistry);
  return runtime;
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
    computerUse?: unknown;
    declaredComputerUse?: unknown;
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
    socket: opts.socket ?? (createTestNodeSocket(sent) as unknown as GatewayWsClient["socket"]),
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
      computerUse: opts.computerUse,
      declaredComputerUse: opts.declaredComputerUse,
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

function registerTestNodeSocket(
  registry: NodeRegistry,
  socket: TestNodeSocket,
  sent: string[] = [],
) {
  return registerNodeSession(
    registry,
    makeClient("conn-1", "node-1", sent, {
      socket: socket as unknown as GatewayWsClient["socket"],
    }),
  );
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

function registerPairingWait() {
  const pairing = createDeferred<{ identity: string; generation: string }>();
  const registry = createNodeRegistry({ resolveCurrentPairingState: () => pairing.promise });
  const frames: string[] = [];
  registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
    pairingGeneration: "generation-a",
  });
  return {
    registry,
    frames,
    release: () => pairing.resolve({ identity: "identity-a", generation: "generation-a" }),
  };
}

function startStreamingNodeInvoke(
  registry: NodeRegistry,
  options: {
    timeoutMs: number;
    idleTimeoutMs: number;
    onProgress: (chunk: string) => void;
  },
) {
  const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });
  const invoke = registry.invoke({
    nodeId: "node-1",
    command: "agent.cli.claude.run.v1",
    ...options,
  });
  const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
  return { frames, invoke, invokeId: request.payload?.id ?? "" };
}

function expectSingleNodeInvokeCancellation(frames: string[], invokeId: string): void {
  const cancellations = frames
    .map((frame) => JSON.parse(frame) as { event?: string })
    .filter((frame) => frame.event === "node.invoke.cancel");
  expect(cancellations).toEqual([
    expect.objectContaining({ payload: { invokeId, nodeId: "node-1" } }),
  ]);
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

function computerUseDescriptor() {
  return {
    contractVersion: 2 as const,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions: ["screenshot", "left_click"] as const,
    targets: ["screen"] as const,
    deliveryModes: ["foreground"] as const,
    observations: ["image"] as const,
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
}

describe("gateway/node-registry", () => {
  it("retains the validated Computer Use declaration on the live session", () => {
    const registry = createNodeRegistry();
    const computerUse = computerUseDescriptor();
    const client = makeClient("conn-computer", "node-computer", [], {
      commands: ["screen.snapshot", "computer.act"],
      computerUse,
    });

    registerNodeSession(registry, client, {});

    expect(registry.get("node-computer")?.computerUse).toEqual(computerUse);
  });

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

  it.each(NODE_WORKER_PRIVATE_COMMANDS)(
    "rejects private command %s through the generic invoke surface",
    async (command) => {
      const registry = createNodeRegistry();
      const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });

      await expect(registry.invoke({ nodeId: "node-1", command })).resolves.toEqual({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "private node command is not invocable" },
      });
      expect(frames).toEqual([]);
    },
  );

  it("does not expose the unchecked invoke core through registry reflection", () => {
    const registry = createNodeRegistry();

    expect(Reflect.ownKeys(registry)).not.toContain("invokeCore");
    expect(Reflect.ownKeys(Object.getPrototypeOf(registry))).not.toContain("invokeCore");
  });

  it("binds the private dialect to the exact connection generation", async () => {
    let currentGeneration = "generation-a";
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime({
      resolveCurrentPairingState: async () => ({
        identity: "identity-a",
        generation: currentGeneration,
      }),
    });
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );

    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "identity-a",
        pairingGeneration: "generation-a",
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        commands: ["system.run"],
      }),
    ]);
    expect(nodeRegistry.get("node-1")).not.toHaveProperty("protocolFeatures");
    expect(
      isNodeRunnerSessionHost({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-a",
      }),
    ).toBe(true);

    currentGeneration = "generation-b";
    expect(
      nodeRegistry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    expect(
      isNodeRunnerSessionHost({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-b",
      }),
    ).toBe(false);
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({ pairingGeneration: "generation-b" }),
    ]);

    registerNodeSession(
      nodeRegistry,
      makeClient("conn-2", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-b" },
    );
    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toBeNull();
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-2",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    await expect(nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        connId: "conn-2",
        pairingGeneration: "generation-b",
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      }),
    ]);
  });

  it("publishes current-runner edges once across disconnect, reconnect, and replacement", () => {
    const runnerStateChanged = vi.fn();
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime();
    setNodeRunnerStateChangedListener(nodeRegistry, runnerStateChanged);
    const publish = (connId: string) =>
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      });
    const register = (connId: string) =>
      registerNodeSession(
        nodeRegistry,
        makeClient(connId, "node-1", [], {
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          commands: ["system.run"],
        }),
        { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
      );

    register("conn-1");
    expect(publish("conn-1")).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenLastCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    expect(nodeRegistry.unregister("conn-1")).toBe("node-1");
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
    expect(nodeWorkerSupervisorTransport.hasCurrentRunner("node-1")).toBe(false);

    runnerStateChanged.mockClear();
    register("conn-2");
    expect(runnerStateChanged).not.toHaveBeenCalled();
    expect(publish("conn-2")).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    register("conn-3");
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
    expect(nodeWorkerSupervisorTransport.hasCurrentRunner("node-1")).toBe(false);

    runnerStateChanged.mockClear();
    expect(nodeRegistry.unregister("conn-2")).toBeNull();
    expect(runnerStateChanged).not.toHaveBeenCalled();
    expect(publish("conn-3")).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
  });

  it("separates inventory topology from availability across proof mutations", async () => {
    const runnerStateChanged = vi.fn();
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime();
    setNodeRunnerStateChangedListener(nodeRegistry, runnerStateChanged);
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const publish = (workerHost: {
      enabled: true;
      capacity: { total: number; available: number };
      bundleRetention?: 1;
      bundleStatus?: 1;
    }) =>
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost,
        },
      });
    const retained = {
      enabled: true as const,
      capacity: { total: 2, available: 2 },
      bundleRetention: 1 as const,
      bundleStatus: 1 as const,
    };

    expect(publish(retained)).toEqual({ changed: true });
    runnerStateChanged.mockClear();
    expect(publish({ ...retained, capacity: { total: 2, available: 0 } })).toEqual({
      changed: true,
    });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(nodeWorkerSupervisorTransport.hasCurrentRunner("node-1")).toBe(true);

    runnerStateChanged.mockClear();
    expect(publish({ ...retained, capacity: { total: 2, available: 0 } })).toEqual({
      changed: false,
    });
    expect(runnerStateChanged).not.toHaveBeenCalled();

    const [proof] = await nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current runner proof");
    }
    expect(
      nodeWorkerSupervisorTransport.acceptBundleStatus?.(proof, {
        bundleHash: "a".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(true);
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });

    runnerStateChanged.mockClear();
    expect(
      nodeRegistry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    expect(publish(retained)).toEqual({ changed: true });
    runnerStateChanged.mockClear();
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: false },
        },
      }),
    ).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: { protocolFeatures: [] },
      }),
    ).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
  });

  it("publishes one availability edge when pairing invalidation retires a current runner", () => {
    const runnerStateChanged = vi.fn();
    const { nodeRegistry } = createPrivateNodeRegistryRuntime();
    setNodeRunnerStateChangedListener(nodeRegistry, runnerStateChanged);
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    runnerStateChanged.mockClear();

    expect(nodeRegistry.invalidateConnectionForPairingChange("conn-1")).toBe(true);
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
  });

  it("keeps status proof current across capacity changes while fencing launches", async () => {
    const frames: string[] = [];
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime();
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", frames, {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    const [proof] = await nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current supervisor proof");
    }
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 0 } },
        },
      }),
    ).toEqual({ changed: true });
    expect(
      isNodeRunnerSessionHost({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        pairingGeneration: "generation-a",
      }),
    ).toBe(true);

    const workspaceInvoke = nodeWorkerSupervisorTransport.invoke({
      node: proof,
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      isDispatchAuthorized: () => true,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(
      nodeRegistry.handleInvokeResult({
        id: request.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
        payloadJSON: "null",
      }),
    ).toBe(true);
    await expect(workspaceInvoke).resolves.toMatchObject({ ok: true, payloadJSON: "null" });

    await expect(
      nodeWorkerSupervisorTransport.invoke({
        node: proof,
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PRIVATE_DIALECT_UNAVAILABLE" },
    });
  });

  it("fences retained proofs when runner consent is disabled", async () => {
    const frames: string[] = [];
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime();
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", frames, {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        },
      }),
    ).toEqual({ changed: true });
    const [proof] = await nodeWorkerSupervisorTransport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current supervisor proof");
    }
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: false },
        },
      }),
    ).toEqual({ changed: true });

    await expect(
      nodeWorkerSupervisorTransport.invoke({
        node: proof,
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "PRIVATE_DIALECT_UNAVAILABLE",
        message: "node worker supervisor dialect is unavailable",
      },
    });
    expect(frames).toEqual([]);
  });

  it("promotes bundle prewarm without changing runner authority", async () => {
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createPrivateNodeRegistryRuntime();
    registerNodeSession(
      nodeRegistry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const declaration = {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE] as const,
      workerHost: { enabled: true, capacity: { total: 2, available: 2 } as const },
    };
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration,
      }),
    ).toEqual({ changed: true });
    const [priorProof] = await nodeWorkerSupervisorTransport.listCurrentNodes();

    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: {
          ...declaration,
          workerHost: { ...declaration.workerHost, bundlePrewarm: 1 },
        },
      }),
    ).toEqual({ changed: true });
    const [negotiatedProof] = await nodeWorkerSupervisorTransport.listCurrentNodes();

    expect(priorProof && nodeWorkerSupervisorTransport.isCurrent(priorProof, true)).toBe(true);
    expect(negotiatedProof?.workerHost).toEqual({
      enabled: true,
      capacity: { total: 2, available: 2 },
      bundlePrewarm: 1,
    });
    expect(
      priorProof && nodeWorkerSupervisorTransport.isCurrent(priorProof, true, ["system.run"]),
    ).toBe(true);
    expect(nodeRegistry.updateSurface("node-1", { commands: [] })).not.toBeNull();
    expect(priorProof && nodeWorkerSupervisorTransport.isCurrent(priorProof, true)).toBe(true);
    expect(
      priorProof && nodeWorkerSupervisorTransport.isCurrent(priorProof, true, ["system.run"]),
    ).toBe(false);
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

  it("does not dispatch when runtime authority closes during pairing resolution", async () => {
    let resolvePairing!: (state: { identity: string; generation: string }) => void;
    const resolveCurrentPairingState = vi.fn(
      () =>
        new Promise<{ identity: string; generation: string }>((resolve) => {
          resolvePairing = resolve;
        }),
    );
    const registry = createNodeRegistry({ resolveCurrentPairingState });
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-authority", "node-authority", frames), {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    let authorityActive = true;

    const invoke = registry.invoke({
      nodeId: "node-authority",
      expectedConnId: "conn-authority",
      expectedPairingGeneration: "generation-a",
      command: "system.run",
      isDispatchAuthorized: () => authorityActive,
    });
    await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledOnce());
    authorityActive = false;
    resolvePairing({ identity: "identity-a", generation: "generation-a" });

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "APPROVAL_AUTHORITY_CLOSED",
        message: "runtime authority closed before node dispatch",
      },
    });
    expect(frames).toEqual([]);
  });

  it("fails closed without dispatching when the pairing store is unavailable during invoke", async () => {
    const frames: string[] = [];
    const registry = createNodeRegistry({
      resolveCurrentPairingState: async () => {
        throw new Error("pairing store unavailable");
      },
    });
    registerNodeSession(registry, makeClient("conn-lease", "node-lease", frames), {
      pairingIdentity: "identity-a",
      pairingGeneration: "generation-a",
    });
    const isDispatchAuthorized = vi.fn(() => true);
    const onDispatchReady = vi.fn();

    await expect(
      registry.invoke({
        nodeId: "node-lease",
        expectedConnId: "conn-lease",
        expectedPairingGeneration: "generation-a",
        command: "system.which",
        isDispatchAuthorized,
        onDispatchReady,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UNAVAILABLE", message: "node pairing state unavailable before dispatch" },
    });
    expect(frames).toEqual([]);
    expect(isDispatchAuthorized).not.toHaveBeenCalled();
    expect(onDispatchReady).not.toHaveBeenCalled();
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

  it("does not advance streamed input sequence when the node websocket is closing", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    const socket = createTestNodeSocket(frames);
    registerTestNodeSocket(registry, socket, frames);
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

    socket.readyState = WebSocket.CLOSING;
    expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "lost" })).toThrow(
      "failed to send node invoke input",
    );
    expect(frames).toHaveLength(1);

    socket.readyState = WebSocket.OPEN;
    registry.sendInvokeInput(invokeId, { kind: "data", data: "delivered" });
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: {
        id: invokeId,
        nodeId: "node-1",
        seq: 0,
        payloadJSON: JSON.stringify({ kind: "data", data: "delivered" }),
      },
    });

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

  it("does not probe an invalidated node connection", async () => {
    const registry = createTestNodeRegistry();
    const socket = makeConnectivitySocket(true);
    const ping = vi.spyOn(socket, "ping");
    const client = makeClient("conn-invalidated", "node-1", [], { socket });
    registerNodeSession(registry, client, {});
    client.invalidated = true;

    await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "node not connected" },
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it("does not report an old websocket as connected after its node reconnects", async () => {
    const registry = createTestNodeRegistry();
    const oldSocket = makeConnectivitySocket(false);
    registerNodeSession(registry, makeClient("conn-old", "node-1", [], { socket: oldSocket }), {});

    const connectivity = registry.checkConnectivity("node-1", 50);
    const replacement = registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { socket: makeConnectivitySocket(true) }),
      {},
    );
    (oldSocket as unknown as EventEmitter).emit("pong");

    await expect(connectivity).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_CONNECTED",
        message: "node connection changed during connectivity probe",
      },
    });
    expect(registry.get("node-1")).toBe(replacement);
    await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({ ok: true });
  });

  it("does not report a replaced polling transport as connected", async () => {
    const registry = createTestNodeRegistry();
    let resolveProbe: ((result: { ok: true }) => void) | undefined;
    const transportProbe = new Promise<{ ok: true }>((resolve) => {
      resolveProbe = resolve;
    });
    registry.registerTransport(
      makeClient("conn-old", "node-1"),
      { pairingIdentity: "identity-a" },
      {
        send: () => true,
        sendRaw: () => true,
        checkConnectivity: () => transportProbe,
      },
    );

    const connectivity = registry.checkConnectivity("node-1", 50);
    const replacement = registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { socket: makeConnectivitySocket(true) }),
      {},
    );
    resolveProbe?.({ ok: true });

    await expect(connectivity).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_CONNECTED",
        message: "node connection changed during connectivity probe",
      },
    });
    expect(registry.get("node-1")).toBe(replacement);
  });

  it("keeps connectivity and invocations isolated across repeated node reconnects", async () => {
    const registry = createTestNodeRegistry();
    const makeTrackedSocket = (sent: string[]) => {
      const trackedSocket = makeConnectivitySocket(false);
      (trackedSocket as unknown as { send: (frame: unknown) => void }).send = (frame) => {
        if (typeof frame === "string") {
          sent.push(frame);
        }
      };
      return trackedSocket;
    };
    let frames: string[] = [];
    let socket = makeTrackedSocket(frames);
    registerNodeSession(registry, makeClient("conn-0", "node-1", frames, { socket }), {});

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const previousSocket = socket;
      const previousFrames = frames;
      const connectivity = registry.checkConnectivity("node-1", 1_000);
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "debug.ping",
        timeoutMs: 0,
      });
      const request = JSON.parse(previousFrames[0] ?? "{}") as {
        payload?: { id?: string };
      };
      expect(request.payload?.id).toEqual(expect.any(String));

      frames = [];
      socket = makeTrackedSocket(frames);
      const replacement = registerNodeSession(
        registry,
        makeClient(`conn-${attempt}`, "node-1", frames, { socket }),
        {},
      );
      (previousSocket as unknown as EventEmitter).emit("pong");

      await expect(connectivity).resolves.toEqual({
        ok: false,
        error: {
          code: "NOT_CONNECTED",
          message: "node connection changed during connectivity probe",
        },
      });
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: {
          code: "DISCONNECTED",
          message: "node disconnected (debug.ping)",
        },
      });
      expect(
        registry.handleInvokeResult({
          id: request.payload?.id ?? "",
          nodeId: "node-1",
          connId: `conn-${attempt - 1}`,
          ok: true,
        }),
      ).toBe(false);
      expect(registry.get("node-1")).toBe(replacement);
    }
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

  it("settles zero-timeout invokes when a node reconnects before its old connection closes", async () => {
    const registry = createTestNodeRegistry();
    const oldFrames: string[] = [];
    const newClient = makeClient("conn-new", "node-1");

    registerNodeSession(registry, makeClient("conn-old", "node-1", oldFrames), {});
    const oldInvoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 0,
    });
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
    await expect(oldInvoke).resolves.toEqual({
      ok: false,
      error: {
        code: "DISCONNECTED",
        message: "node disconnected (system.run)",
      },
    });
    expect(registry.get("node-1")).toBe(newSession);
    expect(registry.unregister("conn-old")).toBeNull();
    expect(registry.get("node-1")).toBe(newSession);
  });

  it("settles zero-timeout MCP calls without disconnecting the replacement node", async () => {
    const registry = createNodeRegistry();
    registerNodeSession(registry, makeClient("conn-old", "node-1"));
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "mcp.tools.call.v1",
      timeoutMs: 0,
    });

    const replacement = registerNodeSession(registry, makeClient("conn-new", "node-1"));

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "MCP_SERVER_UNAVAILABLE",
        message: "node host disconnected during MCP tool call",
      },
    });
    expect(registry.get("node-1")).toBe(replacement);
    expect(registry.unregister("conn-old")).toBeNull();
    expect(registry.get("node-1")).toBe(replacement);
  });

  it("rejects invoke when the node connection changed before dispatch", async () => {
    const registry = createNodeRegistry();
    const replacementFrames: string[] = [];
    const onDispatchReady = vi.fn();
    registerNodeSession(registry, makeClient("conn-old", "node-1"), {});
    registerNodeSession(registry, makeClient("conn-new", "node-1", replacementFrames), {});

    await expect(
      registry.invoke({
        nodeId: "node-1",
        expectedConnId: "conn-old",
        command: "system.run",
        onDispatchReady,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
    });
    expect(replacementFrames).toEqual([]);
    expect(onDispatchReady).not.toHaveBeenCalled();
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

  it.each(["browser.proxy", NODE_MCP_TOOLS_CALL_COMMAND, "demo.echo", "system.run"])(
    "bounds stalled pairing without dispatching an expired %s command",
    async (command) => {
      vi.useFakeTimers();
      const { registry, frames, release } = registerPairingWait();
      const onDispatchReady = vi.fn();
      let result: Awaited<ReturnType<NodeRegistry["invoke"]>> | undefined;
      const invoke = registry.invoke({
        nodeId: "node-1",
        command,
        timeoutMs: 100,
        onDispatchReady,
      });
      void invoke.then((value) => {
        result = value;
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(result).toEqual({
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        });
        expect(vi.getTimerCount()).toBe(0);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(frames).toEqual([]);
        expect(onDispatchReady).not.toHaveBeenCalled();
        expect(registry.get("node-1")?.connId).toBe("conn-1");
      } finally {
        release();
        await vi.advanceTimersByTimeAsync(100);
        vi.useRealTimers();
      }
    },
  );

  it("shares the invoke budget across pairing, serialization, and the pending response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { registry, frames, release } = registerPairingWait();
    const onDispatchReady = vi.fn();
    const runParams = { runId: "run-budget", timeoutMs: 5_000 };
    try {
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        timeoutMs: 100,
        params: {
          ...runParams,
          toJSON() {
            vi.setSystemTime(Date.now() + 10);
            return runParams;
          },
        },
        onDispatchReady,
      });
      await vi.advanceTimersByTimeAsync(60);
      release();
      await vi.advanceTimersByTimeAsync(0);
      const request = JSON.parse(frames[0] ?? "{}");
      expect(request.payload.timeoutMs).toBe(30);
      expect(JSON.parse(request.payload.paramsJSON).timeoutMs).toBe(5_000);
      expect(onDispatchReady).toHaveBeenCalledExactlyOnceWith(request.payload.id);
      await vi.advanceTimersByTimeAsync(30);
      await expect(invoke).resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
      expect(
        registry.handleInvokeResult({
          id: request.payload.id,
          nodeId: "node-1",
          connId: "conn-1",
          ok: true,
        }),
      ).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it.each(["deadline", "authority", "abort"])(
    "does not dispatch when serialization closes the %s",
    async (closed) => {
      vi.useFakeTimers();
      const registry = createNodeRegistry();
      const frames = registerNode(registry);
      const controller = new AbortController();
      let authorityActive = true;
      const onDispatchReady = vi.fn();
      try {
        const result = await registry.invoke({
          nodeId: "node-1",
          command: "browser.proxy",
          timeoutMs: 100,
          signal: controller.signal,
          isDispatchAuthorized: () => authorityActive,
          onDispatchReady,
          params: {
            toJSON() {
              if (closed === "deadline") {
                vi.setSystemTime(Date.now() + 100);
              }
              if (closed === "authority") {
                authorityActive = false;
              }
              if (closed === "abort") {
                controller.abort();
              }
              return {};
            },
          },
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code:
              closed === "deadline"
                ? "TIMEOUT"
                : closed === "authority"
                  ? "APPROVAL_AUTHORITY_CLOSED"
                  : "ABORTED",
          },
        });
        expect(frames).toEqual([]);
        expect(onDispatchReady).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.5])(
    "preserves the post-pairing timeout contract for %s",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const { registry, frames, release } = registerPairingWait();
      try {
        const invoke = registry.invoke({ nodeId: "node-1", command: "demo.echo", timeoutMs });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(frames).toEqual([]);
        release();
        await vi.advanceTimersByTimeAsync(0);
        const request = JSON.parse(frames[0] ?? "{}");
        const fallback = timeoutMs === undefined || !Number.isFinite(timeoutMs);
        expect(request.payload.timeoutMs).toBe(fallback ? 30_000 : 0);
        expect(
          registry.handleInvokeResult({
            id: request.payload.id,
            nodeId: "node-1",
            connId: "conn-1",
            ok: true,
          }),
        ).toBe(true);
        await expect(invoke).resolves.toMatchObject({ ok: true });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
        vi.useRealTimers();
      }
    },
  );

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

  it("fails closed without dispatching system.which to a closing node websocket", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    const socket = createTestNodeSocket(frames, WebSocket.CLOSING);
    registerTestNodeSocket(registry, socket, frames);
    const onDispatchReady = vi.fn();

    await expect(
      registry.invoke({
        nodeId: "node-1",
        command: "system.which",
        timeoutMs: 0,
        onDispatchReady,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
    });
    expect(socket.send).not.toHaveBeenCalled();
    expect(onDispatchReady).not.toHaveBeenCalled();
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

  it("returns a structured result when a zero-timeout invoke disconnects", async () => {
    const registry = createNodeRegistry();
    registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 0,
    });

    expect(registry.unregister("conn-1")).toBe("node-1");
    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "DISCONNECTED",
        message: "node disconnected (debug.ping)",
      },
    });
  });

  it("accepts results before the hard deadline and times out results at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    const frames = registerNode(registry);
    const beforeDispatch = vi.fn();

    const beforeDeadline = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 100,
      onDispatchReady: beforeDispatch,
    });
    const beforeRequest = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    vi.setSystemTime(1_099);
    expect(
      registry.handleInvokeResult({
        id: beforeRequest.payload?.id ?? "",
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
      }),
    ).toBe(true);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    await expect(beforeDeadline).resolves.toMatchObject({ ok: true });

    vi.setSystemTime(2_000);
    const atDeadline = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 100,
    });
    const atRequest = JSON.parse(frames[1] ?? "{}") as { payload?: { id?: string } };
    vi.setSystemTime(2_100);
    const terminalResult = {
      id: atRequest.payload?.id ?? "",
      nodeId: "node-1",
      connId: "conn-1",
      ok: true,
    };

    expect(registry.handleInvokeResult(terminalResult)).toBe(false);
    expect(registry.handleInvokeResult(terminalResult)).toBe(false);
    await expect(atDeadline).resolves.toEqual({
      ok: false,
      error: { code: "TIMEOUT", message: "node invoke timed out" },
    });
  });

  it("prefers an elapsed hard deadline when disconnect beats the timer callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    registerNode(registry);
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 100,
    });

    vi.setSystemTime(1_100);
    expect(registry.unregister("conn-1")).toBe("node-1");

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: { code: "TIMEOUT", message: "node invoke timed out" },
    });
  });

  it("prefers an elapsed hard deadline when abort beats the timer callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    registerNode(registry);

    const beforeDeadlineController = new AbortController();
    const beforeDeadline = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 100,
      signal: beforeDeadlineController.signal,
    });
    vi.setSystemTime(1_099);
    beforeDeadlineController.abort();
    await expect(beforeDeadline).resolves.toEqual({
      ok: false,
      error: { code: "ABORTED", message: "node invoke cancelled" },
    });

    vi.setSystemTime(2_000);
    const atDeadlineController = new AbortController();
    const atDeadline = registry.invoke({
      nodeId: "node-1",
      command: "debug.ping",
      timeoutMs: 100,
      signal: atDeadlineController.signal,
    });
    vi.setSystemTime(2_100);
    atDeadlineController.abort();
    await expect(atDeadline).resolves.toEqual({
      ok: false,
      error: { code: "TIMEOUT", message: "node invoke timed out" },
    });
  });

  it("rejects streamed input at the hard deadline before its timer callback runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    try {
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        timeoutMs: 100,
        idleTimeoutMs: 1_000,
        onProgress: () => {},
      });

      vi.setSystemTime(1_099);
      registry.sendInvokeInput(invokeId, { kind: "data", data: "before" });

      vi.setSystemTime(1_100);
      expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "expired" })).toThrow(
        "node invoke is not pending",
      );
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      const inputFrames = frames
        .map((frame) => JSON.parse(frame) as { event?: string; payload?: { payloadJSON?: string } })
        .filter((frame) => frame.event === "node.invoke.input");
      expect(inputFrames).toHaveLength(1);
      expect(inputFrames[0]?.payload?.payloadJSON).toBe(
        JSON.stringify({ kind: "data", data: "before" }),
      );
      expectSingleNodeInvokeCancellation(frames, invokeId);
      await vi.runOnlyPendingTimersAsync();
      expectSingleNodeInvokeCancellation(frames, invokeId);
    } finally {
      registry.unregister("conn-1");
      vi.useRealTimers();
    }
  });

  it("rejects streamed progress after the hard deadline before its timer callback runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    try {
      const chunks: string[] = [];
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        timeoutMs: 100,
        idleTimeoutMs: 1_000,
        onProgress: (chunk) => chunks.push(chunk),
      });

      vi.setSystemTime(1_050);
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 0,
          chunk: "started",
        }),
      ).toBe(true);

      // Wall-clock changes do not run the queued hard-timeout callback.
      vi.setSystemTime(1_100);
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 1,
          chunk: "late",
        }),
      ).toBe(false);
      expect(chunks).toEqual(["started"]);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      expectSingleNodeInvokeCancellation(frames, invokeId);
      await vi.runOnlyPendingTimersAsync();
      expectSingleNodeInvokeCancellation(frames, invokeId);
    } finally {
      registry.unregister("conn-1");
      vi.useRealTimers();
    }
  });

  it("stops buffered progress when an ordered callback crosses the hard deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const registry = createNodeRegistry();
    try {
      const chunks: string[] = [];
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        timeoutMs: 100,
        idleTimeoutMs: 1_000,
        onProgress: (chunk) => {
          chunks.push(chunk);
          if (chunk === "first") {
            vi.setSystemTime(1_100);
          }
        },
      });

      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 1,
          chunk: "buffered-after-deadline",
        }),
      ).toBe(true);
      expect(chunks).toEqual([]);

      vi.setSystemTime(1_050);
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "first",
      });
      expect(chunks).toEqual(["first"]);
      await expect(invoke).resolves.toEqual({
        ok: false,
        error: { code: "TIMEOUT", message: "node invoke timed out" },
      });
      expectSingleNodeInvokeCancellation(frames, invokeId);
      await vi.runOnlyPendingTimersAsync();
      expectSingleNodeInvokeCancellation(frames, invokeId);
    } finally {
      registry.unregister("conn-1");
      vi.useRealTimers();
    }
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

  it("arms streamed idle timeout when the first valid progress has a sequence gap", async () => {
    vi.useFakeTimers();
    const registry = createNodeRegistry();
    try {
      const chunks: string[] = [];
      const onTerminal = vi.fn();
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        // Node terminal relays disable the hard deadline and rely on idle teardown.
        timeoutMs: 0,
        idleTimeoutMs: 50,
        onProgress: (chunk) => chunks.push(chunk),
      });
      void invoke.then(onTerminal);

      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 1,
          chunk: "future",
        }),
      ).toBe(true);
      expect(chunks).toEqual([]);
      await vi.advanceTimersByTimeAsync(49);
      expect(onTerminal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onTerminal).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
      expect(chunks).toEqual([]);
      expectSingleNodeInvokeCancellation(frames, invokeId);
      await vi.runOnlyPendingTimersAsync();
      expectSingleNodeInvokeCancellation(frames, invokeId);
    } finally {
      registry.unregister("conn-1");
      vi.useRealTimers();
    }
  });

  it("does not reset streamed idle timeout for distinct progress buffered behind a gap", async () => {
    vi.useFakeTimers();
    const registry = createNodeRegistry();
    try {
      const chunks: string[] = [];
      const onTerminal = vi.fn();
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        timeoutMs: 0,
        idleTimeoutMs: 50,
        onProgress: (chunk) => chunks.push(chunk),
      });
      void invoke.then(onTerminal);

      // Empty ordered chunks are valid node-host liveness heartbeats.
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 0,
          chunk: "",
        }),
      ).toBe(true);
      expect(chunks).toEqual([""]);

      for (const seq of [2, 3]) {
        await vi.advanceTimersByTimeAsync(20);
        expect(
          registry.handleInvokeProgress({
            invokeId,
            nodeId: "node-1",
            connId: "conn-1",
            seq,
            chunk: `future-${seq}`,
          }),
        ).toBe(true);
        expect(chunks).toEqual([""]);
      }

      await vi.advanceTimersByTimeAsync(10);
      expect(onTerminal).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        error: { code: "IDLE_TIMEOUT", message: "node invoke produced no progress" },
      });
      expect(chunks).toEqual([""]);
      expectSingleNodeInvokeCancellation(frames, invokeId);
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: "node-1",
          connId: "conn-1",
          seq: 1,
          chunk: "missing",
        }),
      ).toBe(false);
      await vi.runOnlyPendingTimersAsync();
      expectSingleNodeInvokeCancellation(frames, invokeId);
    } finally {
      registry.unregister("conn-1");
      vi.useRealTimers();
    }
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
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    expect(registry.unregister("conn-1")).toBe("node-1");
    await expect(invoke).resolves.toEqual({
      ok: false,
      error: {
        code: "DISCONNECTED",
        message: "node disconnected (agent.cli.claude.run.v1)",
      },
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

  it("keeps caller abort reasons distinct from the private pairing-change token", async () => {
    const registry = new NodeRegistry();
    registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    controller.abort(Symbol("nodeInvokePairingChanged"));

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: { code: "ABORTED", message: "node invoke cancelled" },
    });
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

  it.each(["mcp.tools.call.v1", "system.run"])(
    "forwards cancellation of first-party non-streaming %s calls",
    async (command) => {
      const registry = createNodeRegistry();
      const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });
      const controller = new AbortController();
      const invoke = registry.invoke({
        nodeId: "node-1",
        command,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

      controller.abort();

      await expect(invoke).resolves.toMatchObject({
        ok: false,
        error: { code: "ABORTED" },
      });
      expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
        event: "node.invoke.cancel",
        payload: { invokeId: request.payload?.id, nodeId: "node-1" },
      });
    },
  );

  it.each(["mcp.tools.call.v1", "system.run"])(
    "forwards timeouts of first-party non-streaming %s calls",
    async (command) => {
      vi.useFakeTimers();
      try {
        const registry = createNodeRegistry();
        const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });
        const invoke = registry.invoke({ nodeId: "node-1", command, timeoutMs: 100 });
        const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };

        await vi.advanceTimersByTimeAsync(100);

        await expect(invoke).resolves.toMatchObject({
          ok: false,
          error: { code: "TIMEOUT" },
        });
        expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
          event: "node.invoke.cancel",
          payload: { invokeId: request.payload?.id, nodeId: "node-1" },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves legacy non-streaming node cancellation behavior", async () => {
    const registry = createNodeRegistry();
    const frames = registerNode(registry);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(invoke).resolves.toMatchObject({
      ok: false,
      error: { code: "ABORTED" },
    });
    expect(frames).toHaveLength(1);
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

  it.each(NON_OPEN_NODE_SOCKET_STATES)(
    "rejects normal event sends while the node websocket is $state",
    ({ readyState }) => {
      const registry = createTestNodeRegistry();
      const socket = createTestNodeSocket([], readyState);
      registerTestNodeSocket(registry, socket);

      expect(registry.sendEvent("node-1", "node.test", { ok: true })).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
    },
  );

  it.each(NON_OPEN_NODE_SOCKET_STATES)(
    "rejects raw event sends while the node websocket is $state",
    ({ readyState }) => {
      const registry = createTestNodeRegistry();
      const socket = createTestNodeSocket([], readyState);
      registerTestNodeSocket(registry, socket);

      expect(
        registry.sendEventRaw("node-1", "node.test", serializeEventPayload({ ok: true })),
      ).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
    },
  );

  it("rate-limits failed event delivery warnings for registered nodes", async () => {
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(resolvePreferredOpenClawTmpDir(), `node-event-send-${process.pid}.log`),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      socket: createTestNodeSocket([], WebSocket.CLOSING) as unknown as GatewayWsClient["socket"],
    });
    registerNodeSession(registry, client, {});

    try {
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);

      now.mockReturnValue(31_001);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);
      now.mockReturnValue(61_002);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);

      client.invalidated = true;
      expect(registry.sendEvent("node-1", "invalidated.failed", {})).toBe(false);
      expect(registry.unregister("conn-1")).toBe("node-1");
      expect(registry.sendEvent("node-1", "unregistered.failed", {})).toBe(false);
      await capture.flush();

      const warnings = capture.records.filter(
        (record) => record.message === "node event delivery failed",
      );
      expect(warnings.map((record) => record.attributes)).toEqual([
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "raw.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
      ]);
    } finally {
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
      now.mockRestore();
    }
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
      readyState: WebSocket.OPEN,
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
    registerTestNodeSocket(registry, socket);
    const payload = serializeEventPayload({ foo: "bar" });

    try {
      expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(false);
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(socket.close.mock.invocationCallOrder[0]).toBeLessThan(
        socket.terminate.mock.invocationCallOrder[0]!,
      );
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
    const computerUse = computerUseDescriptor();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["talk"],
      declaredCommands: ["talk.ptt.start", "computer.act", "screen.snapshot"],
      declaredComputerUse: computerUse,
      declaredPermissions: { microphone: true, camera: false },
    });

    const session = registerNodeSession(registry, client, {});
    expect(session.caps).toEqual([]);
    expect(session.commands).toEqual([]);

    const updated = registry.updateSurface("node-1", {
      caps: ["talk", "screen"],
      commands: ["talk.ptt.start", "computer.act", "screen.snapshot", "system.run"],
      permissions: { microphone: true, camera: true },
    });

    expect(updated?.caps).toEqual(["talk"]);
    expect(updated?.commands).toEqual(["talk.ptt.start", "computer.act", "screen.snapshot"]);
    expect(updated?.computerUse).toEqual(computerUse);
    expect(updated?.permissions).toEqual({ microphone: true, camera: false });
    expect(client.connect.caps).toEqual(["talk"]);
    expect((client.connect as { commands?: string[] }).commands).toEqual([
      "talk.ptt.start",
      "computer.act",
      "screen.snapshot",
    ]);
    expect(client.connect.computerUse).toEqual(computerUse);
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

  it("settles generation-bound invokes immediately when the same connection is promoted", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", frames, {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const invoke = registry.invoke({
      nodeId: "node-1",
      expectedConnId: "conn-1",
      expectedPairingGeneration: "generation-a",
      command: "system.run",
      params: { runId: "run-generation", sessionKey: "agent:main:main", timeoutMs: 0 },
      timeoutMs: 0,
      onProgress: () => {},
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";
    expect(authorizeSystemRun(registry, { runId: "run-generation", terminal: false })).toBe(true);

    registry.updateSurface(
      "node-1",
      { commands: ["system.run"] },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-a",
        expectedPairingGeneration: "generation-a",
        nextPairingGeneration: "generation-b",
      },
    );

    await expect(invoke).resolves.toEqual({
      ok: false,
      error: { code: "PAIRING_CHANGED", message: "node pairing changed after dispatch" },
    });
    expect(authorizeSystemRun(registry, { runId: "run-generation", terminal: false })).toBe(false);
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "late",
      }),
    ).toBe(false);
    expect(
      registry.handleInvokeResult({
        id: invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
      }),
    ).toBe(false);
    expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "late" })).toThrow(
      "node invoke is not pending",
    );
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId, nodeId: "node-1" },
    });
    expect(frames).toHaveLength(2);
  });

  it("keeps explicitly unbound invokes active across same-connection generation promotion", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    const chunks: string[] = [];
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", frames, { commands: ["system.run"] }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: 0,
      onProgress: (chunk) => chunks.push(chunk),
    });
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    const invokeId = request.payload?.id ?? "";

    registry.updateSurface(
      "node-1",
      { commands: ["system.run"] },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-a",
        expectedPairingGeneration: "generation-a",
        nextPairingGeneration: "generation-b",
      },
    );
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        seq: 0,
        chunk: "current",
      }),
    ).toBe(true);
    registry.sendInvokeInput(invokeId, { kind: "data", data: "current" });
    expect(
      registry.handleInvokeResult({
        id: invokeId,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
      }),
    ).toBe(true);

    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(chunks).toEqual(["current"]);
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: { id: invokeId, seq: 0 },
    });
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
