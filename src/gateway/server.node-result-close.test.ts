// Node result/close ordering tests keep admitted terminal frames authoritative.
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { GatewayNodeLifecycleDispatchTracker } from "./server/ws-connection/node-lifecycle-dispatch.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.js";

const pairingRead = vi.hoisted(() => ({
  blocked: null as Promise<void> | null,
  onBlocked: null as (() => void) | null,
  release: null as (() => void) | null,
}));

vi.mock("../infra/device-pairing-node-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing-node-state.js")>();
  return {
    ...actual,
    resolveCurrentPairedDeviceNodeBinding: async (nodeId: string) => {
      const current = await actual.resolveCurrentPairedDeviceNodeBinding(nodeId);
      if (pairingRead.blocked) {
        pairingRead.onBlocked?.();
        await pairingRead.blocked;
      }
      return current;
    },
  };
});

installGatewayTestHooks({ scope: "suite" });

afterEach(() => {
  vi.restoreAllMocks();
  pairingRead.blocked = null;
  pairingRead.onBlocked = null;
  pairingRead.release = null;
});

test.each([
  ["a terminal node result admitted before close wins over disconnect cleanup", false],
  ["pairing removal still fences a terminal node result while close drains", true],
] as const)("%s", async (_name, removePairingDuringDrain) => {
  const pairedNode = await pairDeviceIdentity({
    name: "node-result-before-close",
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: pairedNode.identity.deviceId,
    platform: "linux",
    deviceFamily: "Linux",
    commands: ["camera.list"],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });
  await writeConfigFile({
    gateway: { nodes: { commands: { allow: ["camera.list"] } } },
  });

  const { port, server } = await startServer("secret");
  const url = `ws://127.0.0.1:${port}`;
  let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let resolveInvokeFrame:
    | ((frame: { id: string; nodeId: string; command: string }) => void)
    | undefined;
  const invokeFrame = new Promise<{ id: string; nodeId: string; command: string }>((resolve) => {
    resolveInvokeFrame = resolve;
  });

  try {
    operator = await connectGatewayClient({
      url,
      token: "secret",
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "node result close operator",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    node = await connectGatewayClient({
      url,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "node result close host",
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "linux",
      deviceFamily: "Linux",
      scopes: [],
      commands: ["camera.list"],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload) {
          return;
        }
        resolveInvokeFrame?.(event.payload as { id: string; nodeId: string; command: string });
      },
    });
    await vi.waitFor(async () => {
      const listed = await operator?.request<{
        nodes?: Array<{ nodeId?: string; connected?: boolean; commands?: string[] }>;
      }>("node.list", {}, { timeoutMs: 10_000 });
      expect(listed?.nodes?.find((entry) => entry.nodeId === pairedNode.identity.deviceId)).toEqual(
        expect.objectContaining({
          connected: true,
          commands: ["camera.list"],
        }),
      );
    });

    const invoked = operator.request<{
      ok: boolean;
      nodeId: string;
      command: string;
      payload: unknown;
    }>(
      "node.invoke",
      {
        nodeId: pairedNode.identity.deviceId,
        command: "camera.list",
        timeoutMs: 10_000,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: 10_000 },
    );
    const frame = await Promise.race([
      invokeFrame,
      invoked.then(
        () => {
          throw new Error("node.invoke settled without sending a node request");
        },
        (error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      ),
    ]);

    pairingRead.blocked = new Promise<void>((resolve) => {
      pairingRead.release = resolve;
    });
    const pairingReadStarted = new Promise<void>((resolve) => {
      pairingRead.onBlocked = resolve;
    });
    const drainSpy = vi.spyOn(GatewayNodeLifecycleDispatchTracker.prototype, "drain");
    const resultAck = node
      .request(
        "node.invoke.result",
        {
          id: frame.id,
          nodeId: frame.nodeId,
          ok: true,
          payloadJSON: JSON.stringify({ completed: "before-close" }),
        },
        { timeoutMs: 10_000 },
      )
      .catch((error: unknown) => error);
    await pairingReadStarted;
    const rawNodeSocket = Reflect.get(node, "ws") as { terminate?: () => void } | null;
    const stopped = node.stopAndWait({ timeoutMs: 1_000 });
    rawNodeSocket?.terminate?.();
    await stopped;
    node = undefined;
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledOnce());
    if (removePairingDuringDrain) {
      await operator.request(
        "node.pair.remove",
        { nodeId: pairedNode.identity.deviceId },
        { timeoutMs: 10_000 },
      );
    }
    pairingRead.release?.();

    if (removePairingDuringDrain) {
      await expect(invoked).rejects.toThrow("node pairing changed while invocation was active");
    } else {
      await expect(invoked).resolves.toMatchObject({
        ok: true,
        nodeId: pairedNode.identity.deviceId,
        command: "camera.list",
        payload: { completed: "before-close" },
      });
    }
    await resultAck;
    await vi.waitFor(async () => {
      const listed = await operator?.request<{
        nodes?: Array<{ nodeId?: string; connected?: boolean }>;
      }>("node.list", {}, { timeoutMs: 10_000 });
      const listedNode = listed?.nodes?.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
      );
      if (removePairingDuringDrain) {
        expect(listedNode).toBeUndefined();
      } else {
        expect(listedNode?.connected).toBe(false);
      }
    });
  } finally {
    releaseBlockedPairingRead();
    await Promise.allSettled([
      ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
      ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
    ]);
    await server.close();
  }
});

function releaseBlockedPairingRead(): void {
  pairingRead.release?.();
  pairingRead.onBlocked = null;
  pairingRead.blocked = null;
  pairingRead.release = null;
}
