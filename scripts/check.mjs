// Runs the repository check lanes selected by CLI arguments.
import { performance } from "node:perf_hooks";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

/**
 * Returns command usage text for the aggregate check runner.
 */
export function usage() {
  return [
    "Usage: node scripts/check.mjs [--timed] [--include-architecture] [--include-test-types]",
    "",
    "Runs the local check graph: guard preflights, typecheck, lint, and policy guards.",
    "",
    "Options:",
    "  --timed                 Print timing summary even when checks pass.",
    "  --include-architecture  Run architecture import-cycle checks instead of runtime cycles.",
    "  --include-test-types    Typecheck production and test sources.",
    "  -h, --help              Show this help.",
  ].join("\n");
}

/**
 * Parses aggregate check runner arguments.
 */
function parseCheckArgs(argv) {
  const args = {
    help: false,
    includeArchitecture: false,
    includeTestTypes: false,
    timed: false,
  };
  for (const arg of argv) {
    if (arg === "--timed") {
      args.timed = true;
    } else if (arg === "--include-architecture") {
      args.includeArchitecture = true;
    } else if (arg === "--include-test-types") {
      args.includeTestTypes = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

/**
 * Runs selected repository check lanes.
 */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCheckArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const tailChecks = [
    { name: "webhook body guard", args: ["lint:webhook:no-low-level-body-read"] },
    { name: "runtime action config guard", args: ["check:no-runtime-action-load-config"] },
    !args.includeArchitecture
      ? {
          name: "deprecated API usage guard",
          args: ["check:deprecated-api-usage"],
        }
      : null,
    { name: "temp path guard", args: ["check:temp-path-guardrails"] },
    { name: "pairing store guard", args: ["lint:auth:no-pairing-store-group"] },
    { name: "pairing account guard", args: ["lint:auth:pairing-account-scope"] },
    args.includeArchitecture
      ? { name: "architecture import cycles", args: ["check:architecture"] }
      : { name: "runtime import cycles", args: ["check:import-cycles"] },
  ].filter(Boolean);

  const stages = [
    {
      name: "preflight guards",
      parallel: true,
      commands: [
        { name: "conflict markers", args: ["check:no-conflict-markers"] },
        { name: "changelog attributions", args: ["check:changelog-attributions"] },
        { name: "database-first legacy-store guard", args: ["check:database-first-legacy-stores"] },
        {
          name: "guarded extension wildcard re-exports",
          args: ["lint:extensions:no-guarded-wildcard-reexports"],
        },
        {
          name: "plugin-sdk wildcard re-exports",
          args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
        },
        {
          name: "deprecated channel access seams",
          args: ["lint:extensions:no-deprecated-channel-access"],
        },
        { name: "media download helper guard", args: ["check:media-download-helpers"] },
        { name: "runtime sidecar loader guard", args: ["check:runtime-sidecar-loaders"] },
        { name: "tool display", args: ["tool-display:check"] },
        { name: "host env policy", args: ["check:host-env-policy:swift"] },
        { name: "opengrep rule metadata", args: ["check:opengrep-rule-metadata"] },
        { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
        { name: "npm shrinkwrap guard", args: ["deps:shrinkwrap:check"] },
        { name: "package patch guard", args: ["deps:patches:check"] },
      ],
    },
    {
      name: "typecheck",
      parallel: false,
      commands: args.includeTestTypes
        ? [{ name: "typecheck all", args: ["tsgo:all"] }]
        : [
            { name: "typecheck prod", args: ["tsgo:prod"] },
            { name: "typecheck scripts", args: ["tsgo:scripts"] },
            { name: "typecheck test root", args: ["tsgo:test:root"] },
          ],
    },
    {
      name: "lint",
      parallel: false,
      commands: [
        { name: "lint", args: ["lint"] },
        { name: "format", args: ["format:check"] },
      ],
    },
    {
      name: "policy guards",
      parallel: true,
      commands: tailChecks,
    },
  ];

  const timings = [];
  let exitCode = 0;

  for (const stage of stages) {
    console.error(`\n[check] ${stage.name}`);
    const results = stage.parallel
      ? await Promise.all(stage.commands.map((command) => runCommand(command)))
      : await runSerial(stage.commands);

    timings.push(...results);
    const failed = results.find((result) => result.status !== 0);
    if (failed) {
      exitCode = failed.status;
      break;
    }
  }

  if (args.timed || exitCode !== 0) {
    printSummary(timings);
  }

  process.exitCode = exitCode;
}

async function runSerial(commands) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(command);
    results.push(result);
    if (result.status !== 0) {
      break;
    }
  }
  return results;
}

/**
 * Runs one managed check command and returns timing/status details.
 */
export async function runCommand(command, runManagedCommandImpl = runManagedCommand) {
  const startedAt = performance.now();
  let status = 1;
  try {
    status = await runManagedCommandImpl({
      args: command.args,
      bin: "pnpm",
    });
  } catch (error) {
    console.error(error);
  }
  return {
    name: command.name,
    durationMs: performance.now() - startedAt,
    status,
  };
}

function printSummary(timings) {
  printTimingSummary("check", timings);
}

if (import.meta.main) {
  await main();
}
