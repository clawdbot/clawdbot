// Cron scratch CLI: private per-job prompt context reads and compare-and-swap writes.
import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { handleCronCliError, printCronJson } from "./shared.js";
import { readCronScratchContent } from "./trigger-options.js";

type ScratchRecord = { content: string; revision: number; updatedAtMs: number };
type ScratchGetResult = {
  scratch: ScratchRecord | null;
  currentRevision: number;
  maxBytes: number;
};
type ScratchSetResult =
  | { ok: true; scratch: ScratchRecord | null; currentRevision: number; maxBytes: number }
  | { ok: false; reason: "revision-conflict"; currentRevision: number };

function parseExpectedRevision(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("--expected-revision must be a non-negative integer");
  }
  return revision;
}

export function registerCronScratchCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("scratch")
      .description("Read or replace a cron job's private scratch")
      .argument("<id>", "Job id")
      .option("--set <text>", "Replace scratch with exact text")
      .option("--file <path>", "Replace scratch from a file, or - for stdin")
      .option("--unset", "Remove the scratch row", false)
      .option("--expected-revision <n>", "Require the current scratch revision")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const mutations = [
            opts.set !== undefined,
            opts.file !== undefined,
            opts.unset === true,
          ].filter(Boolean).length;
          if (mutations > 1) {
            throw new Error("choose only one of --set, --file, or --unset");
          }
          const current = (await callGatewayFromCli("cron.scratch.get", opts, {
            id: String(id),
          })) as ScratchGetResult;
          if (mutations === 0) {
            if (opts.json) {
              printCronJson(current);
            } else if (current.scratch) {
              process.stdout.write(current.scratch.content);
            }
            return;
          }

          const explicitRevision = parseExpectedRevision(opts.expectedRevision);
          const expectedRevision = explicitRevision ?? current.currentRevision;
          const content = opts.unset
            ? null
            : opts.file !== undefined
              ? await readCronScratchContent(String(opts.file))
              : String(opts.set ?? "");
          const result = (await callGatewayFromCli("cron.scratch.set", opts, {
            id: String(id),
            content,
            expectedRevision,
          })) as ScratchSetResult;
          if (!result.ok) {
            throw new Error(
              `cron scratch changed concurrently (current revision ${result.currentRevision})`,
            );
          }
          printCronJson(result);
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
}
