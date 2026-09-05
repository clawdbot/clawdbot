// Runs the broad verification graph used by Crabbox/Testbox: check then test.
import { performance } from "node:perf_hooks";
import { booleanFlag, parseFlagArgs } from "./lib/arg-utils.mts";
import { formatMs, printTimingSummary } from "./lib/check-timing-summary.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const stages = [
  { name: "check", args: ["check"] },
  { name: "test", args: ["test"] },
] as const;

/**
 * Renders CLI usage for the verification wrapper.
 */
function usage(): string {
  return [
    "Usage: node --import tsx scripts/verify.mts",
    "",
    "Runs the full verification graph: pnpm check, then pnpm test.",
    "",
    "Options:",
    "  -h, --help  Show this help.",
  ].join("\n");
}

/**
 * Parses verify wrapper CLI args.
 */
function parseVerifyArgs(argv: string[]): { help: boolean } {
  return parseFlagArgs(
    argv,
    { help: false },
    [
      booleanFlag("--help", "help", true, { repeatable: true }),
      booleanFlag("-h", "help", true, { repeatable: true }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
      },
    },
  );
}

async function runStage(stage: (typeof stages)[number]) {
  console.error(`CRABBOX_PHASE:${stage.name}`);
  console.error(`[verify] ${stage.name}`);
  const startedAt = performance.now();
  const status = await runManagedCommand({
    args: [...stage.args],
    bin: "pnpm",
  });
  return {
    durationMs: performance.now() - startedAt,
    name: stage.name,
    status,
  };
}

/**
 * Runs verification stages in order and stops at the first failure.
 */
async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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

  const timings: Array<Awaited<ReturnType<typeof runStage>>> = [];
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
