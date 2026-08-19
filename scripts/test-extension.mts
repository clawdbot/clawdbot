#!/usr/bin/env node

// Runs the Vitest plan for one bundled plugin by id or path.
import { formatErrorMessage } from "./lib/error-format.mts";
import {
  createExtensionTestProcessTargetChunks,
  resolveExtensionTestPlan,
} from "./lib/extension-test-plan.mts";
import {
  relativizeExtensionVitestArgs,
  relativizeExtensionVitestPath,
} from "./lib/extension-vitest-paths.mts";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mts";

const ALLOW_NO_TESTS_FLAG = "--allow-no-tests";

function printUsage(): void {
  console.error(
    `Usage: pnpm test:extension <extension-name|path> [${ALLOW_NO_TESTS_FLAG}] [vitest args...]`,
  );
  console.error(
    `       node --import tsx scripts/test-extension.mts [extension-name|path] [${ALLOW_NO_TESTS_FLAG}] [vitest args...]`,
  );
}

function printNoTestsMessage(plan: { extensionDir: string }): void {
  console.error(`[test-extension] No tests found for ${plan.extensionDir}.`);
}

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const allowNoTests = rawArgs.includes(ALLOW_NO_TESTS_FLAG);
  const passthroughArgs = rawArgs.filter((arg) => arg !== "--" && arg !== ALLOW_NO_TESTS_FLAG);

  let targetArg: string | undefined;
  if (passthroughArgs[0] && !passthroughArgs[0].startsWith("-")) {
    targetArg = passthroughArgs.shift();
  }

  let plan;
  try {
    plan = resolveExtensionTestPlan({ cwd: process.cwd(), targetArg });
  } catch (error) {
    printUsage();
    console.error(formatErrorMessage(error));
    process.exit(1);
  }

  if (!plan.hasTests) {
    printNoTestsMessage(plan);
    if (!allowNoTests) {
      process.exit(1);
    }
    return;
  }

  console.log(`[test-extension] Running ${plan.testFileCount} test files for ${plan.extensionId}`);
  const targetChunks = createExtensionTestProcessTargetChunks(
    plan.config,
    plan.roots,
    passthroughArgs,
  );
  let finalExitCode = 0;
  for (const [index, targets] of targetChunks.entries()) {
    if (targetChunks.length > 1) {
      console.log(`[test-extension] Process chunk ${index + 1}/${targetChunks.length}`);
    }
    const exitCode = await runVitestBatch({
      args: relativizeExtensionVitestArgs(passthroughArgs),
      config: plan.config,
      env: process.env,
      targets: targets.map((target) => relativizeExtensionVitestPath(target)),
    });
    if (exitCode !== 0 && finalExitCode === 0) {
      finalExitCode = exitCode;
    }
  }
  if (finalExitCode !== 0) {
    process.exit(finalExitCode);
  }
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
