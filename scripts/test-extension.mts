#!/usr/bin/env node

// Runs the Vitest plan for one bundled plugin by id or path.
import { formatErrorMessage } from "./lib/error-format.mts";
import { mergeExtensionTestPlans, resolveExtensionTestPlan } from "./lib/extension-test-plan.mts";
import { isDirectScriptRun } from "./lib/vitest-batch-runner.mts";
import { runExtensionBatchPlan } from "./test-extension-batch.mts";

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
  const finalExitCode = await runExtensionBatchPlan(mergeExtensionTestPlans([plan]), {
    expandExactExcludes: false,
    vitestArgs: passthroughArgs,
  });
  if (finalExitCode !== 0) {
    process.exit(finalExitCode);
  }
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
