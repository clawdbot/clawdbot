// Memory Wiki helper registers bounded machine-oriented batch commands.
import type { Command } from "commander";
import { runMemoryWikiApplyBatch, runMemoryWikiSearchBatch } from "./batch.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";

type WikiApplyBatchCommandOptions = {
  json?: boolean;
  dryRun?: boolean;
  input: string;
};

type WikiSearchBatchCommandOptions = {
  json?: boolean;
  input: string;
};

function writeOutput(output: string) {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function registerMemoryWikiBatchCli(
  wiki: Command,
  resolveConfig: () => ResolvedMemoryWikiConfig,
) {
  wiki
    .command("apply-batch")
    .description("Apply bounded native wiki operations with at most one compile")
    .requiredOption("--input <path>", "Version 1 batch JSON file")
    .option("--dry-run", "Validate and report changes without writing")
    .option("--json", "Print JSON")
    .action(async (opts: WikiApplyBatchCommandOptions) => {
      const result = await runMemoryWikiApplyBatch({
        config: resolveConfig(),
        inputPath: opts.input,
        dryRun: opts.dryRun,
      });
      writeOutput(
        opts.json
          ? JSON.stringify(result, null, 2)
          : `${result.dryRun ? "Planned" : "Applied"} ${result.operationCount} wiki operation${result.operationCount === 1 ? "" : "s"}; changed=${result.changed}; duration=${result.durationMs}ms.`,
      );
    });

  wiki
    .command("search-batch")
    .description("Verify bounded wiki-only queries from one prepared search snapshot")
    .requiredOption("--input <path>", "Version 1 batch JSON file")
    .option("--json", "Print JSON")
    .action(async (opts: WikiSearchBatchCommandOptions) => {
      const result = await runMemoryWikiSearchBatch({
        config: resolveConfig(),
        inputPath: opts.input,
      });
      writeOutput(
        opts.json
          ? JSON.stringify(result, null, 2)
          : `Verified ${result.queryCount} wiki quer${result.queryCount === 1 ? "y" : "ies"} in ${result.durationMs}ms.`,
      );
    });
}
