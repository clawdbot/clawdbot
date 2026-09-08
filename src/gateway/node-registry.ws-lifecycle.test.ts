import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { setActiveNodeContext } from "../infra/active-node-context.js";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createNodeClient(socket: WebSocket): GatewayWsClient {
  return {
    connId: "runtime-proof-conn",
    usesSharedGatewayAuth: false,
    socket,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-linux",
        version: "1.0.0",
        platform: "linux",
        mode: "node",
      },
      device: {
        id: "runtime-proof-node",
        publicKey: "runtime-proof-public-key",
        signature: "runtime-proof-signature",
        signedAt: 1,
        nonce: "runtime-proof-nonce",
      },
      caps: [],
      commands: [],
    } as GatewayWsClient["connect"],
  };
}

describe("NodeRegistry real WebSocket lifecycle", () => {
  afterEach(() => {
    setActiveNodeContext(null);
  });

  it("rejects event and invoke delivery after a real socket leaves OPEN", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const accepted = once(server, "connection");
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(peer, "open");
    const [socket] = (await accepted) as [WebSocket];
    const frames: string[] = [];
    peer.on("message", (data: RawData) => frames.push(rawDataToString(data)));
    const registry = new NodeRegistry();
    registry.register(createNodeClient(socket), { pairingIdentity: "runtime-proof-pairing" });

    try {
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(registry.sendEvent("runtime-proof-node", "runtime.proof", { phase: "open" })).toBe(
        true,
      );
      await vi.waitFor(() => expect(frames).toHaveLength(1));

      socket.close(1000, "runtime proof");
      const closingState = socket.readyState;
      const frameCountAtClose = frames.length;
      const normalAccepted = registry.sendEvent("runtime-proof-node", "runtime.proof", {
        phase: "closing",
      });
      const rawAccepted = registry.sendEventRaw("runtime-proof-node", "runtime.raw", null);
      const onDispatchReady = vi.fn();
      const invoke = await registry.invoke({
        nodeId: "runtime-proof-node",
        command: "runtime.proof",
        timeoutMs: 0,
        onDispatchReady,
      });
      const invokeErrorCode = invoke.ok ? null : invoke.error?.code;

      expect(closingState).toBe(WebSocket.CLOSING);
      expect(normalAccepted).toBe(false);
      expect(rawAccepted).toBe(false);
      expect(invoke).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
      });
      expect(onDispatchReady).not.toHaveBeenCalled();
      expect(frames).toHaveLength(frameCountAtClose);

      console.log(
        "[behavior-evidence] node-ws-open-admission",
        JSON.stringify({
          openState: WebSocket.OPEN,
          closingState,
          openFrameCount: frameCountAtClose,
          closingNormalAccepted: normalAccepted,
          closingRawAccepted: rawAccepted,
          invokeErrorCode,
          invokeDispatchReady: onDispatchReady.mock.calls.length,
          framesAfterClosingAttempts: frames.length - frameCountAtClose,
        }),
      );
    } finally {
      registry.unregister("runtime-proof-conn");
      peer.terminate();
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
