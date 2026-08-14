import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
  WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE,
} from "./workspace-quiescence-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watchdog-expiry-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  const stalledProcessProbeTargetPath = path.join(root, "stall-process-probe.target");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nstall() { trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi ;; esac; fi\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then while IFS= read -r extra_pid; do [ -n "$extra_pid" ] && /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid"; done < "$OPENCLAW_TEST_PS_EXTRA"; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    home,
    workspace,
    extraProcessPath,
    stalledProcessProbeTargetPath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      OPENCLAW_TEST_PS_STALL_TARGET: stalledProcessProbeTargetPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

async function expectProcessState(pid: number, suspended: boolean, timeout = 5_000) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim().startsWith("T")).toBe(suspended);
    },
    { interval: 50, timeout },
  );
}

async function expectProcessExited(pid: number, timeout = 5_000) {
  await vi.waitFor(
    async () => {
      const result = await runCommandWithTimeout(["ps", "-o", "stat=", "-p", String(pid)], {
        timeoutMs: 2_000,
      });
      expect(result.code !== 0 || /^[ZX]/u.test(result.stdout.trim())).toBe(true);
    },
    { interval: 50, timeout },
  );
}

async function terminate(child: ReturnType<typeof spawn>) {
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGCONT");
    } catch {}
  }
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await once(child, "exit");
  }
}

describe("remote workspace quiescence watchdog expiry", () => {
  it("keeps terminal recovery fenced when its retained watchdog reaches expiry", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const childPid = child.pid!;
    let watchdogPid = 0;

    try {
      await fs.writeFile(input.extraProcessPath, `${childPid}\n`);
      const quiesce = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
        { timeoutMs: 20_000, baseEnv: input.env },
      );
      expect(quiesce.code, quiesce.stderr).toBe(0);
      const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesce.stdout)?.[1];
      expect(nonce).toBeDefined();
      await expectProcessState(childPid, true);
      const leaseFile = leasePath(input.home, input.workspace, nonce!);
      const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
      };
      watchdogPid = lease.watchdog.pid;
      await fs.writeFile(
        input.stalledProcessProbeTargetPath,
        `${lease.watchdog.pid}\n${childPid}\n`,
      );

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce!],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).toBe(WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE);
      const terminal = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
        watchdog: { pid: number; start: string };
        processes: Array<{ pid: number }>;
        recovery?: { state: string };
      };
      expect(terminal.watchdog).toEqual(lease.watchdog);
      expect(terminal.processes.map((entry) => entry.pid)).toEqual([childPid]);
      expect(terminal.recovery?.state).toBe("probe-timeout");

      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      await expectProcessExited(lease.watchdog.pid, 8_000);
      await expectProcessState(childPid, true);
      await expect(fs.access(leaseFile)).resolves.toBeUndefined();
    } finally {
      await fs.rm(input.extraProcessPath, { force: true });
      await fs.rm(input.stalledProcessProbeTargetPath, { force: true });
      if (watchdogPid > 0) {
        try {
          process.kill(watchdogPid, "SIGKILL");
        } catch {}
      }
      await terminate(child);
    }
  }, 25_000);
});
