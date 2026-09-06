import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it("waits for a stubborn descendant after its parent exits", async () => {
    const port = await freePort();
    const healthUrl = `http://127.0.0.1:${port}/v1/models`;
    const descendantPidPath = path.join(tempDirs.make("local-service-tree-"), "descendant.pid");
    let pid: number | undefined;
    let descendantPid: number | undefined;

    try {
      const lease = await ensureProviderLocalService({
        providerId: "local-stubborn-stop",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        service: {
          command: process.execPath,
          args: [
            "-e",
            `const {spawn}=require("node:child_process");const fs=require("node:fs");const http=require("node:http");const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));http.createServer((req,res)=>res.end("ok")).listen(${port},"127.0.0.1");`,
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
      descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));

      await stopManagedProviderLocalServices();

      expect(isPidAlive(pid)).toBe(false);
      expect(isPidAlive(descendantPid)).toBe(false);
      lease.release();
    } finally {
      killPidIfAlive(descendantPid);
      killPidIfAlive(pid);
    }
  });
});
