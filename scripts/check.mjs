import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { printTimingSummary } from "./lib/check-timing-summary.mjs";

export async function main(argv = process.argv.slice(2)) {
  const timed = argv.includes("--timed");
  const includeArchitecture = argv.includes("--include-architecture");
  const includeTestTypes = argv.includes("--include-test-types");

  const tailChecks = [
    { name: "webhook body guard", args: ["lint:webhook:no-low-level-body-read"] },
    { name: "runtime action config guard", args: ["check:no-runtime-action-load-config"] },
    { name: "temp path guard", args: ["check:temp-path-guardrails"] },
    { name: "pairing store guard", args: ["lint:auth:no-pairing-store-group"] },
    { name: "pairing account guard", args: ["lint:auth:pairing-account-scope"] },
    includeArchitecture
      ? { name: "architecture import cycles", args: ["check:architecture"] }
      : { name: "runtime import cycles", args: ["check:import-cycles"] },
  ];

  const stages = [
    {
      name: "preflight guards",
      parallel: true,
      commands: [
        { name: "conflict markers", args: ["check:no-conflict-markers"] },
        { name: "tool display", args: ["tool-display:check"] },
        { name: "host env policy", args: ["check:host-env-policy:swift"] },
      ],
    },
    {
      name: "typecheck",
      parallel: false,
      commands: [
        {
          name: includeTestTypes ? "typecheck all" : "typecheck prod",
          args: [includeTestTypes ? "tsgo:all" : "tsgo:prod"],
        },
      ],
    },
    {
      name: "lint",
      parallel: false,
      commands: [{ name: "lint", args: ["lint"] }],
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

  if (timed || exitCode !== 0) {
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

async function runCommand(command) {
  const startedAt = performance.now();
  const child = spawn("pnpm", command.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve({
        name: command.name,
        durationMs: performance.now() - startedAt,
        status: 1,
      });
    });
    child.once("close", (status) => {
      resolve({
        name: command.name,
        durationMs: performance.now() - startedAt,
        status: status ?? 1,
      });
    });
  });
}

function printSummary(timings) {
  printTimingSummary("check", timings);
}

if (import.meta.main) {
  await main();
}
