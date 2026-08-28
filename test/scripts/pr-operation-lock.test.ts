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
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const escapedPipeHolderPidFiles = new Set<string>();
afterEach(async () => {
  const failures: unknown[] = [];
  for (const pidFile of escapedPipeHolderPidFiles) {
    try {
      await cleanupRecordedProcessGroup(pidFile);
    } catch (error) {
      failures.push(error);
    }
  }
  escapedPipeHolderPidFiles.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up escaped notification-pipe holders");
  }
});
const repoRoot = process.cwd();
const commonScript = join(repoRoot, "scripts/pr-lib/common.sh");
const lockScript = join(repoRoot, "scripts/pr-lib/operation-lock.sh");
const processGroupRunner = join(repoRoot, "scripts/pr-lib/process-group-runner.mjs");
const managedChildUrl = pathToFileURL(join(repoRoot, "scripts/lib/managed-child-process.mts")).href;
const worktreeScript = join(repoRoot, "scripts/pr-lib/worktree.sh");
const lockRef = "refs/openclaw/pr-operation-locks/42";
const detachedChildren = new WeakSet<ChildProcess>();
const goneProcessGroups = new Set<number>();
let templateRepo = "";

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

function createTemplateRepo() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-operation-lock-template-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "OpenClaw Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@openclaw.invalid"], { cwd: dir });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

beforeAll(() => {
  templateRepo = createTemplateRepo();
});

afterAll(() => {
  rmSync(templateRepo, { force: true, recursive: true });
});

function createRepo(nestedName?: string) {
  const tempRoot = tempDirs.make("openclaw-pr-operation-lock-");
  const dir = nestedName ? join(tempRoot, nestedName) : tempRoot;
  if (nestedName) {
    mkdirSync(dir);
  }
  // Preserve per-test Git isolation without paying five setup processes per fixture.
  cpSync(templateRepo, dir, { recursive: true });
  return dir;
}

function addTrackedUiConfig(repoDir: string) {
  const configDir = join(repoDir, "ui", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "control-ui-chunking.ts"), "export const chunking = true;\n");
  execFileSync("git", ["add", "ui/config/control-ui-chunking.ts"], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "add ui config"], { cwd: repoDir });
}

function setSparseCheckout(repoDir: string) {
  execFileSync("git", ["sparse-checkout", "init", "--no-cone"], { cwd: repoDir });
  execFileSync("git", ["sparse-checkout", "set", "--no-cone", "--stdin"], {
    cwd: repoDir,
    input: "/*\n!/*/\n/base.txt\n",
  });
}

function enterPrWorktree(repoDir: string, pr: number) {
  const result = runLockShell(repoDir, [
    "ensure_gh_api_auth() { return 0; }",
    `enter_worktree ${pr}`,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return { result, worktreeDir: join(repoDir, ".worktrees", `pr-${pr}`) };
}

function expectWorktreeBranch(worktreeDir: string, branch: string) {
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreeDir,
      encoding: "utf8",
    }).trim(),
  ).toBe(branch);
}

