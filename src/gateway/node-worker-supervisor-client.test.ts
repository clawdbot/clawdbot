import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-worker-supervisor-dialect.js";
import {
  nodeWorkerLaunchIdentity,
  type NodeWorkerSupervisorReceipt,
} from "../node-host/node-worker-supervisor-contract.js";
import {
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "../node-host/node-worker-supervisor.test-support.js";
import {
  createNodeRegistryRuntime,
  type NodeWorkerSupervisorNodeProof,
  type NodeWorkerSupervisorTransport,
  updateNodeWorkerSupervisorProtocolFeatures,
} from "./node-registry-private.js";
import { type NodeInvokeResult } from "./node-registry.js";
import { NodeRegistry } from "./node-registry.js";
import { createNodeWorkerSupervisorClient } from "./node-worker-supervisor-client.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeLaunchInput() {
  const fixture = writeNodeWorkerFixture(tempDirs.make("node-worker-client-"));
  return testWorkerLaunchInput(fixture.workspaceDir, "launch-1", "wait");
}

function runningReceipt(input = makeLaunchInput()): NodeWorkerSupervisorReceipt {
  return { ...nodeWorkerLaunchIdentity(input), state: "running" };
}

function workerProof(): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    commands: ["system.run"],
  };
}

function fakeTransport(
  invoke: NodeWorkerSupervisorTransport["invoke"],
  nodes: readonly NodeWorkerSupervisorNodeProof[] = [workerProof()],
): NodeWorkerSupervisorTransport {
  return { listCurrentNodes: async () => nodes, invoke };
}

function makeGatewayClient(onSend: (frame: string) => void): GatewayWsClient {
  return {
    connId: "conn-1",
    usesSharedGatewayAuth: false,
    socket: {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((frame: unknown) => {
        if (typeof frame === "string") {
          onSend(frame);
        }
      }),
      close: vi.fn(),
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
      device: { id: "node-1" },
      caps: [],
      commands: ["system.run"],
    } as unknown as GatewayWsClient["connect"],
  };
}

function createDialectBoundRuntime(onSend: (frame: string) => void) {
  const runtime = createNodeRegistryRuntime(
    () =>
      new NodeRegistry({
        resolveCurrentPairingState: async () => ({
          identity: "identity-1",
          generation: "generation-1",
        }),
      }),
  );
  runtime.nodeRegistry.register(makeGatewayClient(onSend), {
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
  });
  expect(
    updateNodeWorkerSupervisorProtocolFeatures({
      registry: runtime.nodeRegistry,
      nodeId: "node-1",
      connId: "conn-1",
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    }),
  ).toBe(true);
  return runtime;
}

