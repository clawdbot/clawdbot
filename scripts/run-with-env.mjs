// Runs a command with inline KEY=value assignments while preserving signal behavior.
import { spawn } from "node:child_process";

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const USAGE = "Usage: node scripts/run-with-env.mjs KEY=value [KEY=value ...] -- command [args...]";

/**
 * Detects help requests before the command separator.
 */
export function isRunWithEnvHelpRequest(argv) {
  for (const arg of argv) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--help" || arg === "-h") {
      return true;
    }
  }
  return false;
}

/**
 * Parses KEY=value assignments and the command following --.
 */
export function parseRunWithEnvArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex <= 0 || separatorIndex === argv.length - 1) {
    throw new Error(USAGE);
  }

  const assignments = argv.slice(0, separatorIndex);
  const env = {};
  for (const assignment of assignments) {
    if (!ENV_ASSIGNMENT_RE.test(assignment)) {
      throw new Error(`invalid environment assignment: ${assignment}`);
    }
    const equalsIndex = assignment.indexOf("=");
    env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
  }

  return {
    env,
    command: argv[separatorIndex + 1],
    args: argv.slice(separatorIndex + 2),
  };
}

/**
 * Resolves node to the current executable so wrapper and child use the same runtime.
 */
export function resolveSpawnCommand(command, args, execPath = process.execPath) {
  if (command === "node") {
    return {
      command: execPath,
      args,
    };
  }
  return {
    command,
    args,
  };
}

/**
 * Reads the signal-forwarding force-kill grace period.
 */
export function resolveForceKillDelayMs(env = process.env) {
  const raw = env.OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS;
  if (raw === undefined || raw === "") {
    return 5_000;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error("OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer");
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS must be a positive integer");
  }
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  if (isRunWithEnvHelpRequest(argv)) {
    console.log(USAGE);
    return;
  }

  let parsed;
  try {
    parsed = parseRunWithEnvArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  let forceKillDelayMs;
  try {
    forceKillDelayMs = resolveForceKillDelayMs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const spawnCommand = resolveSpawnCommand(parsed.command, parsed.args);
  const useChildProcessGroup = process.platform !== "win32" && !process.stdin.isTTY;
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    detached: useChildProcessGroup,
    env: {
      ...process.env,
      ...parsed.env,
    },
    stdio: "inherit",
  });
  let forwardedSignal = null;
  let forceKillTimer = null;
  // Keep the child in the foreground process group so TTY signals such as
  // Ctrl-C, Ctrl-Z, and window resizes stay native. Forward direct wrapper
  // shutdown signals that would otherwise only kill this small parent process.
  const forwardedSignals = useChildProcessGroup
    ? ["SIGTERM", "SIGHUP", "SIGINT"]
    : ["SIGTERM", "SIGHUP"];
  const signalChild = (signal) => {
    if (useChildProcessGroup && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH") {
          child.kill(signal);
          return;
        }
      }
    }
    child.kill(signal);
  };
  const childProcessGroupAlive = () => {
    if (!useChildProcessGroup || typeof child.pid !== "number") {
      return false;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exitWithForwardedSignal = () => {
    if (!forwardedSignal) {
      return;
    }
    const finish = () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      process.kill(process.pid, forwardedSignal);
    };
    if (!childProcessGroupAlive()) {
      finish();
      return;
    }
    const deadline = Date.now() + forceKillDelayMs;
    const drainTimer = setInterval(() => {
      if (!childProcessGroupAlive()) {
        clearInterval(drainTimer);
        finish();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(drainTimer);
        signalChild("SIGKILL");
        finish();
      }
    }, 50);
  };

  const cleanupSignalHandlers = () => {
    for (const signal of forwardedSignals) {
      process.off(signal, signalHandlers.get(signal));
    }
  };
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        forwardedSignal ??= signal;
        signalChild(signal);
        forceKillTimer ??= setTimeout(() => signalChild("SIGKILL"), forceKillDelayMs);
      },
    ]),
  );
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  child.on("exit", (code, signal) => {
    cleanupSignalHandlers();
    if (forwardedSignal) {
      exitWithForwardedSignal();
      return;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    cleanupSignalHandlers();
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
