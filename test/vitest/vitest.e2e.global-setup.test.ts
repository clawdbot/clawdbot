import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { spawnWatchedVitestProcess } from "../../scripts/run-vitest.mjs";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mjs";
import { runE2eGlobalSetup } from "./vitest.e2e.global-setup.js";

type SetupCommandRunner = NonNullable<Parameters<typeof runE2eGlobalSetup>[0]>;

const posixIt = process.platform === "win32" ? it.skip : it;
const PROCESS_TIMEOUT_MS = process.env.CI ? 15_000 : 5_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await delay(25);
  }
  throw new Error(message);
}

function forceKillProcess(pid: number): void {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  process.kill(pid, "SIGKILL");
}

describe("vitest E2E global setup", () => {
  it("runs both build commands sequentially with their exact environments", async () => {
    let finishFirst: (status: number) => void = () => {};
    const firstCommand = new Promise<number>((resolve) => {
      finishFirst = resolve;
    });
    const runCommand = vi
      .fn<SetupCommandRunner>()
      .mockImplementationOnce(() => firstCommand)
      .mockResolvedValueOnce(0);

    const setupPromise = runE2eGlobalSetup(runCommand);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));

    expect(runCommand.mock.calls[0]?.[0]).toEqual(["scripts/run-node.mjs", "--version"]);
    expect(runCommand.mock.calls[0]?.[1]).toEqual({
      ...process.env,
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);

    finishFirst(0);
    await setupPromise;

    expect(runCommand.mock.calls[1]).toEqual([
      ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
      process.env,
    ]);
  });

  it.each([
    {
      calls: 1,
      statuses: [17],
      command: "scripts/run-node.mjs --version",
    },
    {
      calls: 2,
      statuses: [0, 23],
      command: "scripts/tsdown-build.mjs --config tsdown.ai.config.ts",
    },
  ])("propagates a nonzero status from $command", async ({ calls, statuses, command }) => {
    const runCommand = vi.fn<SetupCommandRunner>();
    for (const status of statuses) {
      runCommand.mockResolvedValueOnce(status);
    }

    await expect(runE2eGlobalSetup(runCommand)).rejects.toThrow(
      `E2E setup command failed with exit code ${statuses.at(-1)}: ${command}`,
    );
    expect(runCommand).toHaveBeenCalledTimes(calls);
  });

  posixIt(
    "streams real child output and leaves no descendants after the runner group is killed",
    async () => {
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-setup-group-"));
      const fixturePath = path.join(fixtureDir, "build-fixture.mjs");
      const childPidPath = path.join(fixtureDir, "child.pid");
      const descendantPidPath = path.join(fixtureDir, "descendant.pid");
      const activityMarker = "e2e-setup-build-active\n";
      const setupModuleUrl = pathToFileURL(
        path.resolve("test/vitest/vitest.e2e.global-setup.ts"),
      ).href;
      let childPid = 0;
      let descendantPid = 0;

      fs.writeFileSync(
        fixturePath,
        [
          'import { spawn } from "node:child_process";',
          'import fs from "node:fs";',
          'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          'if (!descendant.pid) throw new Error("descendant pid unavailable");',
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          `process.stdout.write(${JSON.stringify(activityMarker)});`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );

      const runnerScript = [
        `import { runE2eSetupCommand } from ${JSON.stringify(setupModuleUrl)};`,
        `await runE2eSetupCommand([${JSON.stringify(fixturePath)}], process.env);`,
      ].join("\n");
      const watchedEnv = {
        ...process.env,
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: String(PROCESS_TIMEOUT_MS),
      };
      const watched = spawnWatchedVitestProcess({
        pnpmArgs: [
          "exec",
          "node",
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          runnerScript,
        ],
        spawnParams: {
          detached: true,
          env: watchedEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
        env: watchedEnv,
        label: "E2E global setup process-group regression",
      });
      let output = "";
      watched.child.stdout?.setEncoding("utf8");
      watched.child.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      const completion = watched.completion.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      try {
        await waitFor(
          () =>
            fs.existsSync(childPidPath) &&
            fs.existsSync(descendantPidPath) &&
            output.includes(activityMarker),
          "timed out waiting for streamed setup activity and descendant pids",
        );
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        expect(isProcessAlive(childPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        expect(output).toContain(activityMarker);

        expect(forceKillVitestProcessGroup(watched.child)).toBe(true);
        const outcome = await completion;
        if ("error" in outcome) {
          throw outcome.error;
        }
        expect(outcome.result).toEqual({ code: null, signal: "SIGKILL" });
        await waitFor(
          () => !isProcessAlive(childPid) && !isProcessAlive(descendantPid),
          "setup child processes remained alive after the runner group was killed",
        );
      } finally {
        watched.teardown();
        forceKillVitestProcessGroup(watched.child);
        await completion;
        forceKillProcess(childPid);
        forceKillProcess(descendantPid);
        fs.rmSync(fixtureDir, { force: true, recursive: true });
      }
    },
  );
});
