import { performance } from "node:perf_hooks";
import {
  detectChangedLanesForPaths,
  listChangedPathsFromGit,
  listStagedChangedPaths,
  normalizeChangedPath,
} from "./changed-lanes.mjs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { createSparseTsgoSkipEnv } from "./lib/tsgo-sparse-guard.mjs";

const LIVE_DOCKER_AUTH_SHELL_TARGETS = [
  "scripts/lib/live-docker-auth.sh",
  "scripts/test-live-acp-bind-docker.sh",
  "scripts/test-live-cli-backend-docker.sh",
  "scripts/test-live-codex-harness-docker.sh",
  "scripts/test-live-gateway-models-docker.sh",
  "scripts/test-live-models-docker.sh",
];

export function createChangedCheckChildEnv(baseEnv = process.env) {
  const resolvedBaseEnv = resolveLocalHeavyCheckEnv(baseEnv);
  return {
    ...resolvedBaseEnv,
    OPENCLAW_OXLINT_SKIP_LOCK: "1",
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
    OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
  };
}

function isTruthyEnvFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldDelegateChangedCheckToCrabbox(argv = [], env = process.env) {
  if (!isTruthyEnvFlag(env.OPENCLAW_TESTBOX)) {
    return false;
  }
  if (isTruthyEnvFlag(env.OPENCLAW_TESTBOX_REMOTE_RUN)) {
    return false;
  }
  if (isTruthyEnvFlag(env.CI) || isTruthyEnvFlag(env.GITHUB_ACTIONS)) {
    return false;
  }
  if (argv.includes("--dry-run")) {
    return false;
  }
  return true;
}

export function buildChangedCheckCrabboxArgs(argv = []) {
  return [
    "crabbox:run",
    "--",
    "--provider",
    "blacksmith-testbox",
    "--blacksmith-org",
    "openclaw",
    "--blacksmith-workflow",
    ".github/workflows/ci-check-testbox.yml",
    "--blacksmith-job",
    "check",
    "--blacksmith-ref",
    "main",
    "--idle-timeout",
    "90m",
    "--ttl",
    "240m",
    "--timing-json",
    "--",
    "CI=1",
    "NODE_OPTIONS=--max-old-space-size=4096",
    "OPENCLAW_TEST_PROJECTS_PARALLEL=6",
    "OPENCLAW_VITEST_MAX_WORKERS=1",
    "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000",
    "OPENCLAW_TESTBOX=1",
    "OPENCLAW_TESTBOX_REMOTE_RUN=1",
    "pnpm",
    "check:changed",
    ...argv,
  ];
}

export async function runChangedCheckViaCrabbox(argv = [], env = process.env) {
  console.error(
    "[check:changed] OPENCLAW_TESTBOX=1 set; delegating to Blacksmith Testbox via `pnpm crabbox:run`.",
  );
  return await runManagedCommand({
    bin: "pnpm",
    args: buildChangedCheckCrabboxArgs(argv),
    env,
  });
}

