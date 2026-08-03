// Holds the shared local heavy-check lock for a whole scripts/pr gate block so
// concurrent gate runs across .worktrees serialize before their first command
// instead of dying mid-test on child lock timeouts or no-output watchdog kills.
import fs from "node:fs";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mjs";

// A queued gate block legitimately waits out another full gate run; the
// 10-minute per-command default in the lock runtime is far too short for that.
const DEFAULT_GATE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PARENT_WATCH_INTERVAL_MS = 500;

function parseArgs(argv) {
  const args = { statusFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--status-file") {
      args.statusFile = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (!args.statusFile) {
    throw new Error("Usage: node scripts/pr-gates-lock.mjs --status-file <path>");
  }
  return args;
}

function main() {
  const { statusFile } = parseArgs(process.argv.slice(2));
  const baseEnv = resolveLocalHeavyCheckEnv(process.env);
  const env = baseEnv.OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS
    ? baseEnv
    : { ...baseEnv, OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS: String(DEFAULT_GATE_LOCK_TIMEOUT_MS) };

  const parentPid = process.ppid;
  const release = acquireLocalHeavyCheckLockSync({
    cwd: process.cwd(),
    env,
    toolName: "pr-gates",
  });
  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };

  process.on("exit", releaseOnce);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      releaseOnce();
      process.exit(0);
    });
  }

  fs.writeFileSync(statusFile, "acquired\n");

  // The owner-pid reclaim in the lock runtime already covers a SIGKILLed
  // holder; this watch releases within half a second when the gate shell dies.
  // ppid 1 also counts as dead: orphans reparent to init/launchd, and a
  // helper that started orphaned has no gate block to hold the lock for.
  setInterval(() => {
    if (process.ppid !== parentPid || process.ppid === 1) {
      releaseOnce();
      process.exit(0);
    }
  }, PARENT_WATCH_INTERVAL_MS);
}

main();
