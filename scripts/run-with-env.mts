// Runs a command with inline KEY=value assignments while preserving signal behavior.
import { spawn } from "node:child_process";
import { terminateManagedChild } from "./lib/managed-child-process.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const USAGE =
  "Usage: node --import tsx scripts/run-with-env.mts KEY=value [KEY=value ...] -- command [args...]";
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
type ForwardedSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

/**
 * Detects help requests before the command separator.
 */
export function isRunWithEnvHelpRequest(argv: readonly string[]) {
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
export function parseRunWithEnvArgs(argv: string[]) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex <= 0 || separatorIndex === argv.length - 1) {
    throw new Error(USAGE);
  }

  const assignments = argv.slice(0, separatorIndex);
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    if (!ENV_ASSIGNMENT_RE.test(assignment)) {
      throw new Error(`invalid environment assignment: ${assignment}`);
    }
    const equalsIndex = assignment.indexOf("=");
    env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
  }

  const [command, ...args] = argv.slice(separatorIndex + 1);
  if (command === undefined) {
    throw new Error(USAGE);
  }
  return { env, command, args };
}

/**
 * Resolves bare Node command names to the current executable so wrapper and child use the same
 * runtime. Windows command lookup is case-insensitive; explicit paths remain caller-owned.
 */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
) {
  const normalizedCommand = platform === "win32" ? command.toLowerCase() : command;
  const isNodeCommand =
    normalizedCommand === "node" || (platform === "win32" && normalizedCommand === "node.exe");
  if (isNodeCommand) {
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
export function resolveForceKillDelayMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS;
  const text = raw?.trim();
  if (!text) {
    return 5_000;
  }
  const parsed = parsePositiveInt(text, "OPENCLAW_RUN_WITH_ENV_FORCE_KILL_MS");
  return Math.min(parsed, MAX_TIMER_TIMEOUT_MS);
}

/**
 * Signals the wrapped command tree when this small parent wrapper is stopped.
 */
function main(argv: string[] = process.argv.slice(2)) {
  if (isRunWithEnvHelpRequest(argv)) {
    console.log(USAGE);
    return;
  }

  let parsed: ReturnType<typeof parseRunWithEnvArgs>;
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
  let forwardedSignal: ForwardedSignal | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  // Keep the child in the foreground process group so TTY signals such as
  // Ctrl-C, Ctrl-Z, and window resizes stay native. Forward direct wrapper
  // shutdown signals that would otherwise only kill this small parent process.
  const forwardedSignals: ForwardedSignal[] = useChildProcessGroup
    ? ["SIGTERM", "SIGHUP", "SIGINT"]
    : ["SIGTERM", "SIGHUP"];
  const signalChild = (signal: NodeJS.Signals) =>
    terminateManagedChild(child, signal, { useProcessGroup: useChildProcessGroup });
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
    const signal = forwardedSignal;
    if (!signal) {
      return;
    }
    const finish = () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      process.kill(process.pid, signal);
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
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };
  const signalHandlers = new Map<ForwardedSignal, () => void>(
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