export function createChangedCheckPlan(result, options = {}) {
  const commands = [];
  const baseEnv = createChangedCheckChildEnv(options.env ?? process.env);
  const add = (name, args, env) => {
    if (!commands.some((command) => command.name === name && sameArgs(command.args, args))) {
      commands.push({ name, args, ...(env ? { env } : {}) });
    }
  };
  const addCommand = (name, bin, args, env) => {
    if (
      !commands.some(
        (command) => command.name === name && command.bin === bin && sameArgs(command.args, args),
      )
    ) {
      commands.push({ name, bin, args, ...(env ? { env } : {}) });
    }
  };
  const addTypecheck = (name, args) => add(name, args, createSparseTsgoSkipEnv(baseEnv));
  const addLint = (name, args) => add(name, args, baseEnv);

  add("conflict markers", ["check:no-conflict-markers"]);
  add("changelog attributions", ["check:changelog-attributions"]);
  add("guarded extension wildcard re-exports", ["lint:extensions:no-guarded-wildcard-reexports"]);
  add("plugin-sdk wildcard re-exports", ["lint:extensions:no-plugin-sdk-wildcard-reexports"]);
  add("duplicate scan target coverage", ["dup:check:coverage"]);
  add("dependency pin guard", ["deps:pins:check"]);

  if (result.docsOnly) {
    return {
      commands,
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
      summary: "release metadata",
    };
  }

  if (runAll) {
    add("runtime sidecar loader guard", ["check:runtime-sidecar-loaders"]);
    addTypecheck("typecheck all", ["tsgo:all"]);
    addLint("lint", ["lint"]);
    add("runtime import cycles", ["check:import-cycles"]);
    return {
      commands,
      summary: "all",
    };
  }

  if (lanes.core) {
    addTypecheck("typecheck core", ["tsgo:core"]);
  }
  if (lanes.coreTests) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
  }
  if (lanes.extensions) {
    addTypecheck("typecheck extensions", ["tsgo:extensions"]);
  }
  if (lanes.extensionTests) {
    addTypecheck("typecheck extension tests", ["tsgo:extensions:test"]);
  }

  if (lanes.core || lanes.coreTests) {
    addLint("lint core", ["lint:core"]);
  }
  if (
    lanes.liveDockerTooling &&
    result.paths.some((changedPath) => changedPath.startsWith("src/"))
  ) {
    addTypecheck("typecheck core tests", ["tsgo:core:test"]);
    addLint("lint core", ["lint:core"]);
  }
  if (lanes.extensions || lanes.extensionTests) {
    addLint("lint extensions", ["lint:extensions"]);
  }
  if (lanes.tooling || lanes.liveDockerTooling) {
    addLint("lint scripts", ["lint:scripts"]);
  }
  if (lanes.apps) {
    addLint("lint apps", ["lint:apps"]);
  }

  if (lanes.core || lanes.extensions) {
    add("runtime sidecar loader guard", ["check:runtime-sidecar-loaders"]);
    add("runtime import cycles", ["check:import-cycles"]);
  }
  if (lanes.core) {
    add("webhook body guard", ["lint:webhook:no-low-level-body-read"]);
    add("pairing store guard", ["lint:auth:no-pairing-store-group"]);
    add("pairing account guard", ["lint:auth:pairing-account-scope"]);
  }

  if (lanes.liveDockerTooling) {
    addCommand("live Docker shell syntax", "bash", ["-n", ...LIVE_DOCKER_AUTH_SHELL_TARGETS]);
    addCommand("live Docker scheduler dry run", "node", ["scripts/test-docker-all.mjs"], {
      ...baseEnv,
      OPENCLAW_DOCKER_ALL_DRY_RUN: "1",
      OPENCLAW_DOCKER_ALL_LIVE_MODE: "only",
    });
  }

  return {
    commands,
    summary: Object.entries(lanes)
      .filter(([, enabled]) => enabled)
      .map(([lane]) => lane)
      .join(", "),
  };
}

export async function runChangedCheck(result, options = {}) {
  const baseEnv = resolveLocalHeavyCheckEnv(options.env ?? process.env);
  const childEnv = createChangedCheckChildEnv(baseEnv);
  const plan = createChangedCheckPlan(result, { ...options, env: childEnv });
  const releaseLock = options.dryRun
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env: baseEnv,
        toolName: "check:changed",
      });

  try {
    printPlan(result, plan, options);

    if (options.dryRun) {
      return 0;
    }

    const timings = [];
    for (const command of plan.commands) {
      const status = await runPlanCommand(command, timings);
      if (status !== 0) {
        printSummary(timings, options);
        return status;
      }
    }

    printSummary(timings, options);
    return 0;
  } finally {
    releaseLock();
  }
}

function sameArgs(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function printPlan(result, plan, options) {
  const prefix = options.dryRun ? "[check:changed:dry-run]" : "[check:changed]";
  console.error(`${prefix} lanes=${plan.summary || "none"}`);
  if (result.extensionImpactFromCore) {
    console.error(`${prefix} extension-impacting surface; extension typecheck included`);
  }
  for (const reason of result.reasons) {
    console.error(`${prefix} ${reason}`);
  }
}

async function runPnpm(command, timings) {
  return await runCommand({ ...command, bin: "pnpm" }, timings);
}

async function runPlanCommand(command, timings) {
  if (command.bin) {
    return await runCommand(command, timings);
  }
  return await runPnpm(command, timings);
}

async function runCommand(command, timings) {
  const startedAt = performance.now();
  console.error(`\n[check:changed] ${command.name}`);
  let status = 1;
  try {
    status = await runManagedCommand({
      bin: command.bin,
      args: command.args,
      env: command.env ?? resolveLocalHeavyCheckEnv(),
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
        if (arg === "--") {
          return "handled";
        }
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
  const argv = process.argv.slice(2);
  if (shouldDelegateChangedCheckToCrabbox(argv, process.env)) {
    process.exitCode = await runChangedCheckViaCrabbox(argv, process.env);
  } else {
    const args = parseArgs(argv);
    const paths =
      args.paths.length > 0
        ? args.paths
        : args.staged
          ? listStagedChangedPaths()
          : listChangedPathsFromGit({ base: args.base, head: args.head });
    const result = detectChangedLanesForPaths({
      paths,
      base: args.base,
      head: args.head,
      staged: args.staged,
    });
    process.exitCode = await runChangedCheck(result, {
      ...args,
      explicitPaths: args.paths.length > 0,
    });
  }
}
