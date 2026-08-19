import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED } from "./events.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TestSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
};

function makeGatewayWsClient(connId: string, socket: TestSocket): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connId,
    usesSharedGatewayAuth: false,
    connect: {
      role: "node",
      scopes: [],
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "1.0.0",
        platform: "macos",
        mode: "node",
      },
      device: { id: "node-a" },
    } as unknown as GatewayWsClient["connect"],
  };
}

function createRuntime(
  resolveCurrentPairingGeneration: () => Promise<string>,
  broadcast = vi.fn(),
  isPairingStateCurrent: NonNullable<
    Parameters<typeof createGatewayNodeSessionRuntime>[0]["isPairingStateCurrent"]
  > = (_nodeId, expected) =>
    expected.identity === "identity-a" && expected.generation === "generation-a",
  onRunnerInventoryChanged?: (nodeId: string) => void,
) {
  return createGatewayNodeSessionRuntime({
    broadcast,
    resolveCurrentPairingState: async () => ({
      identity: "identity-a",
      generation: await resolveCurrentPairingGeneration(),
    }),
    isPairingStateCurrent,
    onRunnerInventoryChanged,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
}

function registerNode(
  runtime: ReturnType<typeof createRuntime>,
  connId: string,
  pairingGeneration: string,
  frames: string[],
) {
  const socket: TestSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((payload: string) => frames.push(payload)),
    close: vi.fn(),
  };
  runtime.nodeRegistry.register(makeGatewayWsClient(connId, socket), {
    pairingIdentity: "identity-a",
    pairingGeneration,
  });
}

describe("gateway node session runtime", () => {
  test("publishes pairing-generation transitions to lifecycle consumers", () => {
    const onPairingGenerationChanged = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast: vi.fn(),
      onPairingGenerationChanged,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    registerNode(runtime, "conn-original", "generation-a", []);
    registerNode(runtime, "conn-replacement", "generation-b", []);

    expect(onPairingGenerationChanged).toHaveBeenCalledWith({
      nodeId: "node-a",
      previousPairingGeneration: "generation-a",
      nextPairingGeneration: "generation-b",
      preserveSessionState: false,
    });
  });

  test("broadcasts and routes runner inventory changes from publication and replacement", () => {
    const broadcast = vi.fn();
    const onRunnerInventoryChanged = vi.fn();
    const runtime = createRuntime(
      async () => "generation-a",
      broadcast,
      undefined,
      onRunnerInventoryChanged,
    );
    registerNode(runtime, "conn-original", "generation-a", []);

    expect(
      updateNodeRunnerInventory({
        registry: runtime.nodeRegistry,
        nodeId: "node-a",
        connId: "conn-original",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
        },
      }),
    ).toEqual({ changed: true });
    expect(broadcast).toHaveBeenNthCalledWith(
      1,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(true);
    expect(onRunnerInventoryChanged).toHaveBeenLastCalledWith("node-a");

    registerNode(runtime, "conn-replacement", "generation-a", []);

    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(onRunnerInventoryChanged).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenNthCalledWith(
      3,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      4,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(false);
  });

  test("forwards subscribed payload json without parsing it again", async () => {
    const frames: string[] = [];
    const runtime = createRuntime(async () => "generation-a");
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-node-a");

    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      runtime.nodeSendToSession("main", "chat", { ok: true });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
    expect(JSON.parse(frames[0] ?? "{}")).toEqual({
      type: "event",
      event: "chat",
      payload: { ok: true },
    });
  });

  test("fences voice-wake updates by pairing generation while retaining operator broadcasts", async () => {
    let currentPairingGeneration = "generation-a";
    const resolveCurrentPairingGeneration = vi.fn(async () => currentPairingGeneration);
    const broadcast = vi.fn();
    const runtime = createRuntime(
      resolveCurrentPairingGeneration,
      broadcast,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");
    const routing = {
      version: 1 as const,
      defaultTarget: { mode: "current" as const },
      routes: [],
      updatedAtMs: 1,
    };

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    runtime.broadcastVoiceWakeRoutingChanged(routing);
    await vi.waitFor(() => expect(frames).toHaveLength(2));

    currentPairingGeneration = "generation-b";
    runtime.broadcastVoiceWakeChanged(["retired"]);
    runtime.broadcastVoiceWakeRoutingChanged({ ...routing, updatedAtMs: 2 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
      { type: "event", event: "voicewake.routing.changed", payload: { config: routing } },
    ]);
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  test("fences generation-less voice-wake updates by authenticated pairing identity", async () => {
    let pairingExists = true;
    const broadcast = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast,
      resolveCurrentPairingState: async () =>
        pairingExists ? { identity: "identity-a" } : undefined,
      isPairingStateCurrent: (_nodeId, expected) =>
        pairingExists && expected.identity === "identity-a",
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    const frames: string[] = [];
    const socket: TestSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((payload: string) => frames.push(payload)),
      close: vi.fn(),
    };
    const client = makeGatewayWsClient("conn-node-a", socket);
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-a" });
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    pairingExists = false;
    runtime.broadcastVoiceWakeChanged(["retired"]);
    await vi.waitFor(() => expect(client.invalidated).toBe(true));

    expect(send).not.toHaveBeenCalled();
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
    ]);
    expect(client.invalidated).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("does not inherit subscriptions across a replacement pairing generation", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(async () => currentPairingGeneration);

    const originalFrames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", originalFrames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    runtime.nodeSendToSession("main", "chat", { seq: 1 });
    await vi.waitFor(() => expect(originalFrames).toHaveLength(1));

    currentPairingGeneration = "generation-b";
    runtime.nodeSendToSession("main", "chat", { seq: 2 });
    await vi.waitFor(() => expect(runtime.nodeRegistry.get("node-a")).toBeUndefined());
    expect(originalFrames).toHaveLength(1);

    const replacementFrames: string[] = [];
    registerNode(runtime, "conn-replacement", "generation-b", replacementFrames);
    runtime.nodeSubscribe("node-a", "retired", "conn-original");
    runtime.nodeSendToSession("retired", "chat", { seq: 3 });
    expect(replacementFrames).toHaveLength(0);

    runtime.nodeSubscribe("node-a", "main", "conn-replacement");
    runtime.nodeSendToSession("main", "chat", { seq: 4 });
    await vi.waitFor(() => expect(replacementFrames).toHaveLength(1));

    const reconnectFrames: string[] = [];
    registerNode(runtime, "conn-reconnect", "generation-b", reconnectFrames);
    runtime.nodeSendToSession("main", "chat", { seq: 5 });
    await vi.waitFor(() => expect(reconnectFrames).toHaveLength(1));
  });

  test("preserves subscriptions for an exact live pairing generation promotion", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(async () => currentPairingGeneration);
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-node-a");
    currentPairingGeneration = "generation-b";
    expect(
      runtime.nodeRegistry.updateSurface(
        "node-a",
        { commands: [] },
        {
          expectedConnId: "conn-node-a",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    runtime.nodeSendToSession("main", "chat", { ok: true });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
  });
});
