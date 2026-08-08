// Vitest E2E global setup tests cover shared artifact build orchestration.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildSharedE2EArtifacts,
  runE2ESetupCommand,
  type E2ESetupCommandRunner,
} from "./vitest.e2e.global-setup.ts";

function createSpawnMock({
  exitCode = 0,
  signal = null,
}: {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
} = {}) {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  const spawnMock = vi.fn(() => {
    queueMicrotask(() => {
      child.emit("exit", exitCode, signal);
    });
    return child;
  });
  return {
    child,
    spawnCommand: spawnMock as unknown as typeof spawn,
    spawnMock,
  };
}

describe("vitest e2e global setup", () => {
  it("runs setup commands with inherited output for the CI watchdog", async () => {
    const env: NodeJS.ProcessEnv = { CI: "true" };
    const { spawnCommand, spawnMock } = createSpawnMock();

    await runE2ESetupCommand(["scripts/run-node.mjs", "--version"], {
      cwd: "/repo",
      env,
      execPath: "node-bin",
      label: "build shared CLI/private QA artifacts",
      spawnCommand,
      timeoutMs: 60_000,
    });

    expect(spawnMock).toHaveBeenCalledWith("node-bin", ["scripts/run-node.mjs", "--version"], {
      cwd: "/repo",
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  });

  it("reports setup command failures with the command label", async () => {
    const { spawnCommand } = createSpawnMock({ exitCode: 7 });

    await expect(
      runE2ESetupCommand(["scripts/run-node.mjs", "--version"], {
        execPath: "node-bin",
        label: "build shared CLI/private QA artifacts",
        spawnCommand,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("build shared CLI/private QA artifacts failed (exit 7)");
  });

  it("prebuilds private QA artifacts before AI package artifacts", async () => {
    const env: NodeJS.ProcessEnv = {
      CI: "true",
      OPENCLAW_BUILD_PRIVATE_QA: "0",
    };
    const runCommand = vi.fn(async () => {});

    await buildSharedE2EArtifacts({
      cwd: "/repo",
      env,
      execPath: "node-bin",
      runCommand: runCommand as E2ESetupCommandRunner,
    });

    expect(runCommand).toHaveBeenNthCalledWith(1, ["scripts/run-node.mjs", "--version"], {
      cwd: "/repo",
      env: {
        CI: "true",
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
      execPath: "node-bin",
      label: "build shared CLI/private QA artifacts",
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
      {
        cwd: "/repo",
        env,
        execPath: "node-bin",
        label: "build AI package artifacts",
      },
    );
  });
});
