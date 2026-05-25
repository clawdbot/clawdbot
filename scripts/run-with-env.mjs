import { spawn } from "node:child_process";

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

export function parseRunWithEnvArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex <= 0 || separatorIndex === argv.length - 1) {
    throw new Error("usage: node scripts/run-with-env.mjs KEY=value [KEY=value ...] -- command [args...]");
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
  let parsed;
  try {
    parsed = parseRunWithEnvArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const spawnCommand = resolveSpawnCommand(parsed.command, parsed.args);
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    env: {
      ...process.env,
      ...parsed.env,
    },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}

if (import.meta.main) {
  main();
}
