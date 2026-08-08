import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  forceKillVitestProcessGroup,
  forwardSignalToVitestProcessGroup,
} from "../../scripts/vitest-process-group.mjs";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { runE2eGlobalSetup } from "../vitest/vitest.e2e.global-setup.js";

type SetupCommandRunner = NonNullable<Parameters<typeof runE2eGlobalSetup>[0]>;

const posixIt = process.platform === "win32" ? it.skip : it;
const PROCESS_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

describe("vitest E2E global setup", () => {
  it("runs both build commands sequentially with their exact environments", async () => {
    let resolveFirstCommand!: (status: number) => void;
    const firstCommand = new Promise<number>((resolve) => {
      resolveFirstCommand = resolve;
    });
    const runCommand = vi
      .fn<SetupCommandRunner>()
      .mockImplementationOnce(() => firstCommand)
      .mockResolvedValueOnce(0);

    const setupPromise = runE2eGlobalSetup(runCommand);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    resolveFirstCommand(0);
    await setupPromise;
    expect(runCommand.mock.calls).toEqual([
      [
        ["scripts/run-node.mjs", "--version"],
        {
          ...process.env,
          OPENCLAW_BUILD_PRIVATE_QA: "1",
          OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
        },
      ],
      [["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"], process.env],
    ]);
  });

  it("propagates a nonzero command status", async () => {
    const runCommand = vi
      .fn<SetupCommandRunner>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(23);
    await expect(runE2eGlobalSetup(runCommand)).rejects.toThrow(
      "E2E setup command failed with exit code 23: scripts/tsdown-build.mjs --config tsdown.ai.config.ts",
    );
  });

  posixIt("forwards output and SIGTERM through the runner process group", async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-setup-group-"));
    const fixturePath = path.join(fixtureDir, "build-fixture.mjs");
    const pidPaths = ["child.pid", "descendant.pid"].map((name) => path.join(fixtureDir, name));
    fs.writeFileSync(
      fixturePath,
      `import { spawn } from "node:child_process";
import fs from "node:fs";
process.stdin.once("data", () => {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(pidPaths[0])}, String(process.pid));
  fs.writeFileSync(${JSON.stringify(pidPaths[1])}, String(descendant.pid));
  process.stdout.write("setup-stdout\\n");
  process.stderr.write("setup-stderr\\n");
  setInterval(() => {}, 1000);
});
process.stdin.resume();
`,
    );
    const setupUrl = new URL("../vitest/vitest.e2e.global-setup.ts", import.meta.url).href;
    const runnerScript = `import { runE2eSetupCommand } from ${JSON.stringify(setupUrl)};
await runE2eSetupCommand([${JSON.stringify(fixturePath)}], process.env);`;
    const runner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", runnerScript],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const pids: number[] = [];
    let stdout = "";
    let stderr = "";
    runner.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    runner.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

    try {
      runner.stdin.write("start\n");
      pids.push(
        ...(await Promise.all(pidPaths.map((file) => waitForPidFile(file, PROCESS_TIMEOUT_MS)))),
      );
      await vi.waitFor(() => {
        expect(stdout).toContain("setup-stdout");
        expect(stderr).toContain("setup-stderr");
      });
      const closed = waitForChildClose(runner, PROCESS_TIMEOUT_MS);
      expect(
        forwardSignalToVitestProcessGroup({
          child: runner,
          kill: process.kill.bind(process),
          signal: "SIGTERM",
        }),
      ).toBe(true);
      await expect(closed).resolves.toEqual({ code: null, signal: "SIGTERM" });
      await Promise.all(pids.map((pid) => waitForDead(pid, PROCESS_TIMEOUT_MS)));
    } finally {
      forceKillVitestProcessGroup(runner);
      for (const pid of pids) {
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      fs.rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
