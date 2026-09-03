import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { runGatewayLoopbackLanProof } from "./gateway-loopback-lan-access.js";

describe("Gateway loopback TCP probe", () => {
  it.each([
    { name: "self-connection", remoteAddress: "127.0.0.2", remotePort: 41863, isolated: true },
    { name: "different port", remoteAddress: "127.0.0.2", remotePort: 41864, isolated: false },
    { name: "different address", remoteAddress: "127.0.0.1", remotePort: 41863, isolated: false },
  ])(
    "classifies a connected socket with $name",
    async ({ remoteAddress, remotePort, isolated }) => {
      const originalConnect = net.connect;
      let probeSocket: net.Socket | undefined;
      const connectSpy = vi.spyOn(net, "connect").mockImplementation((...args) => {
        const options: unknown = args[0];
        if (
          !options ||
          typeof options !== "object" ||
          !("host" in options) ||
          !("localAddress" in options) ||
          options.host !== options.localAddress
        ) {
          return originalConnect(...args);
        }
        // Inject only the LAN isolation probe; HTTP, auth and both Gateways stay real.
        connectSpy.mockRestore();
        const socket = new net.Socket();
        probeSocket = socket;
        Object.defineProperties(socket, {
          localAddress: { value: "127.0.0.2" },
          localPort: { value: 41863 },
          remoteAddress: { value: remoteAddress },
          remotePort: { value: remotePort },
        });
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      });

      try {
        const proof = runGatewayLoopbackLanProof();
        if (isolated) {
          await expect(proof).resolves.toMatchObject({
            loopback: { isolatedFromLanInterface: true },
            lan: { reachableThroughInterface: true },
          });
        } else {
          await expect(proof).rejects.toThrow(
            "Gateway network proof failed: loopback isolation from LAN",
          );
        }
        expect(probeSocket).toBeDefined();
        expect(probeSocket?.destroyed).toBe(true);
      } finally {
        connectSpy.mockRestore();
        probeSocket?.destroy();
      }
    },
    120_000,
  );
});
