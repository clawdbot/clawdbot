// Plugin Lifecycle Measure tests cover plugin lifecycle measure script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs";

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-lifecycle-measure-"));
  tempDirs.push(dir);
  return dir;
}

function writeFakeGetconf(dir: string, body: string): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const getconfPath = path.join(binDir, "getconf");
  writeFileSync(getconfPath, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(getconfPath, 0o755);
  return binDir;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForPidExit(pid: number, timeoutMs: number): boolean {
  const waitBuffer = new SharedArrayBuffer(4);
  const waitView = new Int32Array(waitBuffer);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) {
      return true;
    }
    Atomics.wait(waitView, 0, 0, 25);
  }
  return !pidExists(pid);
}

function waitForPath(filePath: string, timeoutMs: number): boolean {
  const waitBuffer = new SharedArrayBuffer(4);
  const waitView = new Int32Array(waitBuffer);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return true;
    }
    Atomics.wait(waitView, 0, 0, 25);
  }
  return existsSync(filePath);
}

function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for measured wrapper to exit"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin lifecycle resource sampler", () => {
  it.runIf(process.platform === "linux")(
    "derives proc units from getconf when overrides are absent",
    () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const logPath = path.join(dir, "getconf.log");
      const binDir = writeFakeGetconf(
        dir,
        'printf "%s\\n" "$1" >>"$GETCONF_LOG"\ncase "$1" in PAGESIZE) echo 16384 ;; CLK_TCK) echo 250 ;; esac',
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GETCONF_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      };
      delete env.OPENCLAW_PROC_PAGE_SIZE;
      delete env.OPENCLAW_PROC_CLK_TCK;

      const result = spawnSync(
        process.execPath,
        [scriptPath, summary, "getconf-units", "--", process.execPath, "-e", ""],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env,
          timeout: 5000,
        },
      );

      expect(readFileSync(logPath, "utf8")).toBe("PAGESIZE\nCLK_TCK\n");
      expect(result.stderr).not.toContain("failed to derive OPENCLAW_PROC");
    },
  );

  it("rejects loose numeric env values instead of parsing prefixes", () => {
    const dir = makeTempDir();
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "150ms",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS must be a positive integer; got: 150ms",
    );
  });

  it("rejects zero lifecycle timeouts instead of disabling the guard", () => {
    const dir = makeTempDir();
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "0",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS must be a positive integer; got: 0",
    );
  });

  it("rejects loose resource ceiling env values instead of parsing prefixes", () => {
    const dir = makeTempDir();
    const summary = path.join(dir, "summary.tsv");
    const result = spawnSync("node", [scriptPath, summary, "invalid-env", "--", "node", "-e", ""], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO: "1x",
      },
      timeout: 5000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO must be a positive number; got: 1x",
    );
  });

  it("configures a phase timeout with process-group cleanup", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO");
    expect(script).toContain("detached: true");
    expect(script).toContain("process.kill(-child.pid, signal)");
    expect(script).toContain("plugin lifecycle resource ceiling exceeded");
    expect(script).toContain('const summarySignal = timedOut ? "timeout"');
    expect(script).toContain("process.exit(124)");
  });

  it.runIf(process.platform === "linux")(
    "fails successful phases that exceed wall ceilings",
    () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const result = spawnSync(
        "node",
        [scriptPath, summary, "slow-success", "--", "node", "-e", "setTimeout(() => {}, 40)"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
            OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS: "1",
          },
          timeout: 5000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("plugin lifecycle resource ceiling exceeded");
      expect(result.stderr).toContain("wall_ms=");
      expect(readFileSync(summary, "utf8")).toMatch(/^slow-success\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu);
    },
  );

  it.runIf(process.platform === "linux")(
    "times out wedged phases and records the timeout signal",
    () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const result = spawnSync(
        "node",
        [scriptPath, summary, "wedged", "--", "node", "-e", "setInterval(() => {}, 1000)"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "150",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "50",
          },
          timeout: 5000,
        },
      );

      expect(result.status).toBe(124);
      expect(result.stdout).toContain("signal=timeout");
      expect(readFileSync(summary, "utf8")).toMatch(
        /^wedged\t\d+\t[\d.]+\t\d+\t[\d.]+\ttimeout$/mu,
      );
    },
  );

  it.runIf(process.platform === "linux")("clamps oversized timer env values", () => {
    const dir = makeTempDir();
    const summary = path.join(dir, "summary.tsv");
    const oversizedTimerMs = "2147000001";
    const result = spawnSync(
      "node",
      [
        scriptPath,
        summary,
        "oversized-timers",
        "--",
        "node",
        "-e",
        "setTimeout(() => process.exit(0), 25)",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS: oversizedTimerMs,
          OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: oversizedTimerMs,
          OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: oversizedTimerMs,
        },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
    expect(readFileSync(summary, "utf8")).toMatch(
      /^oversized-timers\t\d+\t[\d.]+\t\d+\t[\d.]+\t$/mu,
    );
  });

  it.runIf(process.platform === "linux")(
    "kills stubborn descendants after the timeout grace period",
    () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const pidFile = path.join(dir, "descendant.pid");
      let descendantPid: number | undefined;

      try {
        const result = spawnSync(
          "node",
          [
            scriptPath,
            summary,
            "stubborn-descendant",
            "--",
            "bash",
            "-lc",
            [
              'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; while :; do sleep 1; done\' &',
              'while [ ! -s "$PID_FILE" ]; do sleep 0.01; done',
              "exit 0",
            ].join("\n"),
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "250",
              OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "50",
              PID_FILE: pidFile,
            },
            timeout: 5000,
          },
        );

        descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        expect(result.status).toBe(124);
        expect(result.stdout).toContain("signal=timeout");
        expect(readFileSync(summary, "utf8")).toMatch(
          /^stubborn-descendant\t\d+\t[\d.]+\t\d+\t[\d.]+\ttimeout$/mu,
        );
        expect(waitForPidExit(descendantPid, 1000)).toBe(true);
      } finally {
        if (descendantPid !== undefined && descendantPid > 0 && pidExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "forwards external termination to the measured process group",
    async () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const pidFile = path.join(dir, "descendant.pid");
      let descendantPid: number | undefined;

      try {
        const result = spawn(
          process.execPath,
          [
            scriptPath,
            summary,
            "external-stop",
            "--",
            "bash",
            "-lc",
            'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; while :; do sleep 1; done\' & wait',
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
              OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "200",
              PID_FILE: pidFile,
            },
            stdio: "ignore",
          },
        );

        expect(waitForPath(pidFile, 2000)).toBe(true);
        descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        result.kill("SIGTERM");
        const close = await waitForChildClose(result, 5000);
        expect(close.signal).toBe("SIGTERM");
        expect(waitForPidExit(descendantPid, 1000)).toBe(true);
      } finally {
        if (descendantPid !== undefined && descendantPid > 0 && pidExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "exits promptly when externally terminated phases stop during grace",
    async () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const readyFile = path.join(dir, "ready.pid");
      const result = spawn(
        "node",
        [
          scriptPath,
          summary,
          "external-fast-stop",
          "--",
          "node",
          "--input-type=module",
          "--eval",
          [
            "import { writeFileSync } from 'node:fs';",
            "writeFileSync(process.env.READY_FILE, String(process.pid));",
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "1500",
            READY_FILE: readyFile,
          },
          stdio: "ignore",
        },
      );

      expect(waitForPath(readyFile, 1000)).toBe(true);
      const started = Date.now();
      result.kill("SIGTERM");
      const close = await waitForChildClose(result, 5000);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(close.signal).toBe("SIGTERM");
    },
  );

  it.runIf(process.platform === "linux")(
    "exits promptly when shell descendants drain during termination grace",
    async () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const readyFile = path.join(dir, "ready.pid");
      const result = spawn(
        "node",
        [
          scriptPath,
          summary,
          "external-descendant-drain",
          "--",
          "bash",
          "-lc",
          'trap "exit 0" TERM; bash -c \'trap "sleep 0.15; exit 0" TERM; printf "%s\\n" "$$" >"$READY_FILE"; while :; do sleep 1; done\' & wait',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "1500",
            READY_FILE: readyFile,
          },
          stdio: "ignore",
        },
      );

      expect(waitForPath(readyFile, 1000)).toBe(true);
      const started = Date.now();
      result.kill("SIGTERM");
      const close = await waitForChildClose(result, 5000);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(close.signal).toBe("SIGTERM");
    },
  );
});
