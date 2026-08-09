// Builds the shared CLI/package artifacts once before parallel E2E workers
// start long-lived Gateway processes that import those artifacts lazily.
import { spawn } from "node:child_process";

// Cold CI runners can spend minutes rebuilding private QA artifacts. Streaming
// child output keeps the outer Vitest no-output watchdog from killing healthy builds.
export const E2E_SETUP_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const E2E_SETUP_COMMAND_KILL_GRACE_MS = 5_000;

export type E2ESetupCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  label?: string;
  spawnCommand?: typeof spawn;
  timeoutMs?: number;
};

export type E2ESetupCommandRunner = (
  args: string[],
  options?: E2ESetupCommandOptions,
) => Promise<void>;

export type SharedE2EArtifactSetupOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  runCommand?: E2ESetupCommandRunner;
};

type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

function formatSetupCommandExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `exit ${code}`;
  }
  if (signal !== null) {
    return `signal ${signal}`;
  }
  return "unknown exit";
}

export async function runE2ESetupCommand(
  args: string[],
  {
    cwd = process.cwd(),
    env = process.env,
    execPath = process.execPath,
    label = args.join(" "),
    spawnCommand = spawn,
    timeoutMs = E2E_SETUP_COMMAND_TIMEOUT_MS,
  }: E2ESetupCommandOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | null = null;
    const child = spawnCommand(execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, E2E_SETUP_COMMAND_KILL_GRACE_MS);
    }, timeoutMs);

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== null) {
        clearTimeout(forceKillTimeout);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.once("error", (error) => {
      settle(new Error(`${label} failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const outcome = formatSetupCommandExit(code, signal);
      const prefix = timedOut ? `${label} timed out after ${timeoutMs}ms` : `${label} failed`;
      settle(new Error(`${prefix} (${outcome})`));
    });
  });
}

export async function buildSharedE2EArtifacts({
  cwd = process.cwd(),
  env = process.env,
  execPath = process.execPath,
  runCommand = runE2ESetupCommand,
}: SharedE2EArtifactSetupOptions = {}): Promise<void> {
  await runCommand(["scripts/run-node.mjs", "--version"], {
    cwd,
    env: {
      ...env,
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
    },
    execPath,
    label: "build shared CLI/private QA artifacts",
  });
  await runCommand(["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"], {
    cwd,
    env,
    execPath,
    label: "build AI package artifacts",
  });
}

export function runE2eSetupCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: false,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, E2E_SETUP_COMMAND_KILL_GRACE_MS);
    }, E2E_SETUP_COMMAND_TIMEOUT_MS);

    const settle = (error: Error | undefined, status?: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout !== null) {
        clearTimeout(forceKillTimeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(status ?? 1);
    };

    child.once("error", (error) => {
      settle(new Error(`E2E setup command failed to start: ${error.message}`));
    });
    child.once("close", (status, signal) => {
      if (signal) {
        const prefix = timedOut
          ? `E2E setup command timed out after ${E2E_SETUP_COMMAND_TIMEOUT_MS}ms`
          : "E2E setup command terminated";
        settle(new Error(`${prefix} by ${signal}: ${args.join(" ")}`));
        return;
      }
      settle(undefined, status ?? 1);
    });
  });
}

export async function runE2eGlobalSetup(
  runCommand: SetupCommandRunner = runE2eSetupCommand,
): Promise<void> {
  const commands = [
    {
      args: ["scripts/run-node.mjs", "--version"],
      env: {
        ...process.env,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
    },
    {
      args: ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
      env: process.env,
    },
  ];
  for (const { args, env } of commands) {
    const status = await runCommand(args, env);
    if (status !== 0) {
      throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
    }
  }
}

export default async function setup() {
  await runE2eGlobalSetup();
}
