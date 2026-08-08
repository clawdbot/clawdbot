// Builds the shared CLI/package artifacts once before parallel E2E workers
// start long-lived Gateway processes that import those artifacts lazily.
import { spawn } from "node:child_process";

type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

async function runSetupCommand(
  runCommand: SetupCommandRunner,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await runCommand(args, env);

  if (status !== 0) {
    throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
  }
}

export function runE2eSetupCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: false,
    env,
    stdio: "inherit",
  });

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
  await runSetupCommand(runCommand, ["scripts/run-node.mjs", "--version"], {
    ...process.env,
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
  });
  await runSetupCommand(
    runCommand,
    ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
    process.env,
  );
}

export default async function setup() {
  await runE2eGlobalSetup();
}
