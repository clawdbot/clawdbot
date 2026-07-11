/* oxlint-disable eslint/prefer-const, eslint/no-promise-executor-return -- process-lifecycle tests retain timer initialization and callback expressions matching the exercised script. */
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const commonScript = join(repoRoot, "scripts/pr-lib/common.sh");
const lockScript = join(repoRoot, "scripts/pr-lib/operation-lock.sh");
const processGroupRunner = join(repoRoot, "scripts/pr-lib/process-group-runner.mjs");
const managedChildUrl = pathToFileURL(join(repoRoot, "scripts/lib/managed-child-process.mjs")).href;
const worktreeScript = join(repoRoot, "scripts/pr-lib/worktree.sh");
const lockRef = "refs/openclaw/pr-operation-locks/42";
const detachedChildren = new WeakSet<ChildProcess>();
const goneProcessGroups = new Set<number>();

// Direct preload affects only the supervisor; operation fixtures keep real clocks.
// The source assertions below pin the production safety durations being accelerated.
function createProcessGroupTimingPreload() {
  const dir = tempDirs.make("openclaw-pr-operation-lock-timing-");
  const preloadPath = join(dir, "preload.cjs");
  writeFileSync(
    preloadPath,
    [
      "const realNow = Date.now.bind(Date);",
      "const startedAt = realNow();",
      "Date.now = () => startedAt + (realNow() - startedAt) * 100;",
      "const realSetTimeout = globalThis.setTimeout;",
      "globalThis.setTimeout = (callback, delay, ...args) =>",
      "  realSetTimeout(callback, delay === 5000 ? 50 : delay, ...args);",
    ].join("\n"),
  );
  return preloadPath;
}

function spawnDetached(command: string, args: readonly string[], options: SpawnOptions = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  detachedChildren.add(child);
  if (child.pid) {
    goneProcessGroups.delete(child.pid);
  }
  return child;
}

function createRepo(nestedName?: string) {
  const tempRoot = tempDirs.make("openclaw-pr-operation-lock-");
  const dir = nestedName ? join(tempRoot, nestedName) : tempRoot;
  if (nestedName) {
    mkdirSync(dir);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "OpenClaw Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@openclaw.invalid"], { cwd: dir });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

function bashSource(repoDir: string, supervised = false) {
  return [
    "set -euo pipefail",
    ...(supervised
      ? []
      : ["unset OPENCLAW_PR_LOCK_NOTIFY_FD", "unset OPENCLAW_PR_LOCK_SUPERVISOR_PID"]),
    `source '${worktreeScript}'`,
    `source '${lockScript}'`,
    `source '${commonScript}'`,
    `repo_root() { printf '%s\\n' '${repoDir}'; }`,
  ];
}

function writeOperationFixture(repoDir: string, name: string, commands: string[]) {
  const fixture = join(repoDir, name);
  writeFileSync(
    fixture,
    ["#!/usr/bin/env bash", ...bashSource(repoDir, true), ...commands].join("\n"),
  );
  chmodSync(fixture, 0o755);
  return fixture;
}

function installPrCliFixture(repoDir: string) {
  const files = [
    "scripts/pr",
    "scripts/lib/plain-gh.sh",
    "scripts/pr-lib/worktree.sh",
    "scripts/pr-lib/operation-lock.sh",
    "scripts/pr-lib/process-group-runner.mjs",
    "scripts/pr-lib/common.sh",
    "scripts/pr-lib/changelog.sh",
    "scripts/pr-lib/gates.sh",
    "scripts/pr-lib/push.sh",
    "scripts/pr-lib/review.sh",
    "scripts/pr-lib/prepare-core.sh",
    "scripts/pr-lib/merge.sh",
  ];
  for (const file of files) {
    const target = join(repoDir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, file), target);
  }
  const cli = join(repoDir, "scripts/pr");
  chmodSync(cli, 0o755);

  const binDir = join(repoDir, "isolated-bin");
  mkdirSync(binDir);
  for (const command of ["bash", "basename", "dirname", "git"]) {
    const resolved = execFileSync("which", [command], { encoding: "utf8" }).trim();
    symlinkSync(resolved, join(binDir, command));
  }
  return { binDir, cli };
}

async function runSupervisedFixture(
  repoDir: string,
  fixture: string,
  options: { accelerateTimeouts?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const controller = spawn(
    process.execPath,
    [
      ...(options.accelerateTimeouts ? ["--require", createProcessGroupTimingPreload()] : []),
      processGroupRunner,
      repoDir,
      fixture,
    ],
    {
      cwd: repoDir,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  controller.stdout!.setEncoding("utf8");
  controller.stderr!.setEncoding("utf8");
  controller.stdout!.on("data", (chunk) => (stdout += chunk));
  controller.stderr!.on("data", (chunk) => (stderr += chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.off("close", onClose);
        reject(new Error(`controller did not close within 15000ms (${childStatus(controller)})`));
      }, 15_000);
      const onClose = () => {
        clearTimeout(timeout);
        resolve();
      };
      controller.once("close", onClose);
    });
  } catch (error) {
    try {
      if (refExists(repoDir)) {
        const payload = execFileSync("git", ["cat-file", "blob", refOid(repoDir)], {
          cwd: repoDir,
          encoding: "utf8",
        });
        const pgid = Number(/^version=3\nstate=active\npgid=([1-9][0-9]*)\n/u.exec(payload)?.[1]);
        if (validProcessId(pgid)) {
          await cleanupProcessGroup(pgid);
        }
      }
    } catch {
      // The controller still must die even if lock metadata is malformed.
    } finally {
      controller.kill("SIGKILL");
      try {
        await waitForExit(controller, 2000);
      } catch {
        // Preserve the original bounded-exit failure below.
      }
    }
    throw error;
  }
  return { status: controller.exitCode, signal: controller.signalCode, stdout, stderr };
}

function runLockShell(repoDir: string, commands: string[]) {
  return spawnSync("bash", ["-c", [...bashSource(repoDir), ...commands].join("\n")], {
    cwd: repoDir,
    detached: true,
    encoding: "utf8",
    timeout: 10_000,
  } as { cwd: string; encoding: "utf8"; timeout: number });
}

