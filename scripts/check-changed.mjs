import { performance } from "node:perf_hooks";
import {
  detectChangedLanes,
  listChangedPathsFromGit,
  listStagedChangedPaths,
  normalizeChangedPath,
} from "./changed-lanes.mjs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { isCiLikeEnv } from "./lib/vitest-local-scheduling.mjs";
import { resolveChangedTestTargetPlan } from "./test-projects.test-support.mjs";

export const CHANGED_CHECK_VITEST_NO_OUTPUT_TIMEOUT_MS = "600000";
const VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS";
const VITEST_NO_OUTPUT_RETRY_ENV_KEY = "OPENCLAW_VITEST_NO_OUTPUT_RETRY";

export function createChangedCheckVitestEnv(baseEnv = process.env) {
  const env = {
    ...baseEnv,
    [VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]:
      baseEnv[VITEST_NO_OUTPUT_TIMEOUT_ENV_KEY]?.trim() ||
      CHANGED_CHECK_VITEST_NO_OUTPUT_TIMEOUT_MS,
    [VITEST_NO_OUTPUT_RETRY_ENV_KEY]: baseEnv[VITEST_NO_OUTPUT_RETRY_ENV_KEY]?.trim() || "0",
  };

  const hasWorkerOverride = Boolean(
    (baseEnv.OPENCLAW_VITEST_MAX_WORKERS ?? baseEnv.OPENCLAW_TEST_WORKERS)?.trim(),
  );
  const hasParallelOverride = Boolean(baseEnv.OPENCLAW_TEST_PROJECTS_PARALLEL?.trim());
  const serialOverride = baseEnv.OPENCLAW_TEST_PROJECTS_SERIAL?.trim();
  if (
    !isCiLikeEnv(baseEnv) &&
    !hasWorkerOverride &&
    !hasParallelOverride &&
    serialOverride !== "0"
  ) {
    env.OPENCLAW_TEST_PROJECTS_SERIAL = serialOverride || "1";
    env.OPENCLAW_VITEST_MAX_WORKERS = "1";
  }

  return env;
}

export function createChangedCheckPlan(result, options = {}) {
  const commands = [];
  const add = (name, args) => {
    if (!commands.some((command) => command.name === name && sameArgs(command.args, args))) {
      commands.push({ name, args });
    }
  };

  add("conflict markers", ["check:no-conflict-markers"]);

  if (result.docsOnly) {
    return {
      commands,
      testTargets: [],
      runChangedTestsBroad: false,
      runFullTests: false,
      runExtensionTests: false,
      summary: "docs-only",
    };
  }

  const lanes = result.lanes;
  const runAll = lanes.all;

  if (lanes.releaseMetadata) {
    add("release metadata guard", [
      "release-metadata:check",
      "--",
      ...(options.staged
        ? ["--staged"]
        : ["--base", options.base ?? "origin/main", "--head", options.head ?? "HEAD"]),
    ]);
    add("iOS version sync", ["ios:version:check"]);
    add("config schema baseline", ["config:schema:check"]);
    add("config docs baseline", ["config:docs:check"]);
    add("root dependency ownership", ["deps:root-ownership:check"]);
    return {
      commands,
      testTargets: [],
      runChangedTestsBroad: false,
      runFullTests: false,
      runExtensionTests: false,
      summary: "release metadata",
    };
  }

  if (runAll) {
    add("typecheck all", ["tsgo:all"]);
    add("lint", ["lint"]);
    add("runtime import cycles", ["check:import-cycles"]);
    return {
      commands,
      testTargets: [],
      runChangedTestsBroad: false,
      runFullTests: true,
      runExtensionTests: false,
      summary: "all",
    };
  }

  if (lanes.core) {
    add("typecheck core", ["tsgo:core"]);
  }
  if (lanes.coreTests) {
    add("typecheck core tests", ["tsgo:core:test"]);
  }
  if (lanes.extensions) {
    add("typecheck extensions", ["tsgo:extensions"]);
  }
  if (lanes.extensionTests) {
    add("typecheck extension tests", ["tsgo:extensions:test"]);
  }

  if (lanes.core || lanes.coreTests) {
    add("lint core", ["lint:core"]);
  }
  if (lanes.extensions || lanes.extensionTests) {
    add("lint extensions", ["lint:extensions"]);
  }
  if (lanes.tooling) {
    add("lint scripts", ["lint:scripts"]);
  }
  if (lanes.apps) {
    add("lint apps", ["lint:apps"]);
  }

  if (lanes.core || lanes.extensions) {
    add("runtime import cycles", ["check:import-cycles"]);
  }
  if (lanes.core) {
    add("webhook body guard", ["lint:webhook:no-low-level-body-read"]);
    add("pairing store guard", ["lint:auth:no-pairing-store-group"]);
    add("pairing account guard", ["lint:auth:pairing-account-scope"]);
  }

  const testPlan = resolveChangedTestTargetPlan(result.paths);
  const runExtensionTests = result.extensionImpactFromCore;
  const testTargets = runExtensionTests
    ? testPlan.targets.filter((target) => target !== "extensions")
    : testPlan.targets;
  const runChangedTestsBroad = testPlan.mode === "broad";
  return {
    commands,
    testTargets,
    runChangedTestsBroad,
    runFullTests: false,
    runExtensionTests,
    summary: Object.entries(lanes)
      .filter(([, enabled]) => enabled)
      .map(([lane]) => lane)
      .join(", "),
  };
}

