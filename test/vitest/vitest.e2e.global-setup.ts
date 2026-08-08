// Builds the shared CLI/package artifacts once before parallel E2E workers
// start long-lived Gateway processes that import those artifacts lazily.
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mjs";

type ManagedCommandRunner = typeof runManagedCommand;

async function runSetupCommand(
  runCommand: ManagedCommandRunner,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const status = await runCommand({
    bin: process.execPath,
    args,
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  if (status !== 0) {
    throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
  }
}

export async function runE2eGlobalSetup(
  runCommand: ManagedCommandRunner = runManagedCommand,
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
