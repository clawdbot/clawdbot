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
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Some focused suites bring their own fixtures, while exact-run artifact consumers already
  // have the complete built surface. In both cases rebuilding here would duplicate slow work.
  if (env.OPENCLAW_E2E_SKIP_BUILD === "1" || env.OPENCLAW_E2E_USE_PREBUILT_DIST === "1") {
    return;
  }
  const commands = [
    {
      args: ["scripts/run-node.mjs", "--version"],
      env: {
        ...env,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
    },
    {
      args: ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
      env,
    },
  ];
  for (const { args, env: commandEnv } of commands) {
    const status = await runCommand(args, commandEnv);
    if (status !== 0) {
      throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
    }
  }
}

export default async function setup() {
  await runE2eGlobalSetup();
}
