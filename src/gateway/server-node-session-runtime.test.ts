import { describe, expect, test, vi } from "vitest";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TestSocket = {
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
        id: "node-client",
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
) {
  return createGatewayNodeSessionRuntime({
    broadcast,
    resolveCurrentPairingState: async () => ({
      identity: "identity-a",
      generation: await resolveCurrentPairingGeneration(),
    }),
    isPairingStateCurrent,
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