function expectMaterializedWorktree(worktreeDir: string) {
  expect(existsSync(join(worktreeDir, "ui", "config", "control-ui-chunking.ts"))).toBe(true);
  expect(
    execFileSync("git", ["config", "--bool", "core.sparseCheckout"], {
      cwd: worktreeDir,
      encoding: "utf8",
    }).trim(),
  ).toBe("false");
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

function writeFixtureFile(repoDir: string, name: string, contents: string | readonly string[]) {
  const fixture = join(repoDir, name);
  writeFileSync(fixture, typeof contents === "string" ? contents : contents.join("\n"));
  return fixture;
}

function writeOperationFixture(repoDir: string, name: string, commands: string[]) {
  const fixture = writeFixtureFile(
    repoDir,
    name,
    ["#!/usr/bin/env bash", ...bashSource(repoDir, true), ...commands].join("\n"),
  );
  chmodSync(fixture, 0o755);
  return fixture;
}

function writeEscapedPipeHolderLauncher(repoDir: string, pidFile: string) {
  const holderScript = writeFixtureFile(
    repoDir,
    "escaped-pipe-holder.mjs",
    "setInterval(() => {}, 1000);\n",
  );
  return writeFixtureFile(repoDir, "escaped-pipe-holder-launcher.mjs", [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    `const child = spawn(process.execPath, [${JSON.stringify(holderScript)}], {`,
    "  detached: true,",
    '  stdio: ["ignore", "ignore", "ignore", 3],',
    "});",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "child.unref();",
  ]);
}

function installPrCliFixture(repoDir: string) {
  const files = [
    "scripts/pr",
    "scripts/watch-pr-ci.mjs",
    "scripts/watch-pr-ci.mts",
    "scripts/verify-pr-hosted-gates.mjs",
    "scripts/verify-pr-hosted-gates.mts",
    "scripts/lib/plain-gh.sh",
    "scripts/lib/plain-gh.mjs",
    "scripts/lib/direct-run.mjs",
    "scripts/lib/tsx-cli-shim.mjs",
    "scripts/lib/local-check-runtime.mts",
    "scripts/tsx.mjs",
    "scripts/pr-lib/worktree.sh",
    "scripts/pr-lib/operation-lock.sh",
    "scripts/pr-lib/process-group-runner.mjs",
    "scripts/pr-lib/common.sh",
    "scripts/pr-lib/changelog.sh",
    "scripts/pr-lib/gates.sh",
    "scripts/pr-lib/ci-dispatch.mjs",
    "scripts/pr-lib/push.sh",
    "scripts/pr-lib/review.sh",
    "scripts/pr-lib/review-artifacts.mjs",
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

function installRequiredPrCommandStubs(binDir: string) {
  for (const command of ["gh", "jq", "pnpm", "rg"]) {
    const stub = join(binDir, command);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
  }
}

interface SupervisedFixtureOptions {
  accelerateTimeouts?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function runSupervisedFixture(
  repoDir: string,
  fixture: string,
  options: SupervisedFixtureOptions = {},
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

function runSupervisedOperation(
  repoDir: string,
  name: string,
  commands: string[],
  options?: SupervisedFixtureOptions,
) {
  return runSupervisedFixture(repoDir, writeOperationFixture(repoDir, name, commands), options);
}

function runLockShell(repoDir: string, commands: string[]) {
  return spawnSync("bash", ["-c", [...bashSource(repoDir), ...commands].join("\n")], {
    cwd: repoDir,
    detached: true,
    encoding: "utf8",
    timeout: 10_000,
  } as { cwd: string; encoding: "utf8"; timeout: number });
}

function probeOperationLock(repoDir: string, command: "blocking" | "try" = "try") {
  return runLockShell(repoDir, [
    "set +e",
    command === "try" ? "try_acquire_pr_operation_lock 42" : "acquire_pr_operation_lock 42",
    "lock_status=$?",
    "set -e",
    'printf "%s\\n" "$lock_status"',
  ]);
}

function recoverOperationLock(repoDir: string, ownerOid: string, commands: string[] = []) {
  const result = runLockShell(repoDir, [
    `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ...commands,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(refExists(repoDir)).toBe(false);
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
    await new Promise((resolve) => setTimeout(resolve, 5));
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

async function cleanupRecordedProcessGroup(path: string, pgid?: number) {
  const recordedPgid = pgid ?? readProcessIdFile(path);
  if (recordedPgid) {
    await cleanupProcessGroup(recordedPgid);
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
  it.runIf(process.platform !== "win32")(
    "preserves the child status when the completion marker cannot be written",
    async () => {
      const repoDir = createRepo();
      const fixture = writeFixtureFile(repoDir, "closed-completion-fd.sh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `source '${lockScript}'`,
        "exit 7",
      ]);
      chmodSync(fixture, 0o755);
      const child = spawnDetached("bash", [fixture], {
        cwd: repoDir,
        env: {
          ...process.env,
          OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1",
          OPENCLAW_PR_LOCK_NOTIFY_FD: "3",
          OPENCLAW_PR_LOCK_SUPERVISOR_PID: String(process.pid),
        },
        stdio: "ignore",
      });
      try {
        await waitForExit(child);
        expect(child.exitCode).toBe(7);
      } finally {
        await cleanupChildren(child);
      }
    },
  );
});

const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("scripts/pr per-PR operation lock", () => {
  it("serializes the same PR and releases the waiter after SIGTERM", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const blocked = join(repoDir, "blocked");
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
            `sleep() { printf 'blocked\\n' >'${blocked}'; command sleep 0.01; }`,
            "acquire_pr_operation_lock 42",
            `printf 'acquired\\n' >'${acquired}'`,
            "release_pr_operation_lock",
          ].join("\n"),
        ],
        { cwd: repoDir, stdio: "ignore" },
      );
      expect(await waitFor(() => existsSync(blocked))).toBe(true);
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
      const blocked = probeOperationLock(repoDir, "blocking");
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      expect(blocked.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid);
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
      recoverOperationLock(repoDir, oldOid);
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
  it.each([
    ["does not lock an unsupported command that shares a known prefix", "review-not-a-command"],
    ["does not lock review-tests before validating its required target", "review-tests"],
  ])("%s", (_title, command) => {
    const repoDir = createRepo();
    const { cli } = installPrCliFixture(repoDir);
    const result = spawnSync(cli, [command, "42"], {
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
    installRequiredPrCommandStubs(binDir);
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
  it("releases a validation-phase lock when temporary storage is unavailable", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(
      reviewScript,
      `${readFileSync(reviewScript, "utf8")}\nreview_init() { printf 'review ran\\n'; }\n`,
    );
    installRequiredPrCommandStubs(binDir);
    const mktempStub = join(binDir, "mktemp");
    writeFileSync(mktempStub, "#!/bin/sh\necho 'mktemp: No space left on device' >&2\nexit 1\n");
    chmodSync(mktempStub, 0o755);

    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("mktemp: No space left on device");
    expect(result.stderr).toContain("temporary-storage preflight failed");
    expect(result.stderr).toContain("Free disk space or set TMPDIR");
    expect(result.stderr).not.toContain("Retaining the operation lock");
    expect(result.stderr).not.toContain("scripts/pr lock-recover");
    expect(result.stdout).not.toContain("review ran");
    expect(refExists(repoDir)).toBe(false);
  });
  it("releases a validation-phase lock when review-init metadata fails", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(
      reviewScript,
      `${readFileSync(reviewScript, "utf8")}\nenter_worktree() { printf 'entered-worktree\\n'; }\npr_meta_json() { echo 'fixture metadata failure' >&2; return 1; }\n`,
    );
    installRequiredPrCommandStubs(binDir);

    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(refExists(repoDir), result.stderr).toBe(false);
    expect(result.stderr).toContain("fixture metadata failure");
    expect(result.stderr).not.toContain("Retaining the operation lock");
    expect(result.stderr).not.toContain("scripts/pr lock-recover");
    expect(result.stdout).not.toContain("entered-worktree");
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
      const blockedLine = expectDefined(
        result.stdout.trim().split("\n")[0],
        "blocked PR operation lock output",
      );
      const ownerOid = expectDefined(blockedLine.split("\t")[1], "blocked PR operation owner oid");
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
      const stillBlocked = probeOperationLock(repoDir, "blocking");
      expect(stillBlocked.status).toBe(0);
      expect(stillBlocked.stdout.trim()).toBe("2");
      recoverOperationLock(repoDir, ownerOid, [
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
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
  it.each([
    {
      title: "has the process-group supervisor release the exact owner ref",
      fixture: "acquire-once.sh",
      commands: ["acquire_pr_operation_lock 42"],
      status: 0,
      retained: false,
    },
    {
      title: "releases a failed lock while the child is still in validation phase",
      fixture: "failed-validation.sh",
      commands: ["acquire_pr_operation_lock 42", "begin_pr_operation_validation_phase", "exit 3"],
      status: 3,
      retained: false,
    },
    {
      title: "retains a failed lock after the child leaves validation phase",
      fixture: "failed-after-side-effects.sh",
      commands: [
        "acquire_pr_operation_lock 42",
        "begin_pr_operation_validation_phase",
        "mark_pr_operation_side_effects_started",
        "exit 3",
      ],
      status: 3,
      retained: true,
    },
    {
      title: "reports the child exit code when retaining a failed operation",
      fixture: "failed-operation.sh",
      commands: ["acquire_pr_operation_lock 42", "exit 3"],
      status: 3,
      retained: true,
    },
    {
      title: "does not re-enter validation after side effects have started",
      fixture: "failed-after-forged-validation.sh",
      commands: [
        "acquire_pr_operation_lock 42",
        "begin_pr_operation_validation_phase",
        "mark_pr_operation_side_effects_started",
        "notify_pr_operation_phase validation-started",
        "exit 3",
      ],
      status: 3,
      retained: true,
    },
    {
      title: "retains a validation-phase lock when the child exits through a trapped signal",
      fixture: "signaled-validation.sh",
      commands: [
        "trap 'exit 143' TERM",
        "acquire_pr_operation_lock 42",
        "begin_pr_operation_validation_phase",
        "kill -TERM $$",
      ],
      status: 143,
      retained: true,
    },
    {
      title: "retains a validation-phase lock for untrapped signal exit statuses",
      fixture: "killed-validation.sh",
      commands: ["acquire_pr_operation_lock 42", "begin_pr_operation_validation_phase", "exit 137"],
      status: 137,
      retained: true,
    },
  ])("$title", async ({ fixture, commands, status, retained }) => {
    const repoDir = createRepo();
    const result = await runSupervisedOperation(repoDir, fixture, commands);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    if (retained) {
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(`reason: child exited with code ${status}`);
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid);
    } else {
      expect(refExists(repoDir)).toBe(false);
      expect(result.stderr).not.toContain("Retaining the operation lock");
    }
  });
  it.each([
    { wrapper: "canonical", command: "merge-run", failure: "none" },
    { wrapper: "linked", command: "merge-run", failure: "none" },
    { wrapper: "linked", command: "gc", failure: "none" },
    { wrapper: "linked", command: "merge-run", failure: "merge" },
    { wrapper: "linked", command: "merge-run", failure: "release" },
  ])(
    "finishes native cleanup with $wrapper wrapper ($command, failure=$failure)",
    ({ wrapper, command, failure }) => {
      const repoDir = createRepo();
      const { binDir, cli } = installPrCliFixture(repoDir);
      const rg = writeFixtureFile(binDir, "rg", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$#" -ne 4 ] || [ "$1" != "-n" ] || [ "$2" != "-i" ]; then',
        '  echo "unexpected fixture rg call: $*" >&2',
        "  exit 99",
        "fi",
        'exec grep -n -i -E -- "$3" "$4"',
      ]);
      chmodSync(rg, 0o755);
      const worktreeDir = join(repoDir, ".worktrees", "pr-42");
      const lifecycle = join(repoDir, "lifecycle.log");
      const ownerFile = join(repoDir, "owner-oid");
      const releaseCwd = join(repoDir, "release-cwd");
      const refLock = join(repoDir, ".git/refs/openclaw/pr-operation-locks/42.lock");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
      git("config", "commit.gpgSign", "false");
      git("config", "core.hooksPath", "/dev/null");
      git("config", "core.filesRefLockTimeout", "0");
      // Gate policy has its own merge tests. Keep the real wrapper, worktree
      // entry/removal, completion marker, supervisor, and exact-owner release.
      const mergeScript = join(repoDir, "scripts/pr-lib/merge.sh");
      writeFileSync(
        mergeScript,
        `${readFileSync(mergeScript, "utf8")}\n` +
          "validate_review_artifact_data() { :; }\n" +
          "merge_verify() { mark_pr_operation_side_effects_started; }\n",
      );
      git("add", "scripts");
      git("commit", "-qm", "test: native cleanup fixture");
      const preparedHead = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", preparedHead);
      git("worktree", "add", "-q", "-b", "temp/pr-42", worktreeDir);
      if (wrapper === "linked") {
        // origin/main still names the linked wrapper; canonical code must not
        // be substituted merely to obtain the persistent supervisor cwd.
        writeFileSync(
          mergeScript,
          "merge_run() { echo 'wrong canonical wrapper' >&2; exit 91; }\n",
        );
        git("add", "scripts/pr-lib/merge.sh");
        git("commit", "-qm", "test: canonical wrapper drift");
      }
      const canonicalHead = git("rev-parse", "HEAD");
      const localDir = join(worktreeDir, ".local");
      mkdirSync(localDir);
      for (const artifact of ["review.md", "pr-meta.env", "pr-meta.json", "prep.md"]) {
        writeFileSync(join(localDir, artifact), "fixture\n");
      }
      writeFileSync(join(localDir, "review.json"), '{"recommendation":"READY FOR /prepare-pr"}\n');
      writeFileSync(join(localDir, "prep.env"), `PREP_HEAD_SHA=${preparedHead}\n`);
      // Both cached and plain gh routes use this executable. Unknown requests
      // fail locally; neither this fixture nor its origin can contact GitHub.
      const gh = writeFixtureFile(binDir, "gh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$*" in',
        '  "auth token") exit 1 ;;',
        '  "api graphql "*) printf "fixture-user\\n" ;;',
        '  "pr view 42 --json baseRefName")',
        '    printf "invocation\\t%s\\n" "$PWD" >> "$OPENCLAW_TEST_LIFECYCLE"',
        `    printf '%s\\n' '{"baseRefName":"main"}' ;;`,
        `  "pr view 42 --json state,isDraft") printf '%s\\n' '{"state":"OPEN","isDraft":false}' ;;`,
        '  "pr merge 42 "*)',
        '    git rev-parse refs/openclaw/pr-operation-locks/42 > "$OPENCLAW_TEST_OWNER"',
        '    if [ "$OPENCLAW_TEST_FAILURE" = merge ]; then echo "fixture merge failed" >&2; exit 7; fi',
        '    printf "merged\\n" >> "$OPENCLAW_TEST_LIFECYCLE" ;;',
        '  "pr view 42 --json state --jq .state") printf "MERGED\\n" ;;',
        `  "pr view 42 --json mergeCommit "*) printf '%s\\n' '${preparedHead}' ;;`,
        '  "repo view "*) printf "fixture/repo\\n" ;;',
        '  "api --method POST repos/{owner}/{repo}/issues/42/comments "*)',
        '    printf "comment\\n" >> "$OPENCLAW_TEST_LIFECYCLE"',
        '    printf "https://example.invalid/comment\\n" ;;',
        `  "pr view 42 --json headRefName,"*) printf '%s\\n' '{"headRefName":""}' ;;`,
        '  "pr view 42 --json url --jq .url") printf "https://example.invalid/42\\n" ;;',
        '  *) echo "unexpected fixture gh call: $*" >&2; exit 99 ;;',
        "esac",
      ]);
      chmodSync(gh, 0o755);
      const realGit = realpathSync(join(binDir, "git"));
      unlinkSync(join(binDir, "git"));
      const gitShim = writeFixtureFile(binDir, "git", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$*" in',
        '  "fetch "*|"-C "*" fetch "*) exit 0 ;;',
        '  "worktree remove "*)',
        '    "$OPENCLAW_TEST_REAL_GIT" "$@"',
        '    printf "removed\\n" >> "$OPENCLAW_TEST_LIFECYCLE"',
        '    if [ "$OPENCLAW_TEST_FAILURE" = release ]; then : > "$OPENCLAW_TEST_REF_LOCK"; fi',
        "    exit 0 ;;",
        '  *"update-ref --no-deref -d refs/openclaw/pr-operation-locks/42 "*)',
        '    pwd -P > "$OPENCLAW_TEST_RELEASE_CWD"',
        '    "$OPENCLAW_TEST_REAL_GIT" "$@"',
        '    printf "released\\n" >> "$OPENCLAW_TEST_LIFECYCLE"',
        "    exit 0 ;;",
        "esac",
        'exec "$OPENCLAW_TEST_REAL_GIT" "$@"',
      ]);
      chmodSync(gitShim, 0o755);
      const result = spawnSync(
        wrapper === "linked" ? join(worktreeDir, "scripts/pr") : cli,
        command === "gc" ? [command] : [command, "42"],
        {
          cwd: worktreeDir,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            OPENCLAW_GH_BIN: gh,
            OPENCLAW_PR_AUTO_MERGE: "0",
            OPENCLAW_PR_MERGE_METHOD: "squash",
            OPENCLAW_TEST_FAILURE: failure,
            OPENCLAW_TEST_LIFECYCLE: lifecycle,
            OPENCLAW_TEST_OWNER: ownerFile,
            OPENCLAW_TEST_REAL_GIT: realGit,
            OPENCLAW_TEST_REF_LOCK: refLock,
            OPENCLAW_TEST_RELEASE_CWD: releaseCwd,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(existsSync(lifecycle), output).toBe(true);
      const events = readFileSync(lifecycle, "utf8");
      expect(git("rev-parse", "HEAD")).toBe(canonicalHead);
      expect(existsSync(worktreeDir)).toBe(failure === "merge");
      if (failure === "merge") {
        expect(result.status, output).toBe(1);
        expect(output).toContain("fixture merge failed");
        expect(events).toBe(`invocation\t${worktreeDir}\n`);
      } else {
        const completedEvents =
          command === "gc" ? "removed\n" : `invocation\t${worktreeDir}\nmerged\ncomment\nremoved\n`;
        expect(events, output).toBe(completedEvents + (failure === "none" ? "released\n" : ""));
        expect(readFileSync(releaseCwd, "utf8").trim(), output).toBe(repoDir);
        expect(result.status, output).toBe(failure === "none" ? 0 : 1);
        expect(result.stdout).toContain(
          command === "gc" ? "removed .worktrees/pr-42" : "merge-run complete for PR #42",
        );
      }
      if (failure === "none") {
        expect(refExists(repoDir), output).toBe(false);
        expect(result.stderr).not.toContain("Retaining the operation lock");
      } else {
        const ownerOid = readFileSync(ownerFile, "utf8").trim();
        expect(refOid(repoDir)).toBe(ownerOid);
        expect(result.stderr).toContain(
          `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
        );
        if (failure === "release") {
          expect(result.stderr).toContain("Unable to release the operation lock for 42");
        }
      }
    },
  );
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
    recoverOperationLock(repoDir, ownerOid);
  });
  it("rejects a notification for a lock owned by another process group", async () => {
    const repoDir = createRepo();
    const foreignRef = "refs/openclaw/pr-operation-locks/43";
    const foreignHeld = join(repoDir, "foreign-held");
    const foreignHolder = spawnHolder(repoDir, foreignHeld, 43);
    try {
      expect(await waitFor(() => existsSync(foreignHeld))).toBe(true);
      const foreignOid = refOid(repoDir, foreignRef);
      const result = await runSupervisedOperation(repoDir, "forged-notification.sh", [
        "acquire_pr_operation_lock 42",
        `printf '%s\\t%s\\n' '${foreignRef}' '${foreignOid}' >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(refOid(repoDir, foreignRef)).toBe(foreignOid);
      expect(refExists(repoDir)).toBe(true);
      expect(result.stderr).toContain("operation lock owned by another process group");
      const ownerOid = refOid(repoDir);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupChildren(foreignHolder);
    }
  });
  it.each([
    [
      "retains the lock after newline-terminated malformed supervisor metadata",
      "malformed-notification.sh",
      "printf 'not-lock-metadata\\n'",
      "malformed operation-lock metadata",
    ],
    [
      "retains the lock after unterminated malformed supervisor metadata",
      "malformed-notification.sh",
      "printf 'not-lock-metadata'",
      "malformed operation-lock metadata",
    ],
    [
      "bounds an oversized unterminated supervisor metadata line",
      "oversized-notification.sh",
      `node -e 'process.stdout.write("x".repeat(8192))'`,
      "operation-lock metadata line is too large",
    ],
  ])("%s", async (_title, fixture, command, expectedError) => {
    const repoDir = createRepo();
    const result = await runSupervisedOperation(repoDir, fixture, [
      "acquire_pr_operation_lock 42",
      `${command} >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
    ]);
    const ownerOid = refOid(repoDir);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    expect(refOid(repoDir)).toBe(ownerOid);
    recoverOperationLock(repoDir, ownerOid);
  });
  it("releases after leader completion despite an fd-closing detached daemon", async () => {
    const repoDir = createRepo();
    const daemonPidFile = join(repoDir, "unrelated-daemon-pgid");
    const daemonScript = writeFixtureFile(
      repoDir,
      "unrelated-daemon.mjs",
      "setInterval(() => {}, 1000);\n",
    );
    const launcherScript = writeFixtureFile(repoDir, "unrelated-daemon-launcher.mjs", [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(daemonScript)}], {`,
      "  detached: true,",
      '  stdio: "ignore",',
      "});",
      `fs.writeFileSync(${JSON.stringify(daemonPidFile)}, String(child.pid));`,
      "child.unref();",
    ]);
    let daemonPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(repoDir, "clean-detached-launcher.sh", [
        "acquire_pr_operation_lock 42",
        `node '${launcherScript}'`,
      ]);
      daemonPgid = await waitForProcessId(daemonPidFile);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(processGroupExists(daemonPgid)).toBe(true);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupRecordedProcessGroup(daemonPidFile, daemonPgid);
    }
  });
  it("joins worktree-list producers before releasing a successful operation lock", async () => {
    const repoDir = createRepo();
    const producerExited = join(repoDir, "worktree-producer-exited");
    const result = await runSupervisedOperation(repoDir, "joined-worktree-operation.sh", [
      "acquire_pr_operation_lock 42",
      "git() {",
      '  if [ "$1" = worktree ] && [ "$2" = list ]; then',
      "    printf 'worktree %s\\0branch refs/heads/pr-42\\0\\0' \"$PWD\"",
      "    exec 1>&-",
      "    sleep 0.1",
      "    : >worktree-producer-exited",
      "    return 0",
      "  fi",
      '  command git "$@"',
      "}",
      'worktree_is_registered "$PWD"',
      "test -f worktree-producer-exited",
      "rm worktree-producer-exited",
      'resolved="$(worktree_path_for_branch pr-42)"',
      'test "$resolved" = "$PWD"',
      "test -f worktree-producer-exited",
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(existsSync(producerExited)).toBe(true);
    expect(refExists(repoDir)).toBe(false);
    expect(result.stderr).not.toContain("process group remained active after wrapper exit");
  });
  it("retains a failed operation lock when a detached child outlives its launcher", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "failed-nested-pgid");
    const nestedScript = writeFixtureFile(repoDir, "failed-nested.mjs", [
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ]);
    const launcherScript = writeFixtureFile(repoDir, "failing-launcher.mjs", [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(nestedScript)}], {`,
      "  detached: true,",
      '  stdio: "ignore",',
      "});",
      `fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(child.pid));`,
      "process.exit(1);",
    ]);
    let nestedPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(repoDir, "failed-operation.sh", [
        "acquire_pr_operation_lock 42",
        `node '${launcherScript}'`,
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      nestedPgid = await waitForProcessId(nestedPidFile);
      expect(processGroupExists(nestedPgid!)).toBe(true);
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      const blocked = probeOperationLock(repoDir);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      killProcessGroup(nestedPgid!, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(nestedPidFile, nestedPgid);
    }
  });
  it("warns and releases after leader completion when an escaped child keeps the notification pipe open", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "clean-pipe-holder-operation-pgid");
    const holderPidFile = join(repoDir, "clean-pipe-holder-pgid");
    escapedPipeHolderPidFiles.add(holderPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, holderPidFile);

    const result = await runSupervisedOperation(
      repoDir,
      "clean-pipe-holder-operation.sh",
      [
        `printf '%s\\n' "$$" >'${operationPgidFile}'`,
        "acquire_pr_operation_lock 42",
        `node '${launcherScript}'`,
      ],
      { accelerateTimeouts: true },
    );

    const operationPgid = await waitForProcessId(operationPgidFile);
    const holderPgid = await waitForProcessId(holderPidFile);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(operationPgid).not.toBe(holderPgid);
    expect(processGroupExists(operationPgid)).toBe(false);
    expect(processGroupExists(holderPgid)).toBe(true);
    expect(refExists(repoDir)).toBe(false);
    expect(result.stderr).toContain("Warning:");
    expect(result.stderr).toContain("group=dead, pipe=open");
    expect(result.stderr).toContain("#124583");
  }, 15_000);
  it("retains a clean-exit lock when the leader completion marker is suppressed", async () => {
    const repoDir = createRepo();
    const holderPidFile = join(repoDir, "suppressed-completion-holder-pgid");
    escapedPipeHolderPidFiles.add(holderPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, holderPidFile);
    let holderPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(
        repoDir,
        "suppressed-completion-operation.sh",
        ["acquire_pr_operation_lock 42", "trap - EXIT", `node '${launcherScript}'`],
        { accelerateTimeouts: true },
      );
      holderPgid = await waitForProcessId(holderPidFile);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(processGroupExists(holderPgid)).toBe(true);
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain("reason: notification pipe still open after drain deadline");
      expect(result.stderr).toContain(
        "scripts/pr operation lifetime did not drain (group=dead, pipe=open)",
      );
      expect(result.stderr).not.toContain("Warning:");
      const blocked = probeOperationLock(repoDir);
      expect(blocked.status, `${blocked.stdout}\n${blocked.stderr}`).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      killProcessGroup(holderPgid, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(holderPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(holderPidFile, holderPgid);
    }
  }, 15_000);
  it("retains a failed side-effects lock when an escaped child keeps the notification pipe open", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "pipe-holder-pgid");
    escapedPipeHolderPidFiles.add(nestedPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, nestedPidFile);
    let nestedPgid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = await runSupervisedOperation(
        repoDir,
        "pipe-holder-operation.sh",
        [
          "acquire_pr_operation_lock 42",
          "begin_pr_operation_validation_phase",
          "mark_pr_operation_side_effects_started",
          `node '${launcherScript}'`,
          "exit 1",
        ],
        { accelerateTimeouts: true },
      );
      const elapsed = Date.now() - startedAt;
      nestedPgid = await waitForProcessId(nestedPidFile);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(elapsed).toBeLessThan(12_000);
      expect(processGroupExists(nestedPgid)).toBe(true);
      expect(result.stderr).toContain("operation lifetime did not drain");
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(
        "reason: child exited with code 1; notification pipe still open after drain deadline",
      );
      killProcessGroup(nestedPgid, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(nestedPidFile, nestedPgid);
    }
  }, 15_000);
  it("waits while a live supervisor finishes draining a dead operation group", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "finishing-operation-pgid");
    const holderPidFile = join(repoDir, "finishing-holder-pgid");
    const acquiredFile = join(repoDir, "finishing-waiter-acquired");
    const holderScript = writeFixtureFile(
      repoDir,
      "finishing-holder.mjs",
      "setInterval(() => {}, 1000);\n",
    );
    const launcherScript = writeFixtureFile(repoDir, "finishing-launcher.mjs", [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(holderScript)}], {`,
      "  detached: true,",
      '  stdio: ["ignore", "ignore", "ignore", 3],',
      "});",
      `fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(child.pid));`,
      "process.exit(0);",
    ]);
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
      const probe = probeOperationLock(repoDir);
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
      await cleanupRecordedProcessGroup(holderPidFile, holderPgid);
      await cleanupChildren(waiter);
      await cleanupController(repoDir, controller, operationPgidFile);
    }
  }, 12_000);
  it("drains a same-group background job after its wrapper fails", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "failed-operation-pgid");
    const backgroundPidFile = join(repoDir, "failed-background-pid");
    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(repoDir, "failed-background-operation.sh", [
        `printf '%s\\n' "$$" >'${operationPgidFile}'`,
        "acquire_pr_operation_lock 42",
        "sleep 30 &",
        `printf '%s\\n' "$!" >'${backgroundPidFile}'`,
        "exit 1",
      ]);
      operationPgid = await waitForProcessId(operationPgidFile);
      const ownerOid = refOid(repoDir);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(await waitForProcessId(backgroundPidFile)).toBeGreaterThan(1);
      expect(processGroupExists(operationPgid)).toBe(false);
      expect(refOid(repoDir)).toBe(ownerOid);
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(operationPgidFile, operationPgid);
    }
  });
  it("fails and retains the lock when a clean wrapper leaves same-group work", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "clean-background-operation-pgid");
    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(repoDir, "clean-background-operation.sh", [
        `printf '%s\\n' "$$" >'${operationPgidFile}'`,
        "acquire_pr_operation_lock 42",
        "sleep 30 &",
        "exit 0",
      ]);
      operationPgid = await waitForProcessId(operationPgidFile);
      const ownerOid = refOid(repoDir);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(processGroupExists(operationPgid)).toBe(false);
      expect(result.stderr).toContain("process group remained active after wrapper exit");
      expect(result.stderr).toContain(`surviving processes in group ${operationPgid}`);
      expect(result.stderr).toMatch(/^\s+\d+ \d+ sleep$/mu);
      expect(result.stderr).toContain("process group appears empty at report time");
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(operationPgidFile, operationPgid);
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
      const probe = probeOperationLock(repoDir);
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
        recoverOperationLock(repoDir, ownerOid, [
          "acquire_pr_operation_lock 42",
          "release_pr_operation_lock",
        ]);
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
      const blocked = probeOperationLock(repoDir, "blocking");
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid, [
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
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
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  }, 15_000);
  it("retains the lock when a nested managed process group escapes cancellation", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "nested-pgid");
    const signalRelayedFile = join(repoDir, "nested-signal-relayed");
    const nestedScript = writeFixtureFile(repoDir, "nested.mjs", [
      'import fs from "node:fs";',
      "fs.writeFileSync(process.argv[2], String(process.pid));",
      'process.on("SIGTERM", () => fs.writeFileSync(process.argv[3], "relayed\\n"));',
      "setInterval(() => {}, 1000);",
    ]);
    const relayScript = writeFixtureFile(repoDir, "relay.mjs", [
      `import { runManagedCommand } from ${JSON.stringify(managedChildUrl)};`,
      "process.exitCode = await runManagedCommand({",
      "  bin: process.execPath,",
      `  args: [${JSON.stringify(nestedScript)}, ${JSON.stringify(nestedPidFile)}, ${JSON.stringify(signalRelayedFile)}],`,
      '  stdio: "ignore",',
      "});",
    ]);
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
      const blocked = probeOperationLock(repoDir);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      killProcessGroup(nestedPgid!, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
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
  it("removes a registered relative worktree under a NUL-framed escaped Unicode path", () => {
    const repoDir = createRepo("repo with space \\ backslash\n雪");
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
  it("propagates producer failures from NUL-framed worktree listings", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "git() {",
      '  if [ "$1" = worktree ] && [ "$2" = list ]; then',
      "    printf 'worktree %s\\0branch refs/heads/pr-42\\0\\0' \"$PWD\"",
      "    return 23",
      "  fi",
      '  command git "$@"',
      "}",
      "set +e",
      'worktree_is_registered "$PWD"',
      'registered_status="$?"',
      "worktree_path_for_branch pr-42 >/dev/null",
      'branch_status="$?"',
      'printf "%s %s\\n" "$registered_status" "$branch_status"',
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("23 23");
  });
  it("parses docs and mixed file lists without temp files or producer processes", () => {
    const repoDir = createRepo();
    const unusableTmpDir = join(repoDir, "missing-tmp");
    const result = runLockShell(repoDir, [
      `TMPDIR='${unusableTmpDir}'`,
      "printf() { echo 'unexpected producer' >&2; return 99; }",
      "set +e",
      "file_list_is_docsish_only ''",
      'empty_status="$?"',
      "file_list_is_docsish_only $'docs/guide.md\\nREADME.md'",
      'docs_status="$?"',
      "file_list_is_docsish_only $'docs/guide.md\\nsrc/index.ts'",
      'mixed_status="$?"',
      'command printf "%s %s %s\\n" "$empty_status" "$docs_status" "$mixed_status"',
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1 0 1");
    expect(result.stderr).not.toContain("unexpected producer");
    expect(readFileSync(commonScript, "utf8")).not.toMatch(/done\s+(?:<<<|<\s*<\()/u);
  });
  it("prunes a registered worktree whose directory is already gone", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "pr-42", worktreeDir], {
      cwd: repoDir,
    });
    const canonicalWorktreeDir = realpathSync(worktreeDir);
    rmSync(worktreeDir, { recursive: true });
    const result = runLockShell(repoDir, ['remove_worktree_if_present ".worktrees/pr-42"']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        encoding: "utf8",
      }),
    ).not.toContain(canonicalWorktreeDir);
  });
  it("surfaces git worktree remove stderr without making cleanup fatal", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "pr-42", worktreeDir], {
      cwd: repoDir,
    });
    const result = runLockShell(repoDir, [
      "git() {",
      "  if [ \"$1 $2\" = 'worktree remove' ]; then",
      "    echo 'fixture remove failure' >&2",
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      'remove_worktree_if_present ".worktrees/pr-42"',
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "Warning: git worktree remove failed for .worktrees/pr-42: fixture remove failure",
    );
    expect(existsSync(worktreeDir)).toBe(true);
  });
  it("prunes a missing registration and resets its script-owned branch on worktree add", () => {
    const repoDir = createRepo();
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const physicalWorktreesDir = join(repoDir, "linked-worktrees");
    mkdirSync(physicalWorktreesDir);
    symlinkSync(physicalWorktreesDir, join(repoDir, ".worktrees"), "dir");
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    execFileSync("git", ["worktree", "add", "-q", "-b", "temp/pr-42", worktreeDir], {
      cwd: repoDir,
    });
    rmSync(worktreeDir, { recursive: true });
    const { result } = enterPrWorktree(repoDir, 42);
    expect(result.stdout).toContain("Pruning stale worktree registration for .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(true);
    expectWorktreeBranch(worktreeDir, "temp/pr-42");
  });
  it("resets an existing script-owned branch when adding a fresh worktree", () => {
    const repoDir = createRepo();
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    execFileSync("git", ["branch", "temp/pr-43"], { cwd: repoDir });
    const { worktreeDir } = enterPrWorktree(repoDir, 43);
    expect(existsSync(worktreeDir)).toBe(true);
    expectWorktreeBranch(worktreeDir, "temp/pr-43");
  });
  it("materializes a new PR worktree inherited from a sparse checkout", () => {
    const repoDir = createRepo();
    addTrackedUiConfig(repoDir);
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    setSparseCheckout(repoDir);
    const { worktreeDir } = enterPrWorktree(repoDir, 44);
    expectMaterializedWorktree(worktreeDir);
  });
  it("materializes an existing sparse PR worktree before reuse", () => {
    const repoDir = createRepo();
    addTrackedUiConfig(repoDir);
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const worktreeDir = join(repoDir, ".worktrees", "pr-45");
    execFileSync("git", ["worktree", "add", "-q", "-b", "temp/pr-45", worktreeDir], {
      cwd: repoDir,
    });
    setSparseCheckout(worktreeDir);
    expect(existsSync(join(worktreeDir, "ui", "config", "control-ui-chunking.ts"))).toBe(false);
    enterPrWorktree(repoDir, 45);
    expectMaterializedWorktree(worktreeDir);
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
