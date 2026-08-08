// Builds the shared CLI/package artifacts once before parallel E2E workers
// start long-lived Gateway processes that import those artifacts lazily.
import { spawn } from "node:child_process";

type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

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
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (signal) {
        reject(new Error(`E2E setup command terminated by ${signal}: ${args.join(" ")}`));
        return;
      }
      resolve(status ?? 1);
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
