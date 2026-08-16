// Real-process proof that the execa-backed provisioning timeout kills a wedged
// engine process and settles with the typed error, without any mocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { DOCKER_SANDBOX_ENGINE, execContainerRaw } from "./container-engine.js";

const tmpDirs: string[] = [];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("execContainerRaw wedged engine (real process)", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "times out against a wedged docker shim and kills the child",
    async () => {
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wedged-shim-"));
      tmpDirs.push(shimDir);
      const pidFile = path.join(shimDir, "docker.pid");
      const shimPath = path.join(shimDir, "docker");
      fs.writeFileSync(shimPath, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 600\n`);
      fs.chmodSync(shimPath, 0o755);

      const shimPathEnv = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
      await withEnvAsync({ PATH: shimPathEnv }, async () => {
        const error = await execContainerRaw(DOCKER_SANDBOX_ENGINE, ["version"], {
          timeoutMs: 500,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error & { code?: string }).code).toBe("SANDBOX_CONTAINER_TIMEOUT");

        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        // execa escalates SIGTERM to SIGKILL after its 5s default grace.
        await expect.poll(() => isProcessAlive(pid), { timeout: 8000 }).toBe(false);
      });
    },
    20_000,
  );
});
