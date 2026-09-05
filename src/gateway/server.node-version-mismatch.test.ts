// Real signed node connects protect same-install classification and version admission.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { configureNodeHost } from "../node-host/config.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayVersion = resolveRuntimeServiceVersion(process.env);

describe("node host version mismatch guard", () => {
  let port: number;
  let server: Awaited<ReturnType<typeof startServer>>["server"];
  let localIdentity: DeviceIdentity;
  let instanceId: string;

  async function pairNode(identity: DeviceIdentity) {
    const request = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      platform: "macos",
      deviceFamily: "Mac",
    });
    const approved = await approveDevicePairing(request.request.requestId, { callerScopes: [] });
    expect(approved?.status).toBe("approved");
    const surface = await requestNodePairing({
      nodeId: identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: [],
    });
    const node = await approveNodePairing(surface.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });
    expect(node && "node" in node).toBe(true);
  }

  function connectNode(overrides: Partial<Parameters<typeof connectGatewayClient>[0]> = {}) {
    return connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node",
      clientVersion: gatewayVersion,
      instanceId,
      platform: "macos",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
      deviceIdentity: localIdentity,
      ...overrides,
    });
  }

  beforeAll(async () => {
    const config = await configureNodeHost({ fallbackDisplayName: "test-node", gateway: {} });
    instanceId = config.nodeId;
    localIdentity = loadOrCreateDeviceIdentity();
    expect(instanceId).not.toBe(localIdentity.deviceId);
    await pairNode(localIdentity);
    const started = await startServer("secret");
    port = started.port;
    server = started.server;
  });

  afterAll(async () => {
    await server?.close();
  });

  test.each([gatewayVersion, "dev", "1.0.0"])(
    "same-install node with accepted version %s connects",
    async (clientVersion) => {
      let helloProtocol: number | undefined;
      const client = await connectNode({
        clientVersion,
        onHelloOk: (hello) => {
          helloProtocol = hello.protocol;
        },
      });
      try {
        expect(helloProtocol).toBe(PROTOCOL_VERSION);
      } finally {
        await client.stopAndWait({ timeoutMs: 2_000 });
      }
    },
  );

  test.each(["default", "different", "omitted"])(
    "same-install stale node is rejected with %s instanceId",
    async (instance) => {
      const onHelloOk = vi.fn();
      await expect(
        connectNode({
          clientVersion: "2020.1.1",
          instanceId:
            instance === "default"
              ? instanceId
              : instance === "different"
                ? "different-instance"
                : undefined,
          onHelloOk,
          timeoutMs: 5_000,
          timeoutMessage: "expected version mismatch rejection",
        }).then(async (client) => {
          await client.stopAndWait({ timeoutMs: 2_000 });
          return "connected";
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.INVALID_REQUEST,
        message: "client version mismatch",
        details: {
          code: ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
          clientVersion: "2020.1.1",
          gatewayVersion,
        },
      });
      expect(onHelloOk).not.toHaveBeenCalled();
    },
  );

  test("list and describe mark only the same-install device despite copied instance metadata", async () => {
    const independent = await createOpenClawTestState({
      label: "node-independent",
      applyEnv: false,
    });
    const clients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
    try {
      const identity = loadOrCreateDeviceIdentity({ env: independent.env });
      expect(identity.deviceId).not.toBe(localIdentity.deviceId);
      await pairNode(identity);
      clients.push(await connectNode());
      clients.push(await connectNode({ deviceIdentity: identity }));
      const operator = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: "secret",
        scopes: ["operator.read"],
      });
      clients.push(operator);
      const list = await operator.request<{ nodes: NodeListNode[] }>("node.list", {});
      expect(list.nodes.filter((node) => node.gatewayLocal)).toEqual([
        expect.objectContaining({
          nodeId: localIdentity.deviceId,
          gatewayLocal: true,
          paired: true,
          connected: true,
        }),
      ]);
      const remote = list.nodes.find((node) => node.nodeId === identity.deviceId);
      expect(remote).toMatchObject({ paired: true, connected: true, displayName: "test-node" });
      expect(remote).not.toHaveProperty("gatewayLocal");
      await expect(
        operator.request("node.describe", { nodeId: localIdentity.deviceId }),
      ).resolves.toMatchObject({
        nodeId: localIdentity.deviceId,
        gatewayLocal: true,
        paired: true,
        connected: true,
      });
      const described = await operator.request("node.describe", { nodeId: identity.deviceId });
      expect(described).toMatchObject({ nodeId: identity.deviceId, paired: true, connected: true });
      expect(described).not.toHaveProperty("gatewayLocal");
    } finally {
      try {
        await Promise.all(clients.map((client) => client.stopAndWait({ timeoutMs: 2_000 })));
      } finally {
        await independent.cleanup();
      }
    }
  });

  test("independently paired stale node connects with the same-install instanceId", async () => {
    const independent = await createOpenClawTestState({
      label: "node-independent-stale",
      applyEnv: false,
    });
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      const identity = loadOrCreateDeviceIdentity({ env: independent.env });
      await pairNode(identity);
      const onHelloOk = vi.fn();
      client = await connectNode({
        deviceIdentity: identity,
        clientVersion: "2020.1.1",
        onHelloOk,
      });
      expect(onHelloOk).toHaveBeenCalledWith(
        expect.objectContaining({ protocol: PROTOCOL_VERSION }),
      );
    } finally {
      try {
        await client?.stopAndWait({ timeoutMs: 2_000 });
      } finally {
        await independent.cleanup();
      }
    }
  });

  test("rejected local reconnects preserve the active node pending reapproval", async () => {
    const initial = await requestNodePairing({
      nodeId: localIdentity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["screen.snapshot"],
    });
    await approveNodePairing(initial.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });

    const upgraded = await connectNode({ commands: ["screen.snapshot", "system.run"] });
    try {
      const connectReverted = async (clientVersion: string, clientDisplayName: string) =>
        await connectNode({
          clientDisplayName,
          clientVersion,
          instanceId: "reconnect-instance-override",
          commands: ["screen.snapshot"],
          timeoutMs: 5_000,
          timeoutMessage: "expected rejected reconnect",
        }).then(async (client) => {
          await client.stopAndWait({ timeoutMs: 2_000 });
          return "connected";
        });
      const pendingBefore = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === localIdentity.deviceId,
      );
      expect(pendingBefore?.commands).toEqual(["screen.snapshot", "system.run"]);

      await expect(connectReverted("2020.1.1", "test-node-reverted-stale")).rejects.toThrow(
        /client version mismatch|version mismatch/i,
      );

      const pendingAfterVersionMismatch = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === localIdentity.deviceId,
      );
      expect(pendingAfterVersionMismatch?.requestId).toBe(pendingBefore?.requestId);
      expect(pendingAfterVersionMismatch?.commands).toEqual(["screen.snapshot", "system.run"]);

      const originalSend = Reflect.get(WebSocket.prototype, "send");
      let failNextHelloOk = true;
      const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
        this: WebSocket,
        ...args: Parameters<WebSocket["send"]>
      ) {
        if (failNextHelloOk && typeof args[0] === "string" && args[0].includes('"hello-ok"')) {
          failNextHelloOk = false;
          const callback = args.findLast((arg) => typeof arg === "function");
          if (typeof callback === "function") {
            callback(new Error("test hello-ok send failure"));
          }
          return;
        }
        Reflect.apply(originalSend, this, args);
      });
      try {
        await expect(
          connectReverted(gatewayVersion, "test-node-reverted-hello-failure"),
        ).rejects.toThrow(/gateway closed during connect/i);
        expect(failNextHelloOk).toBe(false);
      } finally {
        sendSpy.mockRestore();
      }

      const pendingAfterHelloFailure = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === localIdentity.deviceId,
      );
      expect(pendingAfterHelloFailure?.requestId).toBe(pendingBefore?.requestId);
      expect(pendingAfterHelloFailure?.commands).toEqual(["screen.snapshot", "system.run"]);
    } finally {
      await upgraded.stopAndWait({ timeoutMs: 2_000 });
    }
  });
});