function spawnHolder(repoDir: string, statusFile: string, pr = 42, trapTerm = true) {
  const traps = trapTerm
    ? [
        "trap release_pr_operation_lock EXIT",
        "trap 'exit 129' HUP",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
      ]
    : [];
  return spawnDetached(
    "bash",
    [
      "-c",
      [
        ...bashSource(repoDir),
        ...traps,
        `acquire_pr_operation_lock ${pr}`,
        `printf 'held\\n' >'${statusFile}'`,
        "while :; do sleep 1; done",
      ].join("\n"),
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
}

function spawnCandidate(repoDir: string, statusFile: string) {
  return spawnDetached(
    "bash",
    [
      "-c",
      [
        ...bashSource(repoDir),
        "prepare_pr_operation_lock_candidate 42",
        `printf 'prepared\\n' >'${statusFile}'`,
        "while :; do sleep 1; done",
      ].join("\n"),
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
}

function spawnHolderWithChild(repoDir: string, statusFile: string, childPidFile: string) {
  return spawnDetached(
    "bash",
    [
      "-c",
      [
        ...bashSource(repoDir),
        "acquire_pr_operation_lock 42",
        `printf 'held\n' >'${statusFile}'`,
        "sleep 30 &",
        `printf '%s\n' "$!" >'${childPidFile}'`,
        'wait "$!"',
      ].join("\n"),
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function validProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1 && Number(value) <= 0x7fffffff;
}

function readProcessIdFile(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }
  const value = Number(readFileSync(path, "utf8").trim());
  return validProcessId(value) ? value : undefined;
}

async function waitForProcessId(path: string) {
  let pid: number | undefined;
  const ready = await waitFor(() => {
    pid = readProcessIdFile(path);
    return pid !== undefined;
  });
  if (!ready || pid === undefined) {
    throw new Error(`process id was not written to ${path}`);
  }
  goneProcessGroups.delete(pid);
  return pid;
}

function childStatus(child: ChildProcess) {
  return `pid=${child.pid ?? "unknown"} exit=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}`;
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`child did not exit within ${timeoutMs}ms (${childStatus(child)})`));
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalTestChild(child, signal);
  await waitForExit(child);
}

async function stopChildLeader(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill(signal);
  await waitForExit(child);
}

async function cleanupChildren(...children: Array<ChildProcess | undefined>) {
  const failures: unknown[] = [];
  for (const child of children) {
    if (!child) {
      continue;
    }
    try {
      if (child.exitCode === null && child.signalCode === null) {
        signalTestChild(child, "SIGKILL");
        await waitForExit(child, 2000);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up operation-lock test children");
  }
}

function signalTestChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (detachedChildren.has(child) && child.pid) {
    try {
      killProcessGroup(child.pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
  }
  child.kill(signal);
}

async function cleanupProcessGroup(pgid: number) {
  if (!processGroupExists(pgid)) {
    return;
  }
  try {
    killProcessGroup(pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") {
      return;
    }
    throw error;
  }
  if (!(await waitFor(() => !processGroupExists(pgid), 2000))) {
    throw new Error(`process group ${pgid} did not exit during cleanup`);
  }
}

function readOperationProcessGroup(repoDir: string) {
  if (!refExists(repoDir)) {
    return undefined;
  }
  try {
    const payload = execFileSync("git", ["cat-file", "blob", refOid(repoDir)], {
      cwd: repoDir,
      encoding: "utf8",
    });
    const pgid = Number(/^version=3\nstate=active\npgid=([1-9][0-9]*)\n/u.exec(payload)?.[1]);
    return validProcessId(pgid) ? pgid : undefined;
  } catch {
    return undefined;
  }
}

async function cleanupController(
  repoDir: string,
  controller: ChildProcess,
  operationPgidFile?: string,
) {
  let pgid = operationPgidFile ? readProcessIdFile(operationPgidFile) : undefined;
  pgid ??= readOperationProcessGroup(repoDir);
  if (pgid) {
    await cleanupProcessGroup(pgid);
  }
  await cleanupChildren(controller);

  pgid = operationPgidFile ? readProcessIdFile(operationPgidFile) : undefined;
  pgid ??= readOperationProcessGroup(repoDir);
  if (pgid) {
    await cleanupProcessGroup(pgid);
  }
}

function refOid(repoDir: string, ref = lockRef) {
  return execFileSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8" }).trim();
}

function refExists(repoDir: string, ref = lockRef) {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
      cwd: repoDir,
    }).status === 0
  );
}

function processGroupExists(pgid: number) {
  if (!validProcessId(pgid)) {
    throw new Error(`refusing to probe invalid process group ${String(pgid)}`);
  }
  if (goneProcessGroups.has(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Fixtures never change identity. EPERM therefore means the original
    // group exited and its numeric PGID now belongs to another user.
    if (code === "ESRCH" || code === "EPERM") {
      goneProcessGroups.add(pgid);
      return false;
    }
    throw error;
  }
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals) {
  if (!validProcessId(pgid)) {
    throw new Error(`refusing to signal invalid process group ${String(pgid)}`);
  }
  if (!goneProcessGroups.has(pgid)) {
    process.kill(-pgid, signal);
  }
}

describe("scripts/pr process-group platform guard", () => {
  it("keeps native Windows on the explicit WSL-only path", () => {
    const source = readFileSync(processGroupRunner, "utf8");
    expect(source).toContain('process.platform === "win32"');
    expect(source).toContain("use WSL on Windows");
    expect(source).toContain("const SIGNAL_GRACE_MS = 5000;");
    expect(source).toContain("const KILL_DRAIN_MS = 5000;");
    if (process.platform !== "win32") {
      return;
    }

    const result = spawnSync(process.execPath, [processGroupRunner, repoRoot, "unused"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use WSL on Windows");
  });
});

const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("scripts/pr per-PR operation lock", () => {
  it("serializes the same PR and releases the waiter after SIGTERM", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const acquired = join(repoDir, "acquired");
    const holder = spawnHolder(repoDir, held);
    let waiter: ChildProcess | undefined;
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);

      waiter = spawnDetached(
        "bash",
        [
          "-c",
          [
            ...bashSource(repoDir),
            "acquire_pr_operation_lock 42",
            `printf 'acquired\\n' >'${acquired}'`,
            "release_pr_operation_lock",
          ].join("\n"),
        ],
        { cwd: repoDir, stdio: "ignore" },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(acquired)).toBe(false);

      await stopChild(holder, "SIGTERM");
      expect(await waitFor(() => existsSync(acquired))).toBe(true);
      await waitForExit(waiter);
    } finally {
      await cleanupChildren(waiter, holder);
    }
  });

  it("allows different PRs to proceed concurrently", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);
      const other = runLockShell(repoDir, [
        "acquire_pr_operation_lock 43",
        "release_pr_operation_lock",
      ]);
      expect(other.status, `${other.stdout}\\n${other.stderr}`).toBe(0);
    } finally {
      await cleanupChildren(holder);
    }
  });

  it("does not publish a candidate paused before the create CAS", async () => {
    const repoDir = createRepo();
    const prepared = join(repoDir, "prepared");
    const candidate = spawnCandidate(repoDir, prepared);
    try {
      expect(await waitFor(() => existsSync(prepared))).toBe(true);
      const winner = runLockShell(repoDir, [
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
      expect(winner.status, `${winner.stdout}\\n${winner.stderr}`).toBe(0);
    } finally {
      await cleanupChildren(candidate);
    }
  });

  it("requires exact recovery after a SIGKILL owner disappears", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held, 42, false);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);
      const ownerOid = refOid(repoDir);
      await stopChild(holder, "SIGKILL");

      const blocked = runLockShell(repoDir, [
        "set +e",
        "acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      expect(blocked.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      expect(refOid(repoDir)).toBe(ownerOid);

      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupChildren(holder);
    }
  });

  it("makes an exact-OID late release harmless after a successor acquires", async () => {
    const repoDir = createRepo();
    const firstHeld = join(repoDir, "first-held");
    const first = spawnHolder(repoDir, firstHeld, 42, false);
    let second: ChildProcess | undefined;
    try {
      expect(await waitFor(() => existsSync(firstHeld))).toBe(true);
      const oldOid = refOid(repoDir);
      await stopChild(first, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(first.pid!))).toBe(true);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${oldOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);

      const secondHeld = join(repoDir, "second-held");
      second = spawnHolder(repoDir, secondHeld);
      expect(await waitFor(() => existsSync(secondHeld))).toBe(true);
      const successorOid = refOid(repoDir);
      const lateRelease = runLockShell(repoDir, [
        `PR_OPERATION_LOCK_REF='${lockRef}'`,
        `PR_OPERATION_LOCK_OWNER_OID='${oldOid}'`,
        "release_pr_operation_lock",
      ]);
      expect(lateRelease.status, `${lateRelease.stdout}\\n${lateRelease.stderr}`).toBe(0);
      expect(refOid(repoDir)).toBe(successorOid);
    } finally {
      await cleanupChildren(second, first);
    }
  });

  it("requires confirmation and the current exact OID for recovery", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held, 42, false);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);
      const ownerOid = refOid(repoDir);
      const wrongOid = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const unconfirmed = runLockShell(repoDir, [
        "set +e",
        `recover_pr_operation_lock 42 '${ownerOid}'`,
        "recovery_status=$?",
        "set -e",
        'printf "%s\\n" "$recovery_status"',
      ]);
      expect(unconfirmed.status).toBe(0);
      expect(unconfirmed.stdout.trim()).toBe("2");
      expect(unconfirmed.stderr).toContain("Recovery requires --confirmed-no-running-tools");
      expect(refOid(repoDir)).toBe(ownerOid);

      const wrongOwner = runLockShell(repoDir, [
        "set +e",
        `recover_pr_operation_lock 42 '${wrongOid}' --confirmed-no-running-tools`,
        "recovery_status=$?",
        "set -e",
        'printf "%s\\n" "$recovery_status"',
      ]);
      expect(wrongOwner.status).toBe(0);
      expect(wrongOwner.stdout.trim()).toBe("1");
      expect(refOid(repoDir)).toBe(ownerOid);
    } finally {
      await cleanupChildren(holder);
    }
  });

  it("preserves a successor when recovery loses its exact-OID CAS", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "owner_oid=$(printf 'owner-lock\\n' | git hash-object -w --stdin)",
      "successor_oid=$(printf 'successor-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$owner_oid"`,
      "git() {",
      `  if [ "$*" = "-C ${repoDir} update-ref --no-deref -d ${lockRef} $owner_oid" ]; then`,
      `    command git -C '${repoDir}' update-ref '${lockRef}' "$successor_oid" "$owner_oid"`,
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      "set +e",
      'recover_pr_operation_lock 42 "$owner_oid" --confirmed-no-running-tools',
      "recovery_status=$?",
      "set -e",
      `printf '%s\\t%s\\n' "$recovery_status" "$(command git rev-parse '${lockRef}')"`,
    ]);
    const successorOid = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: repoDir,
      input: "successor-lock\n",
      encoding: "utf8",
    }).trim();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(`1\t${successorOid}`);
    expect(result.stderr).toContain("owner changed during recovery");
  });

  it("runs lock recovery without the normal PR toolchain", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const ownerOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", lockRef, ownerOid], { cwd: repoDir });

    const result = spawnSync(
      cli,
      ["lock-recover", "42", ownerOid, "--confirmed-no-running-tools"],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: { ...process.env, PATH: binDir },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("Recovered the stale operation lock for PR #42.");
    expect(refExists(repoDir)).toBe(false);
  });

  it("does not lock an unsupported command that shares a known prefix", () => {
    const repoDir = createRepo();
    const { cli } = installPrCliFixture(repoDir);
    const result = spawnSync(cli, ["review-not-a-command", "42"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stdout).toContain("Usage:");
    expect(refExists(repoDir)).toBe(false);
  });

  it("does not lock review-tests before validating its required target", () => {
    const repoDir = createRepo();
    const { cli } = installPrCliFixture(repoDir);
    const result = spawnSync(cli, ["review-tests", "42"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stdout).toContain("Usage:");
    expect(refExists(repoDir)).toBe(false);
  });

  it("does not trust an ambient dedicated-process-group marker", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(reviewScript, `${readFileSync(reviewScript, "utf8")}\nreview_init() { :; }\n`);
    for (const command of ["gh", "jq", "pnpm", "rg"]) {
      const stub = join(binDir, command);
      writeFileSync(stub, "#!/bin/sh\nexit 0\n");
      chmodSync(stub, 0o755);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete env.OPENCLAW_PR_LOCK_NOTIFY_FD;
    delete env.OPENCLAW_PR_LOCK_SUPERVISOR_PID;

    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it.each([["--dryrun"], ["--dry-run", "extra"]])(
    "rejects invalid gc arguments before cleanup: %s",
    (...args: string[]) => {
      const repoDir = createRepo();
      const { cli } = installPrCliFixture(repoDir);
      const result = spawnSync(cli, ["gc", ...args], {
        cwd: repoDir,
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stdout).toContain("Usage:");
      expect(refExists(repoDir)).toBe(false);
    },
  );

  it("recovers an exact owner despite an unrelated reused live PGID", async () => {
    const repoDir = createRepo();
    const unrelated = spawnDetached("sleep", ["30"], { stdio: "ignore" });
    try {
      const unrelatedPgid = unrelated.pid!;
      const result = runLockShell(repoDir, [
        `owner_oid=$(printf 'version=3\\nstate=active\\npgid=%s\\nsupervisor_pid=2147483647\\nsupervisor_birth=Mon Jan 1 00:00:00 1900\\ntoken=11111111-1111-1111-1111-111111111111\\n' '${unrelatedPgid}' | git hash-object -w --stdin)`,
        `git update-ref '${lockRef}' "$owner_oid"`,
        "set +e",
        "acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\t%s\\n" "$lock_status" "$owner_oid"',
        'recover_pr_operation_lock 42 "$owner_oid" --confirmed-no-running-tools',
      ]);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const [blockedLine] = result.stdout.trim().split("\n");
      const [, ownerOid] = blockedLine.split("\t");
      expect(blockedLine).toMatch(/^2\t[0-9a-f]{40}$/u);
      expect(result.stderr).toContain("operation lock is orphaned");
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      expect(processGroupExists(unrelatedPgid)).toBe(true);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupChildren(unrelated);
    }
  });

  it("retries when the prior owner releases between failed create CAS and ref read", () => {
    const repoDir = createRepo();
    const raceTriggered = join(repoDir, "race-triggered");
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 99",
      "old_oid=$PR_OPERATION_LOCK_CANDIDATE_OID",
      `git update-ref '${lockRef}' "$old_oid"`,
      "git() {",
      `  if [ ! -e '${raceTriggered}' ] && [[ "$*" == *"rev-parse --verify ${lockRef}"* ]]; then`,
      `    : >'${raceTriggered}'`,
      `    command git -C '${repoDir}' update-ref --no-deref -d '${lockRef}' "$old_oid"`,
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      "acquire_pr_operation_lock 42",
      "release_pr_operation_lock",
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(raceTriggered)).toBe(true);
  });

  it("retries when the finishing supervisor releases before an orphan verdict", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 42",
      "stale_oid=$(printf 'version=3\\nstate=active\\npgid=2147483647\\nsupervisor_pid=2147483647\\nsupervisor_birth=Mon Jan 1 00:00:00 1900\\ntoken=11111111-1111-1111-1111-111111111111\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$stale_oid"`,
      "pr_operation_lock_process_group_status() {",
      `  command git -C '${repoDir}' update-ref --no-deref -d '${lockRef}' "$stale_oid"`,
      "  printf 'dead\\n'",
      "}",
      "pr_operation_lock_process_identity() { return 1; }",
      "try_acquire_pr_operation_lock 42",
      "release_pr_operation_lock",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("keeps a live orphaned operation group sticky and surfaces recovery", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const childPid = join(repoDir, "child-pid");
    const holder = spawnHolderWithChild(repoDir, held, childPid);
    try {
      expect(await waitFor(() => existsSync(held) && existsSync(childPid))).toBe(true);
      const ownerOid = refOid(repoDir);
      // Leave the same-group child alive to model a controller-only failure.
      await stopChildLeader(holder, "SIGKILL");

      const blocked = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        `printf '%s\t%s\t%s\n' "$lock_status" "$PR_OPERATION_LOCK_BLOCKED_REASON" "$(git rev-parse '${lockRef}')"`,
      ]);
      expect(blocked.status, `${blocked.stdout}\\n${blocked.stderr}`).toBe(0);
      expect(blocked.stdout.trim()).toBe(`2\torphaned\t${ownerOid}`);
      killProcessGroup(holder.pid!, "SIGTERM");
      expect(await waitFor(() => !processGroupExists(holder.pid!))).toBe(true);

      const stillBlocked = runLockShell(repoDir, [
        "set +e",
        "acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(stillBlocked.status).toBe(0);
      expect(stillBlocked.stdout.trim()).toBe("2");

      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
      expect(recovered.status, `${recovered.stdout}\\n${recovered.stderr}`).toBe(0);
    } finally {
      await cleanupChildren(holder);
    }
  });

  it("rejects noncanonical aliases for the same PR number", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "set +e",
      "try_acquire_pr_operation_lock 00042",
      "lock_status=$?",
      "pr_number_from_worktree_dir .worktrees/pr-00042 >/dev/null",
      "parse_status=$?",
      "set -e",
      'printf "%s\t%s\n" "$lock_status" "$parse_status"',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2\t1");
  });

  it("retries release while the owner ref is unchanged", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "acquire_pr_operation_lock 42",
      "owner_oid=$PR_OPERATION_LOCK_OWNER_OID",
      "delete_attempts=0",
      "git() {",
      `  if [ "$*" = "-C ${repoDir} update-ref --no-deref -d ${lockRef} $owner_oid" ]; then`,
      "    delete_attempts=$((delete_attempts + 1))",
      '    if [ "$delete_attempts" -lt 3 ]; then return 1; fi',
      "  fi",
      '  command git "$@"',
      "}",
      "sleep() { :; }",
      "release_pr_operation_lock",
      `if command git show-ref --verify --quiet '${lockRef}'; then ref_status=present; else ref_status=absent; fi`,
      'printf "%s\t%s\n" "$delete_attempts" "$ref_status"',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("3\tabsent");
  });

  it("fails release when the owner ref stays unchanged", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "acquire_pr_operation_lock 42",
      "owner_oid=$PR_OPERATION_LOCK_OWNER_OID",
      "delete_attempts=0",
      "git() {",
      `  if [ "$*" = "-C ${repoDir} update-ref --no-deref -d ${lockRef} $owner_oid" ]; then`,
      "    delete_attempts=$((delete_attempts + 1))",
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      "sleep() { :; }",
      "set +e",
      "release_pr_operation_lock",
      "release_status=$?",
      "set -e",
      'printf "%s\t%s\t%s\n" "$release_status" "$PR_OPERATION_LOCK_OWNER_OID" "$delete_attempts"',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`1\t${refOid(repoDir)}\t20`);
    expect(result.stderr).toContain("Unable to release the operation lock for 42");
  });

  it("has the process-group supervisor release the exact owner ref", async () => {
    const repoDir = createRepo();
    const fixture = writeOperationFixture(repoDir, "acquire-once.sh", [
      "acquire_pr_operation_lock 42",
    ]);
    const result = await runSupervisedFixture(repoDir, fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("retains the exact owner when supervisor release cannot take the ref lock", async () => {
    const repoDir = createRepo();
    // Retry counts are covered above; this integration case only needs the real ref-lock failure.
    execFileSync("git", ["config", "core.filesRefLockTimeout", "0"], { cwd: repoDir });
    const binDir = join(repoDir, "fast-release-bin");
    mkdirSync(binDir);
    const sleepPath = join(binDir, "sleep");
    writeFileSync(sleepPath, "#!/bin/sh\nexit 0\n");
    chmodSync(sleepPath, 0o755);
    const refLock = join(repoDir, ".git/refs/openclaw/pr-operation-locks/42.lock");
    const fixture = writeOperationFixture(repoDir, "blocked-release.sh", [
      "acquire_pr_operation_lock 42",
      `: >'${refLock}'`,
    ]);
    const result = await runSupervisedFixture(repoDir, fixture, {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    });
    const ownerOid = refOid(repoDir);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("Unable to release the operation lock for 42");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    expect(refOid(repoDir)).toBe(ownerOid);

    unlinkSync(refLock);
    const recovered = runLockShell(repoDir, [
      `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ]);
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("reports exact recovery when lock notification fails", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "OPENCLAW_PR_LOCK_NOTIFY_FD=9",
      "set +e",
      "acquire_pr_operation_lock 42",
      "lock_status=$?",
      "set -e",
      'printf "%s\\n" "$lock_status"',
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("2");
    const ownerOid = refOid(repoDir);
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );

    const recovered = runLockShell(repoDir, [
      `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ]);
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("rejects a notification for a lock owned by another process group", async () => {
    const repoDir = createRepo();
    const foreignRef = "refs/openclaw/pr-operation-locks/43";
    const foreignHeld = join(repoDir, "foreign-held");
    const foreignHolder = spawnHolder(repoDir, foreignHeld, 43);
    try {
      expect(await waitFor(() => existsSync(foreignHeld))).toBe(true);
      const foreignOid = refOid(repoDir, foreignRef);
      const fixture = writeOperationFixture(repoDir, "forged-notification.sh", [
        "acquire_pr_operation_lock 42",
        `printf '%s\\t%s\\n' '${foreignRef}' '${foreignOid}' >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
      ]);
      const result = await runSupervisedFixture(repoDir, fixture);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(refOid(repoDir, foreignRef)).toBe(foreignOid);
      expect(refExists(repoDir)).toBe(true);
      expect(result.stderr).toContain("operation lock owned by another process group");

      const ownerOid = refOid(repoDir);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    } finally {
      await cleanupChildren(foreignHolder);
    }
  });

  it.each([
    ["newline-terminated", "printf 'not-lock-metadata\\n'"],
    ["unterminated", "printf 'not-lock-metadata'"],
  ])("retains the lock after %s malformed supervisor metadata", async (_name, command) => {
    const repoDir = createRepo();
    const fixture = writeOperationFixture(repoDir, "malformed-notification.sh", [
      "acquire_pr_operation_lock 42",
      `${command} >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
    ]);
    const result = await runSupervisedFixture(repoDir, fixture);
    const ownerOid = refOid(repoDir);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("malformed operation-lock metadata");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    expect(refOid(repoDir)).toBe(ownerOid);

    const recovered = runLockShell(repoDir, [
      `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ]);
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("bounds an oversized unterminated supervisor metadata line", async () => {
    const repoDir = createRepo();
    const fixture = writeOperationFixture(repoDir, "oversized-notification.sh", [
      "acquire_pr_operation_lock 42",
      `node -e 'process.stdout.write("x".repeat(8192))' >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
    ]);
    const result = await runSupervisedFixture(repoDir, fixture);
    const ownerOid = refOid(repoDir);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("operation-lock metadata line is too large");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    expect(refOid(repoDir)).toBe(ownerOid);

    const recovered = runLockShell(repoDir, [
      `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ]);
    expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });

  it("uses successful command return as the trusted completion contract", async () => {
    const repoDir = createRepo();
    const daemonPidFile = join(repoDir, "unrelated-daemon-pgid");
    const daemonScript = join(repoDir, "unrelated-daemon.mjs");
    const launcherScript = join(repoDir, "unrelated-daemon-launcher.mjs");
    writeFileSync(daemonScript, "setInterval(() => {}, 1000);\n");
    writeFileSync(
      launcherScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(daemonScript)}], {`,
        "  detached: true,",
        '  stdio: "ignore",',
        "});",
        `fs.writeFileSync(${JSON.stringify(daemonPidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n"),
    );
    const fixture = writeOperationFixture(repoDir, "clean-detached-launcher.sh", [
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    let daemonPgid: number | undefined;
    try {
      const result = await runSupervisedFixture(repoDir, fixture);
      daemonPgid = await waitForProcessId(daemonPidFile);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(processGroupExists(daemonPgid)).toBe(true);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      daemonPgid ??= readProcessIdFile(daemonPidFile);
      if (daemonPgid) {
        await cleanupProcessGroup(daemonPgid);
      }
    }
  });

  it("retains a failed operation lock when a detached child outlives its launcher", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "failed-nested-pgid");
    const nestedScript = join(repoDir, "failed-nested.mjs");
    const launcherScript = join(repoDir, "failing-launcher.mjs");
    writeFileSync(
      nestedScript,
      ['process.on("SIGTERM", () => {});', "setInterval(() => {}, 1000);"].join("\n"),
    );
    writeFileSync(
      launcherScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(nestedScript)}], {`,
        "  detached: true,",
        '  stdio: "ignore",',
        "});",
        `fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(child.pid));`,
        "process.exit(1);",
      ].join("\n"),
    );
    const fixture = writeOperationFixture(repoDir, "failed-operation.sh", [
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    let nestedPgid: number | undefined;
    try {
      const result = await runSupervisedFixture(repoDir, fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      nestedPgid = await waitForProcessId(nestedPidFile);
      expect(processGroupExists(nestedPgid!)).toBe(true);
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );

      const blocked = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");

      killProcessGroup(nestedPgid!, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      nestedPgid ??= readProcessIdFile(nestedPidFile);
      if (nestedPgid) {
        await cleanupProcessGroup(nestedPgid);
      }
    }
  });

  it("exits after a bounded wait when a detached child keeps the notification pipe open", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "pipe-holder-pgid");
    const nestedScript = join(repoDir, "pipe-holder.mjs");
    const launcherScript = join(repoDir, "pipe-holder-launcher.mjs");
    writeFileSync(nestedScript, "setInterval(() => {}, 1000);\n");
    writeFileSync(
      launcherScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(nestedScript)}], {`,
        "  detached: true,",
        '  stdio: ["ignore", "ignore", "ignore", 3],',
        "});",
        `fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(child.pid));`,
        "process.exit(1);",
      ].join("\n"),
    );
    const fixture = writeOperationFixture(repoDir, "pipe-holder-operation.sh", [
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    let nestedPgid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = await runSupervisedFixture(repoDir, fixture, { accelerateTimeouts: true });
      const elapsed = Date.now() - startedAt;
      nestedPgid = await waitForProcessId(nestedPidFile);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(elapsed).toBeLessThan(12_000);
      expect(processGroupExists(nestedPgid)).toBe(true);
      expect(result.stderr).toContain("operation lifetime did not drain");
      const ownerOid = refOid(repoDir);

      killProcessGroup(nestedPgid, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      nestedPgid ??= readProcessIdFile(nestedPidFile);
      if (nestedPgid) {
        await cleanupProcessGroup(nestedPgid);
      }
    }
  }, 15_000);

  it("waits while a live supervisor finishes draining a dead operation group", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "finishing-operation-pgid");
    const holderPidFile = join(repoDir, "finishing-holder-pgid");
    const acquiredFile = join(repoDir, "finishing-waiter-acquired");
    const holderScript = join(repoDir, "finishing-holder.mjs");
    const launcherScript = join(repoDir, "finishing-launcher.mjs");
    writeFileSync(holderScript, "setInterval(() => {}, 1000);\n");
    writeFileSync(
      launcherScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(holderScript)}], {`,
        "  detached: true,",
        '  stdio: ["ignore", "ignore", "ignore", 3],',
        "});",
        `fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(child.pid));`,
        "process.exit(0);",
      ].join("\n"),
    );
    const fixture = writeOperationFixture(repoDir, "finishing-operation.sh", [
      `printf '%s\\n' "$$" >'${operationPgidFile}'`,
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      stdio: "ignore",
    });
    let waiter: ChildProcess | undefined;
    let holderPgid: number | undefined;
    try {
      const operationPgid = await waitForProcessId(operationPgidFile);
      holderPgid = await waitForProcessId(holderPidFile);
      expect(await waitFor(() => !processGroupExists(operationPgid))).toBe(true);
      expect(refExists(repoDir)).toBe(true);

      const probe = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      expect(probe.stdout.trim()).toBe("1");

      waiter = spawnDetached(
        "bash",
        [
          "-c",
          [
            ...bashSource(repoDir),
            "acquire_pr_operation_lock 42",
            `printf 'acquired\\n' >'${acquiredFile}'`,
            "release_pr_operation_lock",
          ].join("\n"),
        ],
        { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] },
      );
      let waiterStderr = "";
      waiter.stderr?.setEncoding("utf8");
      waiter.stderr?.on("data", (chunk) => (waiterStderr += chunk));
      expect(
        await waitFor(() =>
          waiterStderr.includes(
            "Waiting for the active scripts/pr operation on PR #42 to finish...",
          ),
        ),
      ).toBe(true);
      expect(existsSync(acquiredFile)).toBe(false);
      expect(controller.exitCode).toBeNull();
      expect(processGroupExists(holderPgid)).toBe(true);

      killProcessGroup(holderPgid, "SIGTERM");
      await waitForExit(controller, 5000);
      await waitForExit(waiter, 5000);
      expect(controller.exitCode).toBe(0);
      expect(waiter.exitCode).toBe(0);
      expect(existsSync(acquiredFile)).toBe(true);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      holderPgid ??= readProcessIdFile(holderPidFile);
      if (holderPgid) {
        await cleanupProcessGroup(holderPgid);
      }
      await cleanupChildren(waiter);
      await cleanupController(repoDir, controller, operationPgidFile);
    }
  }, 12_000);

  it("drains a same-group background job after its wrapper fails", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "failed-operation-pgid");
    const backgroundPidFile = join(repoDir, "failed-background-pid");
    const fixture = writeOperationFixture(repoDir, "failed-background-operation.sh", [
      `printf '%s\\n' "$$" >'${operationPgidFile}'`,
      "acquire_pr_operation_lock 42",
      "sleep 30 &",
      `printf '%s\\n' "$!" >'${backgroundPidFile}'`,
      "exit 1",
    ]);

    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedFixture(repoDir, fixture);
      operationPgid = await waitForProcessId(operationPgidFile);
      const ownerOid = refOid(repoDir);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(await waitForProcessId(backgroundPidFile)).toBeGreaterThan(1);
      expect(processGroupExists(operationPgid)).toBe(false);
      expect(refOid(repoDir)).toBe(ownerOid);
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );

      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      operationPgid ??= readProcessIdFile(operationPgidFile);
      if (operationPgid) {
        await cleanupProcessGroup(operationPgid);
      }
    }
  });

  it("fails and retains the lock when a clean wrapper leaves same-group work", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "clean-background-operation-pgid");
    const fixture = writeOperationFixture(repoDir, "clean-background-operation.sh", [
      `printf '%s\\n' "$$" >'${operationPgidFile}'`,
      "acquire_pr_operation_lock 42",
      "sleep 30 &",
      "exit 0",
    ]);

    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedFixture(repoDir, fixture);
      operationPgid = await waitForProcessId(operationPgidFile);
      const ownerOid = refOid(repoDir);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(processGroupExists(operationPgid)).toBe(false);
      expect(result.stderr).toContain("process group remained active after wrapper exit");
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );

      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      operationPgid ??= readProcessIdFile(operationPgidFile);
      if (operationPgid) {
        await cleanupProcessGroup(operationPgid);
      }
    }
  });

  it("keeps gc lock ownership with the supervisor until gc exits", async () => {
    const repoDir = createRepo();
    mkdirSync(join(repoDir, ".worktrees", "pr-42"), { recursive: true });
    const ghStarted = join(repoDir, "gc-gh-started");
    const ghContinue = join(repoDir, "gc-gh-continue");
    const outputFile = join(repoDir, "gc-output");
    const fixture = writeOperationFixture(repoDir, "gc.sh", [
      "gh() {",
      `  : >'${ghStarted}'`,
      `  while [ ! -e '${ghContinue}' ]; do sleep 0.05; done`,
      "  printf 'MERGED\\n'",
      "}",
      `gc_pr_worktrees true >'${outputFile}'`,
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      stdio: "ignore",
    });
    try {
      expect(await waitFor(() => existsSync(ghStarted) && refExists(repoDir))).toBe(true);
      const probe = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      expect(probe.stdout.trim()).toBe("1");

      writeFileSync(ghContinue, "continue\n");
      await waitForExit(controller, 5000);
      expect(controller.exitCode).toBe(0);
      expect(readFileSync(outputFile, "utf8")).toContain("would remove .worktrees/pr-42");
      expect(refExists(repoDir)).toBe(false);
    } finally {
      writeFileSync(ghContinue, "continue\n");
      await cleanupController(repoDir, controller);
    }
  });

  it("fails closed on malformed owner blobs", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "bad_oid=$(printf 'not-a-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$bad_oid"`,
      "set +e",
      "try_acquire_pr_operation_lock 42",
      "lock_status=$?",
      'recover_pr_operation_lock 42 "$bad_oid" --confirmed-no-running-tools',
      "recovery_status=$?",
      "set -e",
      'printf "%s\\t%s\\n" "$lock_status" "$recovery_status"',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe("2\t0");
    expect(refExists(repoDir)).toBe(false);
  });

  it("rejects special and out-of-range process-group ids", () => {
    for (const pgid of ["1", "2147483648"]) {
      const repoDir = createRepo();
      const result = runLockShell(repoDir, [
        'supervisor_birth=$(pr_operation_lock_process_birth "$$")',
        `bad_oid=$(printf 'version=3\\nstate=active\\npgid=${pgid}\\nsupervisor_pid=%s\\nsupervisor_birth=%s\\ntoken=11111111-1111-1111-1111-111111111111\\n' "$$" "$supervisor_birth" | git hash-object -w --stdin)`,
        `git update-ref '${lockRef}' "$bad_oid"`,
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("2");
    }
  });

  it("fails closed when process-group liveness is not permitted", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 42",
      'supervisor_birth=$(pr_operation_lock_process_birth "$$")',
      'owner_oid=$(printf \'version=3\\nstate=active\\npgid=2\\nsupervisor_pid=%s\\nsupervisor_birth=%s\\ntoken=11111111-1111-1111-1111-111111111111\\n\' "$$" "$supervisor_birth" | git hash-object -w --stdin)',
      `git update-ref '${lockRef}' "$owner_oid"`,
      "node() { printf 'indeterminate\\n'; }",
      "set +e",
      "try_acquire_pr_operation_lock 42",
      "lock_status=$?",
      'recover_pr_operation_lock 42 "$owner_oid" --confirmed-no-running-tools',
      "recovery_status=$?",
      "set -e",
      'printf "%s\\t%s\\n" "$lock_status" "$recovery_status"',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").at(-1)).toBe("2\t0");
    expect(refExists(repoDir)).toBe(false);
  });

  it.runIf(process.platform === "linux")(
    "conservatively keeps a lock whose process group contains a zombie",
    async () => {
      const repoDir = createRepo();
      const pidFile = join(repoDir, "zombie-pgid");
      const parent = spawnDetached(
        "python3",
        [
          "-c",
          [
            "import os, time",
            "pid = os.fork()",
            "if pid == 0:",
            "    os.setpgid(0, 0)",
            `    open(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))`,
            "    os._exit(0)",
            "time.sleep(30)",
          ].join("\n"),
        ],
        { cwd: repoDir, stdio: "ignore" },
      );
      let zombiePgid: number | undefined;
      try {
        expect(await waitFor(() => existsSync(pidFile))).toBe(true);
        zombiePgid = await waitForProcessId(pidFile);
        expect(
          await waitFor(() => {
            const state = spawnSync("ps", ["-o", "state=", "-p", String(zombiePgid)], {
              encoding: "utf8",
            }).stdout.trim();
            return state.startsWith("Z");
          }),
        ).toBe(true);

        const blocked = runLockShell(repoDir, [
          'supervisor_birth=$(pr_operation_lock_process_birth "$$")',
          `owner_oid=$(printf 'version=3\\nstate=active\\npgid=%s\\nsupervisor_pid=%s\\nsupervisor_birth=%s\\ntoken=11111111-1111-1111-1111-111111111111\\n' '${zombiePgid}' "$$" "$supervisor_birth" | git hash-object -w --stdin)`,
          `git update-ref '${lockRef}' "$owner_oid"`,
          "set +e",
          "try_acquire_pr_operation_lock 42",
          "lock_status=$?",
          "set -e",
          'printf "%s\\n" "$lock_status"',
        ]);
        expect(blocked.status).toBe(0);
        expect(blocked.stdout.trim()).toBe("1");

        const ownerOid = refOid(repoDir);
        await stopChild(parent, "SIGTERM");
        expect(await waitFor(() => !processGroupExists(zombiePgid!))).toBe(true);
        const recovered = runLockShell(repoDir, [
          `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
          "acquire_pr_operation_lock 42",
          "release_pr_operation_lock",
        ]);
        expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      } finally {
        await cleanupChildren(parent);
      }
    },
    15_000,
  );

  it("keeps a dead owner sticky instead of guessing that detached work ended", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "stale_oid=$(printf 'version=3\\nstate=active\\npgid=2147483647\\nsupervisor_pid=2147483647\\nsupervisor_birth=Mon Jan 1 00:00:00 1900\\ntoken=11111111-1111-1111-1111-111111111111\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$stale_oid"`,
      "set +e",
      "acquire_pr_operation_lock 42",
      "lock_status=$?",
      "set -e",
      `printf '%s\t%s\n' "$lock_status" "$(command git rev-parse '${lockRef}')"`,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`2\t${refOid(repoDir)}`);
    expect(result.stderr).toContain("detached child tools cannot be ruled out");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${refOid(repoDir)} --confirmed-no-running-tools`,
    );
    expect(result.stderr).toContain("Unable to acquire the operation lock for PR #42.");
  });

  it("preserves the exact lock if its controller is killed", async () => {
    const repoDir = createRepo();
    const pidFile = join(repoDir, "operation-pgid");
    const held = join(repoDir, "held");
    const fixture = writeOperationFixture(repoDir, "operation.sh", [
      `printf '%s\\n' "$$" >'${pidFile}'`,
      "acquire_pr_operation_lock 42",
      `printf 'held\\n' >'${held}'`,
      "while :; do sleep 1; done",
    ]);

    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      stdio: "ignore",
    });
    let pgid: number | undefined;
    try {
      expect(await waitFor(() => existsSync(pidFile) && existsSync(held))).toBe(true);
      pgid = await waitForProcessId(pidFile);
      const ownerOid = refOid(repoDir);
      expect(processGroupExists(pgid!)).toBe(true);

      await stopChild(controller, "SIGKILL");
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);

      const blockedWhileGroupLives = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\t%s\\t%s\\n" "$lock_status" "$PR_OPERATION_LOCK_BLOCKED_REASON" "$PR_OPERATION_LOCK_BLOCKED_OID"',
      ]);
      expect(blockedWhileGroupLives.status).toBe(0);
      expect(blockedWhileGroupLives.stdout.trim()).toBe(`2\torphaned\t${ownerOid}`);
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);

      killProcessGroup(pgid!, "SIGTERM");
      expect(await waitFor(() => !processGroupExists(pgid!))).toBe(true);
      const blocked = runLockShell(repoDir, [
        "set +e",
        "acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      expect(refOid(repoDir)).toBe(ownerOid);

      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  });

  it("escalates a signal, drains its group, and retains the interrupted lock", async () => {
    const repoDir = createRepo();
    const pidFile = join(repoDir, "operation-pgid");
    const childReady = join(repoDir, "child-ready");
    const fixture = writeOperationFixture(repoDir, "stubborn-operation.sh", [
      `printf '%s\\n' "$$" >'${pidFile}'`,
      "trap 'exit 143' TERM",
      "acquire_pr_operation_lock 42",
      "(",
      "  trap '' HUP INT TERM",
      `  printf 'ready\\n' >'${childReady}'`,
      "  while :; do sleep 1; done",
      ") &",
      'wait "$!"',
    ]);
    const controller = spawn(
      process.execPath,
      ["--require", createProcessGroupTimingPreload(), processGroupRunner, repoDir, fixture],
      {
        cwd: repoDir,
        stdio: "ignore",
      },
    );
    let pgid: number | undefined;
    try {
      expect(await waitFor(() => existsSync(pidFile) && existsSync(childReady))).toBe(true);
      pgid = await waitForProcessId(pidFile);
      expect(refExists(repoDir)).toBe(true);

      controller.kill("SIGTERM");
      await waitForExit(controller, 12_000);

      expect(controller.exitCode).toBe(143);
      expect(processGroupExists(pgid!)).toBe(false);
      expect(refExists(repoDir)).toBe(true);
      const ownerOid = refOid(repoDir);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  }, 15_000);

  it("retains the lock when a nested managed process group escapes cancellation", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "nested-pgid");
    const signalRelayedFile = join(repoDir, "nested-signal-relayed");
    const nestedScript = join(repoDir, "nested.mjs");
    const relayScript = join(repoDir, "relay.mjs");
    writeFileSync(
      nestedScript,
      [
        'import fs from "node:fs";',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        'process.on("SIGTERM", () => fs.writeFileSync(process.argv[3], "relayed\\n"));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    writeFileSync(
      relayScript,
      [
        `import { runManagedCommand } from ${JSON.stringify(managedChildUrl)};`,
        "process.exitCode = await runManagedCommand({",
        "  bin: process.execPath,",
        `  args: [${JSON.stringify(nestedScript)}, ${JSON.stringify(nestedPidFile)}, ${JSON.stringify(signalRelayedFile)}],`,
        '  stdio: "ignore",',
        "});",
      ].join("\n"),
    );
    const fixture = writeOperationFixture(repoDir, "nested-operation.sh", [
      "acquire_pr_operation_lock 42",
      `node '${relayScript}'`,
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      stdio: "ignore",
    });
    let nestedPgid: number | undefined;
    try {
      expect(await waitFor(() => existsSync(nestedPidFile) && refExists(repoDir))).toBe(true);
      nestedPgid = await waitForProcessId(nestedPidFile);
      const ownerOid = refOid(repoDir);
      expect(processGroupExists(nestedPgid!)).toBe(true);

      controller.kill("SIGTERM");
      expect(await waitFor(() => existsSync(signalRelayedFile))).toBe(true);
      controller.kill("SIGTERM");
      await waitForExit(controller, 8000);

      expect(controller.exitCode).toBe(143);
      expect(processGroupExists(nestedPgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);
      const blocked = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\n" "$lock_status"',
      ]);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");

      killProcessGroup(nestedPgid!, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      const recovered = runLockShell(repoDir, [
        `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
      ]);
      expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      if (nestedPgid) {
        await cleanupProcessGroup(nestedPgid);
      }
      await cleanupController(repoDir, controller);
    }
  });

  it("has one dispatcher acquisition for composite prepare-run", () => {
    const script = readFileSync(join(repoRoot, "scripts/pr"), "utf8");
    const runner = readFileSync(processGroupRunner, "utf8");
    expect(script.match(/acquire_pr_operation_lock/g)).toHaveLength(1);
    expect(script).toContain('if [ "${1-}" = "gc" ] || is_locked_pr_command "${1-}"; then');
    expect(script).not.toMatch(/review-\*|prepare-\*|merge-\*/u);
    expect(script).toContain(
      "scripts/pr lock-recover <PR> <OWNER_OID> --confirmed-no-running-tools",
    );
    expect(script).toContain('recover_pr_operation_lock "$pr" "$owner_oid" "$confirmation"');
    expect(script).toContain('source "$script_parent_dir/pr-lib/operation-lock.sh"');
    expect(script).toContain(
      'pr-lib/process-group-runner.mjs" "$script_parent_dir/.." "$script_self" "$@"',
    );
    expect(script).toContain('prepare_run "$pr"');
    expect(runner).toContain('process.platform === "win32"');
    expect(runner).toContain("requires a POSIX process group");
    expect(readFileSync(join(repoRoot, "scripts/pr-lib/prepare-core.sh"), "utf8")).not.toContain(
      "acquire_pr_operation_lock",
    );
  });

  it("makes gc skip a PR while its operation lock is held", async () => {
    const repoDir = createRepo();
    mkdirSync(join(repoDir, ".worktrees", "pr-42"), { recursive: true });
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);

      const result = runLockShell(repoDir, [
        "gh() { if [ \"$1 $2\" = 'repo view' ]; then printf 'openclaw/openclaw\\n'; else printf 'MERGED\\n'; fi; }",
        "gc_pr_worktrees false",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("has an active scripts/pr operation");
      expect(existsSync(join(repoDir, ".worktrees", "pr-42"))).toBe(true);
    } finally {
      await cleanupChildren(holder);
    }
  });

  it("makes gc skip an unreadable lock and report exact recovery", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(worktreeDir, { recursive: true });
    const result = runLockShell(repoDir, [
      "bad_oid=$(printf 'not-a-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$bad_oid"`,
      "gh() { printf 'MERGED\\n'; }",
      "gc_pr_worktrees false",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("operation lock is unreadable");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${refOid(repoDir)} --confirmed-no-running-tools`,
    );
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("does not report removal when gc cleanup leaves the worktree", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(worktreeDir, { recursive: true });
    const result = runLockShell(repoDir, [
      "gh() { printf 'MERGED\\n'; }",
      "remove_worktree_if_present() { return 0; }",
      "delete_local_branch_if_safe() { return 0; }",
      "gc_pr_worktrees false",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("cleanup incomplete");
    expect(result.stdout).not.toContain("removed .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("removes a registered relative worktree under a repo path with escapes", () => {
    const repoDir = createRepo("repo with space \\ backslash");
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "pr-42", worktreeDir], {
      cwd: repoDir,
    });
    const canonicalWorktreeDir = realpathSync(worktreeDir);
    const located = runLockShell(repoDir, ["worktree_path_for_branch pr-42"]);
    expect(located.status, `${located.stdout}\n${located.stderr}`).toBe(0);
    expect(located.stdout.trim()).toBe(canonicalWorktreeDir);

    const result = runLockShell(repoDir, ["gh() { printf 'MERGED\\n'; }", "gc_pr_worktrees false"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("removed .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        encoding: "utf8",
      }),
    ).not.toContain(canonicalWorktreeDir);
    expect(
      spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"], {
        cwd: repoDir,
      }).status,
    ).toBe(1);
  });

  it("refuses a symlink alias to another registered worktree", () => {
    const repoDir = createRepo();
    const worktreesDir = join(repoDir, ".worktrees");
    const targetDir = join(worktreesDir, "pr-99");
    const aliasDir = join(worktreesDir, "pr-42");
    mkdirSync(worktreesDir, { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "pr-99", targetDir], {
      cwd: repoDir,
    });
    const canonicalTargetDir = realpathSync(targetDir);
    symlinkSync("pr-99", aliasDir, "dir");

    const result = runLockShell(repoDir, ['remove_worktree_if_present ".worktrees/pr-42"']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("refusing to remove non-canonical PR-worktree path");
    expect(existsSync(aliasDir)).toBe(true);
    expect(existsSync(targetDir)).toBe(true);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        encoding: "utf8",
      }),
    ).toContain(canonicalTargetDir);
  });
});
