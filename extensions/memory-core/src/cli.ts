// Memory Core plugin module implements cli behavior.
import type { Command } from "commander";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  formatDocsLink,
  formatHelpExamples,
  theme,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import type {
  MemoryCommandOptions,
  MemoryForgetCommandOptions,
  MemoryPromoteCommandOptions,
  MemoryPromoteExplainOptions,
  MemoryRemBackfillOptions,
  MemoryRemHarnessOptions,
  MemorySearchCommandOptions,
  MemoryResetCommandOptions,
} from "./cli.types.js";
import { configureMemoryCoreDreamingState } from "./dreaming-state.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import type { MemorySessionBackfillOptions } from "./session-backfill.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
} from "./short-term-promotion.js";

const loadMemoryCliRuntime = createLazyRuntimeModule(() => import("./cli.runtime.js"));

const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DEFAULT_SESSION_BACKFILL_LIMIT_DAYS = 92;

async function runMemoryStatus(opts: MemoryCommandOptions, hostOptions?: MemoryCoreRuntimeHost) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryStatus(opts, hostOptions);
}

async function runMemoryIndex(opts: MemoryCommandOptions, hostOptions?: MemoryCoreRuntimeHost) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryIndex(opts, hostOptions);
}

async function runMemorySearch(
  queryArg: string | undefined,
  opts: MemorySearchCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemorySearch(queryArg, opts, hostOptions);
}

async function runMemoryForget(opts: MemoryForgetCommandOptions) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryForget(opts);
}

async function runMemoryPromote(
  opts: MemoryPromoteCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryPromote(opts, hostOptions);
}

async function runMemoryPromoteExplain(
  selectorArg: string | undefined,
  opts: MemoryPromoteExplainOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryPromoteExplain(selectorArg, opts, hostOptions);
}

async function runMemoryRemHarness(
  opts: MemoryRemHarnessOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryRemHarness(opts, hostOptions);
}

async function runMemoryRemBackfill(
  opts: MemoryRemBackfillOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemoryRemBackfill(opts, hostOptions);
}

async function runMemorySessionBackfill(
  opts: MemorySessionBackfillOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const runtime = await loadMemoryCliRuntime();
  await runtime.runMemorySessionBackfill(opts, hostOptions);
}

function invalidCliArgument(message: string): Error & { code: string; exitCode: number } {
  const error = new Error(message) as Error & { code: string; exitCode: number };
  error.name = "InvalidArgumentError";
  // Commander recognizes parser failures by code; keep the import type-only for bundled plugin deps.
  error.code = "commander.invalidArgument";
  error.exitCode = 1;
  return error;
}

function parseMemoryCliNumberOption(value: string, flag: string): number {
  const trimmed = value.trim();
  const parsed = DECIMAL_NUMBER_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw invalidCliArgument(`${flag} must be a finite number.`);
  }
  return parsed;
}

function parseMemoryCliPositiveIntegerOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidCliArgument(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseMemoryCliNonNegativeIntegerOption(value: string, flag: string): number {
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined) {
    throw invalidCliArgument(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function collectMemoryCliValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerMemoryCli(program: Command, hostOptions?: MemoryCoreRuntimeHost) {
  if (hostOptions?.openKeyedStore) {
    configureMemoryCoreDreamingState(hostOptions.openKeyedStore);
  }
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw memory status", "Show index and provider status."],
          [
            "openclaw memory status --fix",
            "Repair stale recall locks and normalize promotion metadata.",
          ],
          ["openclaw memory status --deep", "Probe embedding provider readiness."],
          ["openclaw memory index --force", "Force a full reindex."],
          ['openclaw memory search "meeting notes"', "Quick search using positional query."],
          [
            'openclaw memory search --query "deployment" --max-results 20',
            "Limit results for focused troubleshooting.",
          ],
          [
            "openclaw memory forget --hook-source gmail --dry-run",
            "Preview deletion of memories derived from matching sessions.",
          ],
          [
            `openclaw memory promote --limit 10 --min-score ${DEFAULT_PROMOTION_MIN_SCORE}`,
            "Review weighted short-term candidates for long-term memory.",
          ],
          [
            "openclaw memory promote --apply",
            "Append top-ranked short-term candidates into MEMORY.md.",
          ],
          [
            'openclaw memory promote-explain "router vlan"',
            "Explain why a specific candidate would or would not promote.",
          ],
          [
            "openclaw memory rem-harness --json",
            "Preview REM reflections, candidate truths, and deep promotion output.",
          ],
          [
            "openclaw memory rem-backfill --path ./memory",
            "Write grounded historical REM entries into DREAMS.md for UI review.",
          ],
          [
            "openclaw memory rem-backfill --path ./memory --stage-short-term",
            "Also seed durable grounded candidates into the live short-term promotion store.",
          ],
          [
            "openclaw memory session-backfill --agent main --from 2026-01-01",
            "Preview trusted candidates from retained session history.",
          ],
          ["openclaw memory status --json", "Output machine-readable JSON (good for scripts)."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--fix", "Repair stale recall locks and normalize promotion metadata")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts, hostOptions);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryIndex(opts, hostOptions);
    });

  memory
    .command("reset")
    .description("Clear the derived memory index and embedding cache without deleting sessions")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--yes", "Skip confirmation", false)
    .action(async (opts: MemoryResetCommandOptions) => {
      const runtime = await loadMemoryCliRuntime();
      await runtime.runMemoryReset(opts);
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) =>
      parseMemoryCliPositiveIntegerOption(value, "--max-results"),
    )
    .option("--min-score <n>", "Minimum score", (value: string) =>
      parseMemoryCliNumberOption(value, "--min-score"),
    )
    .option("--json", "Print JSON")
    .action(async (queryArg: string | undefined, opts: MemorySearchCommandOptions) => {
      await runMemorySearch(queryArg, opts, hostOptions);
    });

  memory
    .command("forget")
    .description("Delete memories and derived artifacts from selected sessions")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option(
      "--session <id-or-key>",
      "Source session ID or key (repeatable)",
      collectMemoryCliValues,
      [],
    )
    .option(
      "--hook-source <source>",
      "External-content hook source (repeatable)",
      collectMemoryCliValues,
      [],
    )
    .option(
      "--participant <actor-id>",
      "Session participant actor ID (repeatable)",
      collectMemoryCliValues,
      [],
    )
    .option("--since <date>", "Only include sessions observed on or after this date")
    .option("--dry-run", "Report everything that would be deleted without writing", false)
    .option("--json", "Print the complete machine-readable deletion report")
    .action(async (opts: MemoryForgetCommandOptions) => {
      await runMemoryForget(opts);
    });

  memory
    .command("promote")
    .description("Rank short-term recalls and optionally append top entries to MEMORY.md")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--limit <n>", "Max candidates", (value: string) =>
      parseMemoryCliPositiveIntegerOption(value, "--limit"),
    )
    .option(
      "--min-score <n>",
      `Minimum weighted score (default: ${DEFAULT_PROMOTION_MIN_SCORE})`,
      (value: string) => parseMemoryCliNumberOption(value, "--min-score"),
    )
    .option(
      "--min-recall-count <n>",
      `Minimum recall count (default: ${DEFAULT_PROMOTION_MIN_RECALL_COUNT})`,
      (value: string) => parseMemoryCliNonNegativeIntegerOption(value, "--min-recall-count"),
    )
    .option(
      "--min-unique-queries <n>",
      `Minimum distinct query count (default: ${DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES})`,
      (value: string) => parseMemoryCliNonNegativeIntegerOption(value, "--min-unique-queries"),
    )
    .option("--apply", "Append selected candidates to MEMORY.md", false)
    .option("--include-promoted", "Include already promoted candidates", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryPromoteCommandOptions) => {
      await runMemoryPromote(opts, hostOptions);
    });

  memory
    .command("promote-explain")
    .description("Explain a specific promotion candidate and its score breakdown")
    .argument("<selector>", "Candidate key, path fragment, or snippet fragment")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--include-promoted", "Include already promoted candidates", false)
    .option("--json", "Print JSON")
    .action(async (selectorArg: string | undefined, opts: MemoryPromoteExplainOptions) => {
      await runMemoryPromoteExplain(selectorArg, opts, hostOptions);
    });

  memory
    .command("rem-harness")
    .description("Preview REM reflections, candidate truths, and deep promotions without writing")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--path <file-or-dir>", "Seed the harness from historical daily memory file(s)")
    .option("--grounded", "Also render a grounded day-level REM preview")
    .option("--include-promoted", "Include already promoted deep candidates", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRemHarnessOptions) => {
      await runMemoryRemHarness(opts, hostOptions);
    });

  memory
    .command("rem-backfill")
    .description("Write grounded historical REM summaries into DREAMS.md for UI review")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--path <file-or-dir>", "Historical daily memory file(s) or directory")
    .option("--rollback", "Remove previously written grounded REM backfill entries", false)
    .option(
      "--stage-short-term",
      "Also seed grounded durable candidates into the short-term promotion store",
      false,
    )
    .option(
      "--rollback-short-term",
      "Remove previously seeded grounded short-term candidates",
      false,
    )
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRemBackfillOptions) => {
      await runMemoryRemBackfill(opts, hostOptions);
    });

  memory
    .command("session-backfill")
    .description("Distill retained session history into staged memory candidates")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--from <YYYY-MM-DD>", "Oldest transcript day to include")
    .option("--to <YYYY-MM-DD>", "Newest transcript day to include")
    .option(
      "--limit-days <n>",
      `Maximum unprocessed days (default: ${DEFAULT_SESSION_BACKFILL_LIMIT_DAYS})`,
      (value: string) => parseMemoryCliPositiveIntegerOption(value, "--limit-days"),
      DEFAULT_SESSION_BACKFILL_LIMIT_DAYS,
    )
    .option("--rem", "Write grounded per-day REM previews to DREAMS.md", false)
    .option("--apply", "Stage candidates and write DREAMS.md diary entries", false)
    .option(
      "--rollback",
      "Remove all grounded backfill candidates and shared backfill diary entries",
      false,
    )
    .option(
      "--archive-files <path...>",
      "Also inspect foreign transcript archive files conservatively",
    )
    .option("--json", "Print JSON")
    .action(async (opts: MemorySessionBackfillOptions) => {
      await runMemorySessionBackfill(opts, hostOptions);
    });

  memory.action(() => {
    memory.outputHelp();
    process.exitCode = 0;
  });
}
