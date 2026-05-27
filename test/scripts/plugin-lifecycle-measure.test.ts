import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs";
const hasTimeoutCommand =
  process.platform === "linux" &&
  spawnSync("bash", ["-lc", "command -v timeout >/dev/null 2>&1"]).status === 0;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-lifecycle-measure-"));
  tempDirs.push(dir);
  return dir;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin lifecycle resource sampler", () => {
  it("configures a phase timeout with process-group cleanup", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS");
    expect(script).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS");
    expect(script).toContain("detached: true");
    expect(script).toContain('process.kill(-child.pid, signal)');
    expect(script).toContain('const summarySignal = timedOut ? "timeout"');
    expect(script).toContain("process.exit(124)");
  });

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
      expect(readFileSync(summary, "utf8")).toMatch(/^wedged\t\d+\t[\d.]+\t\d+\t[\d.]+\ttimeout$/mu);
    },
  );

  it.runIf(process.platform === "linux")(
    "kills stubborn descendants after the timeout grace period",
    () => {
      const dir = makeTempDir();
      const summary = path.join(dir, "summary.tsv");
      const pidFile = path.join(dir, "descendant.pid");
      let descendantPid = 0;

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
            'bash -c \'trap "" TERM; printf "%s\\n" "$$" >"$PID_FILE"; while :; do sleep 1; done\' & wait',
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "150",
              OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "100",
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
        if (descendantPid > 0 && pidExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(hasTimeoutCommand)("forwards external termination to the measured process group", () => {
    const dir = makeTempDir();
    const summary = path.join(dir, "summary.tsv");
    const pidFile = path.join(dir, "descendant.pid");
    let descendantPid = 0;

    try {
      const result = spawnSync(
        "timeout",
        [
          "--kill-after=1s",
          "0.2s",
          "node",
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
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS: "5000",
            OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS: "100",
            PID_FILE: pidFile,
          },
          timeout: 5000,
        },
      );

      descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(result.status).toBe(124);
      expect(waitForPidExit(descendantPid, 1000)).toBe(true);
    } finally {
      if (descendantPid > 0 && pidExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });
});
