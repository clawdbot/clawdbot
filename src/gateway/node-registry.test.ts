import { describe, expect, it } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(connId: string, nodeId: string, sent: string[] = []): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      send(frame: unknown) {
        if (typeof frame === "string") {
          sent.push(frame);
        }
      },
    } as unknown as GatewayWsClient["socket"],
    connect: {
      client: { id: "openclaw-macos", version: "1.0.0", platform: "darwin", mode: "node" },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    } as GatewayWsClient["connect"],
  };
}

describe("gateway/node-registry", () => {
  it("keeps a reconnected node when the old connection unregisters", async () => {
    const registry = new NodeRegistry();
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
});
