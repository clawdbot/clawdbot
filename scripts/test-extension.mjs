#!/usr/bin/env node

import { formatErrorMessage } from "./lib/error-format.mjs";
import { resolveExtensionTestPlan } from "./lib/extension-test-plan.mjs";
import { isDirectScriptRun, runVitestBatch } from "./lib/vitest-batch-runner.mjs";

const ALLOW_NO_TESTS_FLAG = "--allow-no-tests";

function printUsage() {
  console.error(
    `Usage: pnpm test:extension <extension-name|path> [${ALLOW_NO_TESTS_FLAG}] [vitest args...]`,
  );
  console.error(
    `       node scripts/test-extension.mjs [extension-name|path] [${ALLOW_NO_TESTS_FLAG}] [vitest args...]`,
  );
}

function printNoTestsMessage(plan) {
  console.error(`[test-extension] No tests found for ${plan.extensionDir}.`);
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const allowNoTests = rawArgs.includes(ALLOW_NO_TESTS_FLAG);
  const passthroughArgs = rawArgs.filter((arg) => arg !== "--" && arg !== ALLOW_NO_TESTS_FLAG);

  let targetArg;
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
  const exitCode = await runVitestBatch({
    args: passthroughArgs,
    config: plan.config,
    env: process.env,
    targets: plan.roots,
  });
  process.exit(exitCode);
}

if (isDirectScriptRun(import.meta.url)) {
  await run();
}
