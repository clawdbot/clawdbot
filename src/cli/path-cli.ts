import type { Command } from "commander";
import {
  pathEmitCommand,
  pathFindCommand,
  pathResolveCommand,
  pathSetCommand,
  pathValidateCommand,
  type PathCommandOptions,
} from "../commands/path.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

interface RawPathOptions {
  json?: boolean;
  human?: boolean;
  cwd?: string;
  file?: string;
  dryRun?: boolean;
}

function normalize(opts: RawPathOptions): PathCommandOptions {
  return {
    json: opts.json,
    human: opts.human,
    cwd: opts.cwd,
    file: opts.file,
    dryRun: opts.dryRun,
  };
}

export function registerPathCli(program: Command) {
  const path = program
    .command("path")
    .description("Inspect and edit workspace files via the oc:// addressing scheme")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/path", "docs.openclaw.ai/cli/path")}\n`,
    );

  path
    .command("resolve")
    .description("Print the match at an oc:// path")
    .argument("<oc-path>", "oc:// path to resolve")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .option("--cwd <dir>", "Resolve file slot against this directory")
    .option("--file <file>", "Override the file slot's resolved path (absolute access)")
    .action(async (pathStr: string, opts: RawPathOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await pathResolveCommand(pathStr, normalize(opts), defaultRuntime);
      });
    });

  path
    .command("find")
    .description("Enumerate matches for a wildcard / predicate oc:// pattern")
    .argument("<pattern>", "oc:// pattern (supports * and **)")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .option("--cwd <dir>", "Resolve file slot against this directory")
    .option("--file <file>", "Override the file slot's resolved path (absolute access)")
    .action(async (patternStr: string, opts: RawPathOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await pathFindCommand(patternStr, normalize(opts), defaultRuntime);
      });
    });

  path
    .command("set")
    .description("Write a leaf value at an oc:// path")
    .argument("<oc-path>", "oc:// path to write")
    .argument("<value>", "string value to write")
    .option("--dry-run", "Print bytes without writing")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .option("--cwd <dir>", "Resolve file slot against this directory")
    .option("--file <file>", "Override the file slot's resolved path (absolute access)")
    .action(async (pathStr: string, value: string, opts: RawPathOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await pathSetCommand(pathStr, value, normalize(opts), defaultRuntime);
      });
    });

  path
    .command("validate")
    .description("Parse an oc:// path and print its slot structure")
    .argument("<oc-path>", "oc:// path to validate")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .action((pathStr: string, opts: RawPathOptions) => {
      pathValidateCommand(pathStr, normalize(opts), defaultRuntime);
    });

  path
    .command("emit")
    .description("Round-trip a file through parseXxx + emitXxx (byte-fidelity diagnostic)")
    .argument("<file>", "Path to a workspace file (md / jsonc / jsonl / yaml)")
    .option("--cwd <dir>", "Resolve <file> against this directory (default: process.cwd())")
    .option("--file <file>", "Override the file's resolved path (absolute access)")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .action(async (fileArg: string, opts: RawPathOptions) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await pathEmitCommand(fileArg, normalize(opts), defaultRuntime);
      });
    });

  applyParentDefaultHelpAction(path);
}
