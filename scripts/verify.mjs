import { performance } from "node:perf_hooks";
import { formatMs, printTimingSummary } from "./lib/check-timing-summary.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

const stages = [
  { name: "check", args: ["check"] },
  { name: "test", args: ["test"] },
];

export function usage() {
  return [
    "Usage: node scripts/verify.mjs",
    "",
    "Runs the full verification graph: pnpm check, then pnpm test.",
    "",
    "Options:",
    "  -h, --help  Show this help.",
  ].join("\n");
}

export function parseVerifyArgs(argv) {
  const args = { help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

async function runStage(stage) {
  console.error(`CRABBOX_PHASE:${stage.name}`);
  console.error(`[verify] ${stage.name}`);
  const startedAt = performance.now();
  const status = await runManagedCommand({
    args: stage.args,
    bin: "pnpm",
  });
  return {
    durationMs: performance.now() - startedAt,
    name: stage.name,
    status,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseVerifyArgs(argv);
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

  const timings = [];
  for (const stage of stages) {
    const result = await runStage(stage);
    timings.push(result);
    if (result.status !== 0) {
      printTimingSummary("verify", timings);
      console.error(
        `[verify] failed during ${stage.name} after ${formatMs(result.durationMs)}; later stages were not run`,
      );
      process.exitCode = result.status;
      return;
    }
  }

  printTimingSummary("verify", timings);
  console.error("[verify] passed");
}

if (import.meta.main) {
  await main();
}