describe("gateway node worker supervisor client", () => {
  it("invokes the private launch command through an exact dialect-bound session", async () => {
    const input = makeLaunchInput();
    const receipt = runningReceipt(input);
    let runtime!: ReturnType<typeof createDialectBoundRuntime>;
    runtime = createDialectBoundRuntime((raw) => {
      const request = JSON.parse(raw) as {
        event?: string;
        payload?: { id?: string; command?: string };
      };
      expect(request).toMatchObject({
        event: "node.invoke.request",
        payload: { command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND },
      });
      queueMicrotask(() => {
        runtime.nodeRegistry.handleInvokeResult({
          id: request.payload?.id ?? "",
          nodeId: "node-1",
          connId: "conn-1",
          ok: true,
          payloadJSON: JSON.stringify(receipt),
        });
      });
    });

    await expect(
      createNodeWorkerSupervisorClient(runtime.nodeWorkerSupervisorTransport).launch({
        nodeId: "node-1",
        input,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toEqual({ effect: "verified-receipt", receipt });
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("marks a generation-rotated private launch unknown and cancels its transient response path", async () => {
    const frames: Array<{
      event?: string;
      payload?: { id?: string; invokeId?: string; nodeId?: string };
    }> = [];
    const runtime = createDialectBoundRuntime((raw) => {
      frames.push(JSON.parse(raw) as (typeof frames)[number]);
    });
    const launch = createNodeWorkerSupervisorClient(runtime.nodeWorkerSupervisorTransport).launch({
      nodeId: "node-1",
      input: makeLaunchInput(),
      isDispatchAuthorized: () => true,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const invokeId = frames[0]?.payload?.id;

    runtime.nodeRegistry.updateSurface(
      "node-1",
      { commands: ["system.run"] },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-1",
        expectedPairingGeneration: "generation-1",
        nextPairingGeneration: "generation-2",
      },
    );

    await expect(launch).resolves.toMatchObject({
      effect: "sent-outcome-unknown",
      error: { code: "PAIRING_CHANGED" },
    });
    expect(frames).toEqual([
      expect.objectContaining({ event: "node.invoke.request" }),
      expect.objectContaining({
        event: "node.invoke.cancel",
        payload: { invokeId, nodeId: "node-1" },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it.each([
    {
      name: "closed authority",
      nodes: [workerProof()],
      authorized: false,
      invoke: vi.fn(),
      code: "AUTHORITY_CLOSED",
    },
    {
      name: "missing dialect-bound node",
      nodes: [],
      authorized: true,
      invoke: vi.fn(),
      code: "INVALID_NODE_HOST",
    },
    {
      name: "pre-send transport rejection",
      nodes: [workerProof()],
      authorized: true,
      invoke: vi.fn(async () => ({
        ok: false,
        error: { code: "PRIVATE_DIALECT_UNAVAILABLE", message: "unavailable" },
      })),
      code: "PRIVATE_DIALECT_UNAVAILABLE",
    },
  ])("classifies $name as not-sent", async ({ nodes, authorized, invoke, code }) => {
    const result = await createNodeWorkerSupervisorClient(fakeTransport(invoke, nodes)).launch({
      nodeId: "node-1",
      input: makeLaunchInput(),
      isDispatchAuthorized: () => authorized,
    });

    expect(result).toMatchObject({ effect: "not-sent", error: { code } });
  });

  it.each([
    {
      name: "remote error",
      result: { ok: false, error: { code: "INVALID_REQUEST", message: "rejected" } },
    },
    { name: "timeout", result: { ok: false, error: { code: "TIMEOUT", message: "timeout" } } },
    {
      name: "disconnect",
      result: { ok: false, error: { code: "DISCONNECTED", message: "disconnected" } },
    },
    { name: "abort", result: { ok: false, error: { code: "ABORTED", message: "aborted" } } },
    {
      name: "pairing rotation",
      result: { ok: false, error: { code: "PAIRING_CHANGED", message: "rotated" } },
    },
    { name: "malformed reply", result: { ok: true, payloadJSON: "{" } },
    { name: "oversized reply", result: { ok: true, payloadJSON: " ".repeat(9 * 1024) } },
    { name: "missing launch receipt", result: { ok: true, payloadJSON: "null" } },
    {
      name: "extra receipt field",
      result: { ok: true, payloadJSON: JSON.stringify({ ...runningReceipt(), pid: 42 }) },
    },
    {
      name: "mismatched receipt",
      result: {
        ok: true,
        payloadJSON: JSON.stringify({ ...runningReceipt(), environmentId: "other" }),
      },
    },
  ] as Array<{ name: string; result: NodeInvokeResult }>)(
    "classifies post-send $name as sent-outcome-unknown",
    async ({ result }) => {
      const transport = fakeTransport(async (params) => {
        params.onDispatchReady?.("invoke-1");
        return result;
      });

      await expect(
        createNodeWorkerSupervisorClient(transport).launch({
          nodeId: "node-1",
          input: makeLaunchInput(),
          isDispatchAuthorized: () => true,
        }),
      ).resolves.toMatchObject({ effect: "sent-outcome-unknown" });
    },
  );

  it("classifies a thrown post-send transport failure as sent-outcome-unknown", async () => {
    const transport = fakeTransport(async (params) => {
      params.onDispatchReady?.("invoke-1");
      throw new Error("transport failed");
    });

    await expect(
      createNodeWorkerSupervisorClient(transport).launch({
        nodeId: "node-1",
        input: makeLaunchInput(),
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({ effect: "sent-outcome-unknown" });
  });

  it("requires dispatch provenance even for a strictly valid receipt", async () => {
    const input = makeLaunchInput();
    const transport = fakeTransport(async () => ({
      ok: true,
      payloadJSON: JSON.stringify(runningReceipt(input)),
    }));

    await expect(
      createNodeWorkerSupervisorClient(transport).launch({
        nodeId: "node-1",
        input,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({ effect: "not-sent", error: { code: "INVALID_REPLY" } });
  });

  it("accepts a verified missing status receipt", async () => {
    const input = makeLaunchInput();
    const transport = fakeTransport(async (params) => {
      params.onDispatchReady?.("invoke-1");
      return { ok: true, payloadJSON: "null" };
    });

    await expect(
      createNodeWorkerSupervisorClient(transport).status({
        nodeId: "node-1",
        expected: nodeWorkerLaunchIdentity(input),
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toEqual({ effect: "verified-receipt", receipt: null });
  });

  it.each([
    { state: "cancelled" as const, cancellation: "cancelled" as const },
    { state: "running" as const, cancellation: "not-cancelled" as const },
  ])("reports a verified $state cancel receipt honestly", async ({ state, cancellation }) => {
    const input = makeLaunchInput();
    const expected = nodeWorkerLaunchIdentity(input);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (params) => {
      expect(params.command).toBe(NODE_WORKER_SUPERVISOR_CANCEL_COMMAND);
      expect(params.params).toEqual(expected);
      params.onDispatchReady?.("invoke-cancel");
      return { ok: true, payloadJSON: JSON.stringify({ ...expected, state }) };
    });

    await expect(
      createNodeWorkerSupervisorClient(fakeTransport(invoke)).cancel({
        nodeId: "node-1",
        expected,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toEqual({
      effect: "verified-receipt",
      receipt: { ...expected, state },
      cancellation,
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
