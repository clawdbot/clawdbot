import { afterAll, beforeAll, describe } from "vitest";
import { approveDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { startServerWithClient } from "./test-helpers.js";

export function createNodePairingTestState(prefix: string) {
  const tempDirs = createSuiteTempRootTracker({ prefix });

  return {
    setup: async () => await tempDirs.setup(),
    cleanup: async () => await tempDirs.cleanup(),
    makeStateDir: async () => await tempDirs.make("case"),
    seedNodeDevice: async (nodeId: string, baseDir?: string) => {
      const request = await requestDevicePairing(
        { deviceId: nodeId, publicKey: `pk-${nodeId}`, role: "node", roles: ["node"], scopes: [] },
        baseDir,
      );
      await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
    },
  };
}

export function describeWithGatewayServer(
  name: string,
  defineTests: (getStarted: () => Awaited<ReturnType<typeof startServerWithClient>>) => void,
): void {
  describe(name, () => {
    let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;

    beforeAll(async () => {
      started = await startServerWithClient("secret");
    });

    afterAll(async () => {
      started?.ws.close();
      await started?.server.close();
      started?.envSnapshot.restore();
    });

    defineTests(() => {
      if (!started) {
        throw new Error("gateway test server was not started");
      }
      return started;
    });
  });
}
