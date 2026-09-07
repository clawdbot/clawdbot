import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  ensureProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";

describe("provider local service Linux OOM scoring", () => {
  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it.runIf(process.platform === "linux")(
    "raises OOM score without changing configured service environment",
    async ({ skip }) => {
      let hostOomScore: number;
      try {
        hostOomScore = Number.parseInt(
          (await fs.readFile("/proc/self/oom_score_adj", "utf8")).trim(),
          10,
        );
      } catch {
        skip();
        return;
      }
      if (!Number.isFinite(hostOomScore) || hostOomScore >= 1000) {
        skip();
        return;
      }

      const preparedSpawn = prepareOomScoreAdjustedSpawn(process.execPath, [], {
        env: process.env,
      });
      if (!preparedSpawn.wrapped) {
        skip();
        return;
      }

      const port = await getFreePort();
      const healthUrl = `http://127.0.0.1:${port}/v1/models`;
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-oom-"));
      const bashEnvPath = path.join(tempDir, "bash-env.sh");
      const startupMarkerPath = path.join(tempDir, "wrapper-startup-marker");
      await fs.writeFile(bashEnvPath, `printf touched > "${startupMarkerPath}"\n`);
      try {
        const lease = await ensureProviderLocalService({
          providerId: "local-oom-score",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          service: {
            command: process.execPath,
            args: [
              "-e",
              `const fs=require("node:fs");const http=require("node:http");const body=JSON.stringify({oomScore:fs.readFileSync("/proc/self/oom_score_adj","utf8").trim(),bashEnv:process.env.BASH_ENV,envPresent:Object.hasOwn(process.env,"ENV"),env:process.env.ENV,cdpath:process.env.CDPATH,ps4:process.env.PS4,carrierKeys:Object.keys(process.env).filter(key=>key.startsWith("OC_INTERNAL_OOM_EXEC_"))});const server=http.createServer((req,res)=>res.end(body)).listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
            ],
            env: {
              BASH_ENV: bashEnvPath,
              ENV: "",
              CDPATH: "line1\nline2",
              PS4: "final-trace-prefix",
            },
            healthUrl,
            readyTimeoutMs: 5_000,
            idleStopMs: 1,
          },
        });
        if (!lease) {
          throw new Error("Expected provider local service lease");
        }
        expect(await (await fetch(healthUrl)).json()).toEqual({
          oomScore: "1000",
          bashEnv: bashEnvPath,
          envPresent: true,
          env: "",
          cdpath: "line1\nline2",
          ps4: "final-trace-prefix",
          carrierKeys: [],
        });
        await expect(fs.stat(startupMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
        lease.release();
        await expect
          .poll(
            async () => {
              try {
                await fetch(healthUrl);
                return false;
              } catch {
                return true;
              }
            },
            { timeout: 2_000, interval: 50 },
          )
          .toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