export async function runChangedCheck(result, options = {}) {
  const plan = createChangedCheckPlan(result, options);
  printPlan(result, plan, options);

  if (options.dryRun) {
    return 0;
  }

  const timings = [];
  for (const command of plan.commands) {
    const status = await runPnpm(command, timings);
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  }

  if (plan.runFullTests) {
    const status = await runPnpm(
      { name: "tests all", args: ["test"], env: createChangedCheckVitestEnv() },
      timings,
    );
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  } else if (plan.runChangedTestsBroad) {
    const testArgs = options.explicitPaths
      ? ["test"]
      : ["test", "--changed", options.base ?? "origin/main"];
    const status = await runPnpm(
      {
        name: options.explicitPaths ? "tests all" : "tests changed broad",
        args: testArgs,
        env: createChangedCheckVitestEnv(),
      },
      timings,
    );
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  } else if (plan.testTargets.length > 0) {
    const status = await runPnpm(
      {
        name: "tests changed",
        args: ["test", ...plan.testTargets],
        env: createChangedCheckVitestEnv(),
      },
      timings,
    );
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  }

  if (plan.runExtensionTests) {
    const status = await runPnpm(
      {
        name: "tests extensions",
        args: ["test:extensions"],
        env: createChangedCheckVitestEnv(),
      },
      timings,
    );
    if (status !== 0) {
      printSummary(timings, options);
      return status;
    }
  }

  printSummary(timings, options);
  return 0;
}

function sameArgs(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function printPlan(result, plan, options) {
  const prefix = options.dryRun ? "[check:changed:dry-run]" : "[check:changed]";
  console.error(`${prefix} lanes=${plan.summary || "none"}`);
  if (result.extensionImpactFromCore) {
    console.error(`${prefix} core contract changed; extension tests included`);
  }
  if (plan.runChangedTestsBroad) {
    console.error(`${prefix} broad changed tests included`);
  }
  for (const reason of result.reasons) {
    console.error(`${prefix} ${reason}`);
  }
  if (plan.testTargets.length > 0) {
    console.error(`${prefix} test targets=${plan.testTargets.length}`);
  }
}

async function runPnpm(command, timings) {
  return await runCommand({ ...command, bin: "pnpm" }, timings);
}

async function runCommand(command, timings) {
  const startedAt = performance.now();
  console.error(`\n[check:changed] ${command.name}`);
  let status = 1;
  try {
    status = await runManagedCommand({
      bin: command.bin,
      args: command.args,
      env: command.env,
    });
  } catch (error) {
    console.error(error);
  }

  timings.push({
    name: command.name,
    durationMs: performance.now() - startedAt,
    status,
  });
  return status;
}

function printSummary(timings, options) {
  printTimingSummary("check:changed", timings, { skipWhenAllOk: !options.timed });
}

function parseArgs(argv) {
  const args = {
    base: "origin/main",
    head: "HEAD",
    staged: false,
    dryRun: false,
    timed: false,
    paths: [],
  };
  return parseFlagArgs(
    argv,
    args,
    [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
      booleanFlag("--staged", "staged"),
      booleanFlag("--dry-run", "dryRun"),
      booleanFlag("--timed", "timed"),
    ],
    {
      onUnhandledArg(arg, target) {
        target.paths.push(normalizeChangedPath(arg));
        return "handled";
      },
    },
  );
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && import.meta.url.endsWith(direct));
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  const paths =
    args.paths.length > 0
      ? args.paths
      : args.staged
        ? listStagedChangedPaths()
        : listChangedPathsFromGit({ base: args.base, head: args.head });
  const result = detectChangedLanes(paths);
  process.exitCode = await runChangedCheck(result, {
    ...args,
    explicitPaths: args.paths.length > 0,
  });
}
