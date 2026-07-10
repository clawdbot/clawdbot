import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNAL_GRACE_MS = 5000;
const KILL_DRAIN_MS = 5000;
const POLL_MS = 25;
const MAX_NOTIFICATION_LINE_BYTES = 4096;
const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];

const [repoRootArg, script, ...args] = process.argv.slice(2);
if (!repoRootArg || !script) {
  console.error("process-group-runner requires a repository root and script path");
  process.exit(2);
}
if (process.platform === "win32") {
  console.error("scripts/pr operation locking requires a POSIX process group (use WSL on Windows)");
  process.exit(1);
}

const repoRoot = resolve(repoRootArg);
const lockScript = fileURLToPath(new URL("./operation-lock.sh", import.meta.url));
const locks = new Map();
let notificationBuffer = "";
let discardingOversizedNotificationLine = false;
let notificationEnded = false;
/** @type {Error | undefined} */
let notificationFailure;
let receivedSignal;
let escalationTimer;
let killDeadline;
const operationGroup = { pid: undefined };
let operationGroupGone = false;
let hadLingeringGroup = false;

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function toError(value, fallbackMessage) {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function exitCodeForSignal(signal) {
  const signalNumber = constants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function processGroupStatus(pgid) {
  if (operationGroupGone) {
    return "dead";
  }
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid > 0x7fffffff) {
    return "indeterminate";
  }
  try {
    process.kill(-pgid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") {
      // Once absent, this operation group is gone forever. Never let later
      // PGID reuse redirect a delayed signal or liveness probe.
      operationGroupGone = true;
      return "dead";
    }
    return "indeterminate";
  }
}

function signalProcessGroup(signal) {
  const childPid = operationGroup.pid;
  if (!childPid || operationGroupGone) {
    return;
  }
  try {
    process.kill(-childPid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") {
      operationGroupGone = true;
    } else {
      notificationFailure ??= new Error(
        `Unable to signal scripts/pr process group with ${signal}: ${String(error)}`,
      );
    }
  }
}

function escalateSignal() {
  if (killDeadline) {
    return;
  }
  killDeadline = Date.now() + KILL_DRAIN_MS;
  signalProcessGroup("SIGKILL");
}

const signalHandlers = new Map();
for (const signal of FORWARDED_SIGNALS) {
  const handler = () => {
    if (receivedSignal) {
      escalateSignal();
      return;
    }
    receivedSignal = signal;
    signalProcessGroup(signal);
    escalationTimer = setTimeout(escalateSignal, SIGNAL_GRACE_MS);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

const child = spawn(script, args, {
  cwd: process.cwd(),
  detached: true,
  env: {
    ...process.env,
    OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1",
    OPENCLAW_PR_LOCK_NOTIFY_FD: "3",
    OPENCLAW_PR_LOCK_SUPERVISOR_PID: String(process.pid),
  },
  stdio: ["inherit", "inherit", "inherit", "pipe"],
});
operationGroup.pid = child.pid;
if (killDeadline) {
  signalProcessGroup("SIGKILL");
} else if (receivedSignal) {
  signalProcessGroup(receivedSignal);
}

function consumeNotificationLine(line) {
  const [lockRef, ownerOid, extra] = line.split("\t");
  if (
    extra !== undefined ||
    !/^refs\/openclaw\/pr-operation-locks\/[1-9][0-9]*$/u.test(lockRef ?? "") ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ownerOid ?? "")
  ) {
    notificationFailure ??= new Error("scripts/pr emitted malformed operation-lock metadata");
    return;
  }

  const owner = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", ownerOid], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ownerMatch =
    owner.status === 0
      ? /^version=3\nstate=active\npgid=([1-9][0-9]*)\nsupervisor_pid=([1-9][0-9]*)\nsupervisor_birth=[^\t\n]+\ntoken=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/u.exec(
          owner.stdout,
        )
      : undefined;
  const ownerPgid = ownerMatch ? Number(ownerMatch[1]) : undefined;
  const supervisorPid = ownerMatch ? Number(ownerMatch[2]) : undefined;
  if (
    ownerPgid === undefined ||
    supervisorPid === undefined ||
    !Number.isSafeInteger(ownerPgid) ||
    !Number.isSafeInteger(supervisorPid) ||
    ownerPgid <= 1 ||
    supervisorPid <= 1 ||
    ownerPgid > 0x7fffffff ||
    supervisorPid > 0x7fffffff ||
    ownerPgid !== child?.pid ||
    supervisorPid !== process.pid
  ) {
    notificationFailure ??= new Error(
      "scripts/pr emitted an operation lock owned by another process group",
    );
    return;
  }
  locks.set(`${lockRef}\0${ownerOid}`, { lockRef, ownerOid });
}

function finishNotifications() {
  if (notificationEnded) {
    return;
  }
  if (!discardingOversizedNotificationLine && notificationBuffer.length > 0) {
    consumeNotificationLine(notificationBuffer);
  }
  notificationBuffer = "";
  notificationEnded = true;
}

function consumeNotificationChunk(chunk) {
  notificationBuffer += chunk;
  while (true) {
    const newline = notificationBuffer.indexOf("\n");
    if (discardingOversizedNotificationLine) {
      if (newline === -1) {
        notificationBuffer = "";
        return;
      }
      notificationBuffer = notificationBuffer.slice(newline + 1);
      discardingOversizedNotificationLine = false;
      continue;
    }
    if (newline === -1) {
      if (Buffer.byteLength(notificationBuffer) > MAX_NOTIFICATION_LINE_BYTES) {
        notificationFailure ??= new Error("scripts/pr operation-lock metadata line is too large");
        notificationBuffer = "";
        discardingOversizedNotificationLine = true;
      }
      return;
    }

    const line = notificationBuffer.slice(0, newline);
    notificationBuffer = notificationBuffer.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_NOTIFICATION_LINE_BYTES) {
      notificationFailure ??= new Error("scripts/pr operation-lock metadata line is too large");
      continue;
    }
    consumeNotificationLine(line);
  }
}

const notificationStream = child.stdio[3];
notificationStream.setEncoding("utf8");
notificationStream.on("data", consumeNotificationChunk);
notificationStream.once("error", (error) => {
  notificationFailure ??= toError(error, "scripts/pr operation-lock notification stream failed");
});
notificationStream.once("end", finishNotifications);
notificationStream.once("close", finishNotifications);

const childResult = await new Promise((resolveResult) => {
  let settled = false;
  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveResult(result);
  };
  child.once("error", (error) => {
    notificationFailure ??= toError(error, "Unable to launch scripts/pr");
    settle({ code: 1, signal: null });
  });
  child.once("exit", (code, signal) => settle({ code, signal }));
});

