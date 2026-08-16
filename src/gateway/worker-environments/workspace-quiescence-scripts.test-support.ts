import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export async function fixture() {
  const root = tempDirs.make("openclaw-quiescence-test-");
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  const stalledProcessProbePath = path.join(root, "stall-process-probe");
  const stalledProcessProbePidPath = path.join(root, "stall-process-probe.pid");
  const stalledAllProcessProbePath = path.join(root, "stall-all-process-probes");
  const stalledProcessProbeTargetPath = path.join(root, "stall-process-probe.target");
  const stalledProcessProbeOnceTargetPath = path.join(root, "stall-process-probe-once.target");
  const delayedProcessProbeTargetPath = path.join(root, "delay-process-probe.target");
  const failedProcessProbeTargetPath = path.join(root, "fail-process-probe.target");
  const zombieProcessProbeTargetPath = path.join(root, "zombie-process-probe.target");
  const failedProcessScanPath = path.join(root, "fail-process-scan");
  const failedProcessScanStatePath = path.join(root, "fail-process-scan.state");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\nstall() { printf "%s\\n" "$$" >> "$OPENCLAW_TEST_PS_STALL_PID"; trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL" ]; then rm -f "$OPENCLAW_TEST_PS_STALL"; stall; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_ALL" ]; then case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) stall ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET"; then rm -f "$OPENCLAW_TEST_PS_STALL_ONCE_TARGET"; stall; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_DELAY_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_DELAY_TARGET"; then sleep 0.9; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_FAIL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_FAIL_TARGET"; then exit 2; fi ;; esac; fi\nif [ -f "$OPENCLAW_TEST_PS_ZOMBIE_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_ZOMBIE_TARGET"; then start=$(/bin/ps -o lstart= -p "$target"); if [ -n "$start" ]; then printf "Z %s\\n" "$start"; exit 0; fi; fi ;; esac; fi\ncase "$*" in *"pid=,ppid=,uid=,stat=,lstart="*) if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN.seen" ]; then extra_pid=$(head -n 1 "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o stat= -p "$extra_pid" > "$OPENCLAW_TEST_PS_FAIL_SCAN_STATE"; exit 2; fi ;; esac\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then while IFS= read -r extra_pid; do [ -n "$extra_pid" ] && /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid"; done < "$OPENCLAW_TEST_PS_EXTRA"; fi; if [ -f "$OPENCLAW_TEST_PS_FAIL_SCAN" ]; then touch "$OPENCLAW_TEST_PS_FAIL_SCAN.seen"; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
    OPENCLAW_TEST_PS_STALL: stalledProcessProbePath,
    OPENCLAW_TEST_PS_STALL_PID: stalledProcessProbePidPath,
    OPENCLAW_TEST_PS_STALL_ALL: stalledAllProcessProbePath,
    OPENCLAW_TEST_PS_STALL_TARGET: stalledProcessProbeTargetPath,
    OPENCLAW_TEST_PS_STALL_ONCE_TARGET: stalledProcessProbeOnceTargetPath,
    OPENCLAW_TEST_PS_DELAY_TARGET: delayedProcessProbeTargetPath,
    OPENCLAW_TEST_PS_FAIL_TARGET: failedProcessProbeTargetPath,
    OPENCLAW_TEST_PS_ZOMBIE_TARGET: zombieProcessProbeTargetPath,
    OPENCLAW_TEST_PS_FAIL_SCAN: failedProcessScanPath,
    OPENCLAW_TEST_PS_FAIL_SCAN_STATE: failedProcessScanStatePath,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return {
    bin,
    home,
    workspace,
    extraProcessPath,
    stalledProcessProbePath,
    stalledProcessProbePidPath,
    stalledAllProcessProbePath,
    stalledProcessProbeTargetPath,
    stalledProcessProbeOnceTargetPath,
    delayedProcessProbeTargetPath,
    failedProcessProbeTargetPath,
    zombieProcessProbeTargetPath,
    failedProcessScanPath,
    failedProcessScanStatePath,
    env,
  };
}

export async function useBatchedDelayedProcessFixture(input: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(
    path.join(input.bin, "ps"),
    '#!/bin/sh\nstall() { trap "" TERM; exec sleep 30; }\nif [ -f "$OPENCLAW_TEST_PS_STALL_TARGET" ]; then target=""; for argument in "$@"; do target=$argument; done; case "$*" in *"stat=,lstart= -p"*|*"lstart= -p"*) if grep -qx "$target" "$OPENCLAW_TEST_PS_STALL_TARGET"; then stall; fi ;; esac; fi\ncase "$*" in\n  *"pid=,ppid=,uid=,stat=,lstart="*) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -s "$OPENCLAW_TEST_PS_EXTRA" ]; then pids=$(paste -sd, "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$pids"; fi ;;\n  *"stat=,lstart= -p"*|*"lstart= -p"*) target=""; for argument in "$@"; do target=$argument; done; if [ -f "$OPENCLAW_TEST_PS_DELAY_TARGET" ] && grep -qx "$target" "$OPENCLAW_TEST_PS_DELAY_TARGET"; then /bin/sleep 0.7; fi; exec /bin/ps "$@" ;;\nesac\n',
  );
}

export async function runQuiesce(
  input: Awaited<ReturnType<typeof fixture>>,
  watchdogTimeoutMs = 10_000,
  commandTimeoutMs = 10_000,
  sharedHost = false,
) {
  return await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      input.workspace,
      String(watchdogTimeoutMs),
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: commandTimeoutMs, baseEnv: input.env },
  );
}

export async function quiesce(
  input: Awaited<ReturnType<typeof fixture>>,
  watchdogTimeoutMs = 10_000,
  commandTimeoutMs = 10_000,
  sharedHost = false,
) {
  const result = await runQuiesce(input, watchdogTimeoutMs, commandTimeoutMs, sharedHost);
  expect(result.code, result.stderr).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

export function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

export async function processStart(pid: number) {
  const result = await runCommandWithTimeout(["ps", "-o", "lstart=", "-p", String(pid)], {
    timeoutMs: 2_000,
  });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

export async function expectProcessState(pid: number, suspended: boolean, timeout = 5_000) {
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

export async function expectProcessExited(pid: number, timeout = 5_000) {
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

export async function terminate(child: ReturnType<typeof spawn>) {
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

export async function resume(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  expectedCode = 0,
) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code, result.stderr).toBe(expectedCode);
}

export async function renew(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  commandTimeoutMs = 10_000,
  sharedHost = false,
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
      input.workspace,
      nonce,
      "20000",
      "final",
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: commandTimeoutMs, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`renewed ${nonce}\n`);
}
