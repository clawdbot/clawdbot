// Node version mismatch tests protect local node identity/version checks so the
// gateway accepts matching node hosts and rejects incompatible local runtimes.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { approveNodePairing, listNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { configureNodeHost } from "../node-host/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayVersion = resolveRuntimeServiceVersion(process.env);

const TEST_LOCAL_NODE_ID = "test-local-node-version-mismatch";

describe("node host version mismatch guard", () => {
  let port: number;
  let server: Awaited<ReturnType<typeof startServer>>["server"];

  beforeAll(async () => {
    await configureNodeHost({
      nodeId: TEST_LOCAL_NODE_ID,
      displayName: "test-local-node",
      fallbackDisplayName: "test-local-node",
      gateway: {},
    });
    const started = await startServer("secret");
    port = started.port;
    server = started.server;
  });

  afterAll(async () => {
    await server?.close();
  });

  test("local node with matching released version connects successfully", async () => {
    // Use the actual gateway version so versions match
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-match",
      clientVersion: gatewayVersion,
      instanceId: TEST_LOCAL_NODE_ID,
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });

  test("local node with mismatched released version is rejected", async () => {
    const staleVersion = "2020.1.1";
    await expect(
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: "secret",
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientDisplayName: "test-node-stale",
        clientVersion: staleVersion,
        instanceId: TEST_LOCAL_NODE_ID,
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        commands: [],
        timeoutMs: 5_000,
        timeoutMessage: "expected version mismatch rejection",
      }),
    ).rejects.toThrow(/client version mismatch|version mismatch/i);
  });

  test("rejected local reconnects preserve the active node pending reapproval", async () => {
    const pairedNode = await pairDeviceIdentity({
      name: "node-version-mismatch-pending-reapproval",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
    });
    const initial = await requestNodePairing({
      nodeId: pairedNode.identity.deviceId,
      platform: "macos",
      deviceFamily: "Mac",
      commands: ["screen.snapshot"],
    });
    await approveNodePairing(initial.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });

    const upgraded = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-upgraded",
      clientVersion: gatewayVersion,
      instanceId: TEST_LOCAL_NODE_ID,
      platform: "macos",
      deviceFamily: "Mac",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: ["screen.snapshot", "system.run"],
      deviceIdentity: pairedNode.identity,
    });
    try {
      const connectReverted = async (clientVersion: string, clientDisplayName: string) =>
        await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: "secret",
          role: "node",
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          clientDisplayName,
          clientVersion,
          instanceId: TEST_LOCAL_NODE_ID,
          platform: "macos",
          deviceFamily: "Mac",
          mode: GATEWAY_CLIENT_MODES.NODE,
          scopes: [],
          commands: ["screen.snapshot"],
          deviceIdentity: pairedNode.identity,
          timeoutMs: 5_000,
          timeoutMessage: "expected rejected reconnect",
        });
      const pendingBefore = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
      );
      expect(pendingBefore?.commands).toEqual(["screen.snapshot", "system.run"]);

      await expect(connectReverted("2020.1.1", "test-node-reverted-stale")).rejects.toThrow(
        /client version mismatch|version mismatch/i,
      );

      const pendingAfterVersionMismatch = (await listNodePairing()).pending.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
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
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
      );
      expect(pendingAfterHelloFailure?.requestId).toBe(pendingBefore?.requestId);
      expect(pendingAfterHelloFailure?.commands).toEqual(["screen.snapshot", "system.run"]);
    } finally {
      await upgraded.stopAndWait({ timeoutMs: 2_000 });
    }
  });

  test("local node with dev/test version is allowed (not a released version)", async () => {
    // "dev" does not match YYYY.M.PATCH, so the guard skips
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-dev",
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });

  test("local node with non-date version '1.0.0' is allowed", async () => {
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "test-node-semver",
      clientVersion: "1.0.0",
      mode: GATEWAY_CLIENT_MODES.NODE,
      scopes: [],
      commands: [],
    });
    expect(client).toBeDefined();
    await client.stopAndWait({ timeoutMs: 2_000 });
  });
});
