import { spawn } from "node:child_process";

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const USAGE = "Usage: node scripts/run-with-env.mjs KEY=value [KEY=value ...] -- command [args...]";

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

  const spawnCommand = resolveSpawnCommand(parsed.command, parsed.args);
  const child = spawn(spawnCommand.command, spawnCommand.args, {
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
  const forwardedSignals = ["SIGTERM", "SIGHUP"];

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
        child.kill(signal);
        forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
      },
    ]),
  );
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  child.on("exit", (code, signal) => {
    cleanupSignalHandlers();
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    if (forwardedSignal) {
      process.kill(process.pid, forwardedSignal);
      return;
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
