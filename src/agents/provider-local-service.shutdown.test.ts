import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  ensureProviderLocalService,
  getManagedProviderLocalServiceDiagnosticsForTest,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("missing test port"));
        }
      });
    });
  });
}

describe("provider local service shutdown", () => {
  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it("waits for a stubborn service to exit before host shutdown returns", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    let pid: number | undefined;

    try {
      const lease = await ensureProviderLocalService({
        providerId: "local-stubborn-stop",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        service: {
          command: process.execPath,
          args: [
            "-e",
            `const http=require("node:http");process.on("SIGTERM",()=>{});http.createServer((req,res)=>res.end("ok")).listen(${port},"127.0.0.1");`,
          ],
          healthUrl,
          readyTimeoutMs: 5_000,
          idleStopMs: 0,
        },
      });
      if (!lease) {
        throw new Error("Expected provider local service lease");
      }
      pid = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.pid;
      if (!pid) {
        throw new Error("Expected managed provider local service pid");
      }

      await stopManagedProviderLocalServices();

      expect(isPidAlive(pid)).toBe(false);
      lease.release();
    } finally {
      killPidIfAlive(pid);
    }
  });
});