const postExitGroupStatus = child.pid ? processGroupStatus(child.pid) : "dead";
if (postExitGroupStatus === "indeterminate") {
  notificationFailure ??= new Error("scripts/pr process-group state became indeterminate");
} else if (postExitGroupStatus === "live") {
  // A wrapper exit does not end same-group background work. Bound and drain
  // forgotten jobs, but keep the lock because their terminal state is unknown.
  hadLingeringGroup = true;
  notificationFailure ??= new Error("scripts/pr process group remained active after wrapper exit");
  signalProcessGroup("SIGTERM");
  escalationTimer ??= setTimeout(escalateSignal, SIGNAL_GRACE_MS);
} else if (!notificationEnded) {
  // A detached descendant may be the last writer. It cannot be signalled by
  // this group supervisor, so bound the wait and retain the lock on timeout.
  killDeadline ??= Date.now() + KILL_DRAIN_MS;
}

async function waitForOperationDrain() {
  while (true) {
    const groupStatus = child.pid ? processGroupStatus(child.pid) : "dead";
    if (groupStatus === "indeterminate") {
      throw new Error("scripts/pr process-group state became indeterminate");
    }
    if (groupStatus === "dead" && notificationEnded) {
      return;
    }
    if (killDeadline && Date.now() >= killDeadline) {
      throw new Error(
        `scripts/pr operation lifetime did not drain (group=${groupStatus}, pipe=${notificationEnded ? "closed" : "open"})`,
      );
    }
    await delay(POLL_MS);
  }
}

function releaseLock({ lockRef, ownerOid }) {
  const env = { ...process.env };
  delete env.OPENCLAW_PR_LOCK_NOTIFY_FD;
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        'SUPERVISOR_REPO_ROOT="$2"',
        "repo_root() { printf '%s\\n' \"$SUPERVISOR_REPO_ROOT\"; }",
        'PR_OPERATION_LOCK_REF="$3"',
        'PR_OPERATION_LOCK_OWNER_OID="$4"',
        "release_pr_operation_lock",
      ].join("\n"),
      "operation-lock-release",
      lockScript,
      repoRoot,
      lockRef,
      ownerOid,
    ],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `Unable to release the operation lock for ${lockRef.split("/").at(-1)}`,
    );
  }
}

function reportRetainedLock({ lockRef, ownerOid }) {
  const pr = lockRef.split("/").at(-1);
  console.error(
    `Retaining the operation lock for PR #${pr}; detached child tools cannot be ruled out.`,
  );
  console.error(`After verifying that no PR #${pr} tools remain, recover the exact owner with:`);
  console.error(`  scripts/pr lock-recover ${pr} ${ownerOid} --confirmed-no-running-tools`);
}

let drained = false;
try {
  await waitForOperationDrain();
  drained = true;
} catch (error) {
  notificationFailure ??= toError(error, "scripts/pr operation drain failed");
  // An out-of-group descendant can inherit the write end indefinitely. Once
  // the bounded drain fails, close our read end so that sentinel cannot keep
  // the controller alive; the exact lock remains sticky for manual recovery.
  finishNotifications();
  notificationStream.destroy();
}

if (escalationTimer) {
  clearTimeout(escalationTimer);
}
for (const [signal, handler] of signalHandlers) {
  process.off(signal, handler);
}

// PR commands must join all state-mutating children before returning. A clean
// exit is that trusted completion signal; abnormal exits retain the lock because
// an escaped child can outlive both the recorded group and notification pipe.
const completedCleanly =
  childResult.code === 0 &&
  !receivedSignal &&
  !childResult.signal &&
  !notificationFailure &&
  !hadLingeringGroup;
const retainedLocks = [];
if (drained && completedCleanly) {
  for (const lock of locks.values()) {
    try {
      releaseLock(lock);
    } catch (error) {
      notificationFailure ??= toError(error, "Unable to release a scripts/pr operation lock");
      retainedLocks.push(lock);
    }
  }
} else {
  retainedLocks.push(...locks.values());
}
for (const lock of retainedLocks) {
  reportRetainedLock(lock);
}

if (notificationFailure) {
  console.error(notificationFailure.message);
}

if (receivedSignal) {
  process.exitCode = exitCodeForSignal(receivedSignal);
} else if (childResult.code !== null) {
  process.exitCode = childResult.code;
} else {
  process.exitCode = childResult.signal ? exitCodeForSignal(childResult.signal) : 1;
}
if (notificationFailure && process.exitCode === 0) {
  process.exitCode = 1;
}
