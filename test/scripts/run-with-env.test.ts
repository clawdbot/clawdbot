import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";
import {
  isRunWithEnvHelpRequest,
  parseRunWithEnvArgs,
  resolveForceKillDelayMs,
  resolveSpawnCommand,
} from "../../scripts/run-with-env.mts";
import { waitForPidFile } from "../helpers/process-wait.js";
import { withTestTimeout } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

// These subprocess fixtures expose explicit ready files. Cold tsx startup can exceed a few
// seconds on a loaded maintainer host, so this only bounds genuine fixture hangs.
const PROCESS_READY_TIMEOUT_MS = 30_000;

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = PROCESS_READY_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function spawnWrapperFixture(
  tempDir: string,
  assignments: string[],
  childScript: string,
  env?: NodeJS.ProcessEnv,
) {
  const pidFile = path.join(tempDir, "wrapped-pid");
  const wrapper = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/run-with-env.mts",
      ...assignments,
      "--",
      "node",
      "-e",
      [
        // Publish the detached group before this fixture can create descendants.
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile + ".tmp")}, String(process.pid));`,
        `require('node:fs').renameSync(${JSON.stringify(pidFile + ".tmp")}, ${JSON.stringify(pidFile)});`,
        childScript,
      ].join("\n"),
    ],
    { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let closed = false;
  let childError: Error | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      wrapper.once("error", (error) => {
        childError = error;
      });
      wrapper.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    },
  );
  // Inherited pipes keep an unrecorded, still-starting command observable after wrapper exit.
  wrapper.stdout.resume();
  wrapper.stderr.resume();
  let shutdownRequested = false;
  const signal = (value: NodeJS.Signals) => {
    shutdownRequested = true;
    return wrapper.kill(value);
  };

  return {
    signal,
    async waitForExit() {
      const exit = await withTestTimeout(completion, 3_000, "timed out waiting for wrapper close");
      if (childError) {
        throw childError;
      }
      return exit;
    },
    async cleanup(this: void) {
      // Do not signal twice: after its child exits, the wrapper removes its handlers
      // while it still gives descendants their shutdown grace period.
      if (!closed && !shutdownRequested) {
        signal("SIGTERM");
      }
      // The assertion's exit wait still rejects; teardown owns bounded escalation.
      await withTestTimeout(completion, 3_000, "wrapper still draining").catch(() => undefined);
      // The wrapper owns tsx helper processes in its group; the wrapped command
      // creates a separate group whose identity is recorded by the fixture.
      if (
        wrapper.pid &&
        inspectManagedProcessGroup(wrapper, { errorPolicy: "indeterminate" }) !== "dead"
      ) {
        terminateManagedChild(wrapper, "SIGKILL", { processGroupFallback: "never" });
      }
      await waitFor(
        () => closed || existsSync(pidFile),
        `wrapped command identity or closed pipes; retained fixture: ${tempDir}`,
      );
      if (existsSync(pidFile)) {
        const pid = await waitForPidFile(pidFile, 5_000);
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          throw new Error(`invalid wrapped command PID; retained fixture: ${tempDir}`);
        }
        const group = { pid };
        if (inspectManagedProcessGroup(group, { errorPolicy: "indeterminate" }) !== "dead") {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
        await waitFor(
          () => inspectManagedProcessGroup(group, { errorPolicy: "indeterminate" }) === "dead",
          `wrapped group exit before removing fixture: ${tempDir}`,
          5_000,
        );
      }
      await withTestTimeout(
        completion,
        5_000,
        `wrapper did not close; retained fixture: ${tempDir}`,
      );
      if (wrapper.pid) {
        await waitFor(
          () => inspectManagedProcessGroup(wrapper, { errorPolicy: "indeterminate" }) === "dead",
          `wrapper group exit before removing fixture: ${tempDir}`,
          5_000,
        );
      }
      rmSync(tempDir, { force: true, recursive: true });
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("run-with-env", () => {
  it("parses leading env assignments before the command separator", () => {
    expect(
      parseRunWithEnvArgs([
        "OPENCLAW_GATEWAY_PROJECT_SHARDS=1",
        "EMPTY=",
        "--",
        "node",
        "scripts/run-vitest.mjs",
        "run",
      ]),
    ).toEqual({
      env: {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "1",
        EMPTY: "",
      },
      command: "node",
      args: ["scripts/run-vitest.mjs", "run"],
    });
  });

  it("rejects missing command separators", () => {
    expect(() => parseRunWithEnvArgs(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "node"])).toThrow(
      /Usage:/u,
    );
  });

  it("prints wrapper help without spawning a command", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/run-with-env.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node --import tsx scripts/run-with-env.mts");
    expect(result.stderr).toBe("");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it("rejects malformed assignments before spawning", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-with-env.mts",
        "1INVALID=value",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid environment assignment");
  });

  it("uses the current Node executable for bare Node command names", () => {
    const args = ["scripts/run-vitest.mjs"];
    expect(resolveSpawnCommand("node", args, "/usr/bin/node", "linux")).toEqual({
      command: "/usr/bin/node",
      args,
    });
    for (const command of ["node", "NODE", "node.exe", "Node.Exe"]) {
      expect(resolveSpawnCommand(command, args, "C:\\Node24\\node.exe", "win32")).toEqual({
        command: "C:\\Node24\\node.exe",
        args,
      });
    }
  });

  it("preserves platform-specific and explicitly pathed commands", () => {
    const args = ["scripts/run-vitest.mjs"];
    for (const command of ["NODE", "node.exe", "C:\\Tools\\node.exe"]) {
      expect(resolveSpawnCommand(command, args, "/usr/bin/node", "linux")).toEqual({
        command,
        args,
      });
    }
    expect(
      resolveSpawnCommand("C:\\Tools\\node.exe", args, "C:\\Node24\\node.exe", "win32"),
    ).toEqual({
      command: "C:\\Tools\\node.exe",
      args,
    });
  });

  it("rejects malformed force-kill grace configuration before spawning", () => {
    expect(resolveForceKillDelayMs({})).toBe(5_000);
    expect(resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "  " })).toBe(5_000);
    expect(resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "250" })).toBe(250);
    expect(
      resolveForceKillDelayMs({
        OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    for (const value of ["0", "-1", "1e3", "100ms"]) {
      expect(() => resolveForceKillDelayMs({ OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: value })).toThrow(
        "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
      );
    }

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-with-env.mts",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "100ms" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer",
    );
  });

  it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP", "SIGINT"] as const)(
    "forwards parent %s to the wrapped command",
    async (signal) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-signals-"));
      const readyFile = path.join(tempDir, "ready");
      const signaledFile = path.join(tempDir, "signaled");
      const handlerLines = ["SIGTERM", "SIGHUP", "SIGINT"].flatMap((handledSignal) => [
        `process.on('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        "  setTimeout(() => process.exit(0), 25);",
        "});",
      ]);
      const childScript = [
        "const fs = require('node:fs');",
        ...handlerLines,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const fixture = spawnWrapperFixture(
        tempDir,
        [`READY_FILE=${readyFile}`, `SIGNALED_FILE=${signaledFile}`],
        childScript,
      );

      await runQaGatewayFixture(async () => {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        fixture.signal(signal);

        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal });
        expect(readFileSync(signaledFile, "utf8")).toBe(signal);
      }, fixture.cleanup);
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up wrapped command descendants on wrapper shutdown",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-descendants-"));
      const readyFile = path.join(tempDir, "ready");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildPidFile = path.join(tempDir, "grandchild-pid");
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));",
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const fixture = spawnWrapperFixture(
        tempDir,
        [
          `READY_FILE=${readyFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
          `GRANDCHILD_PID_FILE=${grandchildPidFile}`,
        ],
        childScript,
        { ...process.env, OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: "200" },
      );

      await runQaGatewayFixture(async () => {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        await waitFor(
          () => existsSync(grandchildReadyFile),
          "wrapped command descendant readiness",
        );
        const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
        expect(grandchildPid).toBeGreaterThan(0);
        expect(isProcessAlive(grandchildPid)).toBe(true);

        fixture.signal("SIGTERM");
        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(
          () => !isProcessAlive(grandchildPid),
          "wrapped command descendant cleanup",
          5_000,
        );
      }, fixture.cleanup);
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets wrapped command descendants finish during the shutdown grace period",
    async () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-grace-"));
      const readyFile = path.join(tempDir, "ready");
      const gracefulFile = path.join(tempDir, "graceful");
      const grandchildReadyFile = path.join(tempDir, "grandchild-ready");
      const grandchildScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync(process.env.GRACEFUL_FILE, 'done');",
        "    process.exit(0);",
        "  }, 75);",
        "});",
        "fs.writeFileSync(process.env.GRANDCHILD_READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const fixture = spawnWrapperFixture(
        tempDir,
        [
          `READY_FILE=${readyFile}`,
          `GRACEFUL_FILE=${gracefulFile}`,
          `GRANDCHILD_READY_FILE=${grandchildReadyFile}`,
        ],
        childScript,
        {
          ...process.env,
          OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        },
      );

      await runQaGatewayFixture(async () => {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        await waitFor(
          () => existsSync(grandchildReadyFile),
          "wrapped command descendant readiness",
        );
        fixture.signal("SIGTERM");

        const exit = await fixture.waitForExit();
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(readFileSync(gracefulFile, "utf8")).toBe("done");
      }, fixture.cleanup);
    },
  );

  it.runIf(process.platform !== "win32")("preserves wrapped command signal exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-with-env.mts",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it.runIf(process.platform !== "win32")("preserves wrapped command force-kill exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-with-env.mts",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGKILL')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });
});
