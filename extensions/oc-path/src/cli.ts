/**
 * `openclaw path` — shell access to the OcPath substrate verbs.
 *
 * Subcommands: `resolve` / `set` / `find` / `validate` / `emit`.
 * TTY-aware output: human when interactive, JSON when piped; `--json`
 * / `--human` override.
 */

import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import {
  OcEmitSentinelError,
  OcPathError,
  REDACTED_SENTINEL,
  emitJsonc,
  emitJsonl,
  emitMd,
  emitYaml,
  findOcPaths,
  formatOcPath,
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseOcPath,
  parseYaml,
  resolveOcPath,
  setOcPath,
  type OcAst,
  type OcMatch,
  type OcPath,
} from "./oc-path/index.js";

export type OutputRuntimeEnv = {
  writeStdout(value: string): void;
  error(value: string): void;
  exit(code: number): void;
};

export interface PathCommandOptions {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

type OutputMode = "human" | "json";

const SCRUB_PLACEHOLDER = "[REDACTED]";

const defaultRuntime: OutputRuntimeEnv = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
  },
  exit(code) {
    process.exitCode = code;
  },
};

// Defense-in-depth: replace the redaction sentinel with `[REDACTED]`
// before writing, even if upstream emits it.
export function scrubSentinel(s: string): string {
  if (!s.includes(REDACTED_SENTINEL)) {
    return s;
  }
  return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}

function detectMode(options: PathCommandOptions): OutputMode {
  if (options.json === true) {
    return "json";
  }
  if (options.human === true) {
    return "human";
  }
  return process.stdout.isTTY ? "human" : "json";
}

function emit(
  runtime: OutputRuntimeEnv,
  mode: OutputMode,
  value: unknown,
  humanFallback: () => string,
): void {
  if (mode === "json") {
    runtime.writeStdout(scrubSentinel(JSON.stringify(value, null, 2)));
    return;
  }
  runtime.writeStdout(scrubSentinel(humanFallback()));
}

function emitError(
  runtime: OutputRuntimeEnv,
  mode: OutputMode,
  message: string,
  code = "ERR",
): void {
  const scrubbed = scrubSentinel(message);
  if (mode === "json") {
    runtime.error(JSON.stringify({ error: { code, message: scrubbed } }));
    return;
  }
  runtime.error(`${code}: ${scrubbed}`);
}

/** Bail with usage error if a required arg is missing. */
function requireArg<T>(
  value: T | undefined,
  usage: string,
  runtime: OutputRuntimeEnv,
  mode: OutputMode,
): value is T extends undefined ? never : T {
  if (value === undefined) {
    emitError(runtime, mode, usage);
    runtime.exit(2);
    return false;
  }
  return true;
}

/** Parse an oc-path string; emit structured error and return null on failure. */
function tryParse(pathStr: string, runtime: OutputRuntimeEnv, mode: OutputMode): OcPath | null {
  try {
    return parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(runtime, mode, `parse failed: ${err.message}`, err.code);
      runtime.exit(2);
      return null;
    }
    throw err;
  }
}

// Catch OcEmitSentinelError so it goes through the structured error
// path; otherwise commander prints `String(err)` raw and bypasses the
// `--json` scrubbed-error boundary.
function catchSentinel<T>(
  label: string,
  runtime: OutputRuntimeEnv,
  mode: OutputMode,
  fn: () => T,
): T | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OcEmitSentinelError) {
      emitError(runtime, mode, `${label} refused: ${err.message}`, "OC_EMIT_SENTINEL");
      runtime.exit(1);
      return null;
    }
    throw err;
  }
}

async function loadAst(absPath: string, fileName: string): Promise<OcAst> {
  const raw = await fs.readFile(absPath, "utf-8");
  const kind = inferKind(fileName);
  if (kind === "jsonc") {
    return parseJsonc(raw).ast;
  }
  if (kind === "jsonl") {
    return parseJsonl(raw).ast;
  }
  if (kind === "yaml") {
    return parseYaml(raw).ast;
  }
  return parseMd(raw).ast;
}

function emitForKind(ast: OcAst, fileName?: string): string {
  // Plumb fileName so sentinel errors carry file context.
  const opts = fileName !== undefined ? { fileNameForGuard: fileName } : {};
  switch (ast.kind) {
    case "jsonc":
      return emitJsonc(ast, opts);
    case "jsonl":
      return emitJsonl(ast, opts);
    case "md":
      return emitMd(ast, opts);
    case "yaml":
      return emitYaml(ast, opts);
  }
  return "";
}

function resolveFsPath(path: OcPath, options: PathCommandOptions): string {
  if (options.file !== undefined) {
    return resolvePath(options.file);
  }
  return resolvePath(options.cwd ?? process.cwd(), path.file);
}

function formatMatchHuman(match: OcMatch): string {
  if (match.kind === "leaf") {
    return `leaf @ L${match.line}: ${JSON.stringify(match.valueText)} (${match.leafType})`;
  }
  if (match.kind === "node") {
    return `node @ L${match.line} [${match.descriptor}]`;
  }
  if (match.kind === "insertion-point") {
    return `insertion-point @ L${match.line} [${match.container}]`;
  }
  return `root @ L${match.line}`;
}

function splitDiffLines(s: string): readonly string[] {
  return s === "" ? [] : s.split("\n");
}

export function formatUnifiedDiff(oldBytes: string, newBytes: string, fsPath: string): string {
  if (oldBytes === newBytes) {
    return "";
  }
  const oldLines = splitDiffLines(oldBytes);
  const newLines = splitDiffLines(newBytes);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const context = 3;
  const hunkStart = Math.max(0, prefix - context);
  const hunkOldEnd = Math.min(oldLines.length - 1, oldSuffix + context);
  const hunkNewEnd = Math.min(newLines.length - 1, newSuffix + context);
  const oldCount = Math.max(0, hunkOldEnd - hunkStart + 1);
  const newCount = Math.max(0, hunkNewEnd - hunkStart + 1);
  const lines = [
    `--- ${fsPath}`,
    `+++ ${fsPath}`,
    `@@ -${hunkStart + 1},${oldCount} +${hunkStart + 1},${newCount} @@`,
  ];

  for (let i = hunkStart; i < prefix; i++) {
    lines.push(` ${oldLines[i] ?? ""}`);
  }
  for (let i = prefix; i <= oldSuffix; i++) {
    lines.push(`-${oldLines[i] ?? ""}`);
  }
  for (let i = prefix; i <= newSuffix; i++) {
    lines.push(`+${newLines[i] ?? ""}`);
  }
  for (let i = Math.max(oldSuffix + 1, prefix); i <= hunkOldEnd; i++) {
    lines.push(` ${oldLines[i] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------- Commands -----------------------------------------------------

export async function pathResolveCommand(
  pathStr: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (!requireArg(pathStr, "resolve: missing <oc-path> argument", runtime, mode)) {
    return;
  }
  const ocPath = tryParse(pathStr, runtime, mode);
  if (ocPath === null) {
    return;
  }
  const ast = await loadAst(resolveFsPath(ocPath, options), ocPath.file);
  let match: OcMatch | null;
  try {
    match = resolveOcPath(ast, ocPath);
  } catch (err) {
    if (err instanceof OcPathError) {
      // resolveOcPath throws on wildcard patterns — point at find.
      emitError(runtime, mode, `resolve refused: ${err.message}`, err.code);
      runtime.exit(2);
      return;
    }
    throw err;
  }
  if (match === null) {
    emit(runtime, mode, { resolved: false, ocPath: pathStr }, () => `not found: ${pathStr}`);
    runtime.exit(1);
    return;
  }
  emit(runtime, mode, { resolved: true, ocPath: pathStr, match }, () => formatMatchHuman(match));
}

export async function pathSetCommand(
  pathStr: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (!requireArg(pathStr, "set: requires <oc-path> <value>", runtime, mode)) {
    return;
  }
  if (!requireArg(value, "set: requires <oc-path> <value>", runtime, mode)) {
    return;
  }
  if (options.diff === true && options.dryRun !== true) {
    emit(
      runtime,
      mode,
      { ok: false, reason: "--diff requires --dry-run" },
      () => "set failed: --diff requires --dry-run",
    );
    runtime.exit(1);
    return;
  }
  const ocPath = tryParse(pathStr, runtime, mode);
  if (ocPath === null) {
    return;
  }
  const fsPath = resolveFsPath(ocPath, options);
  const oldBytes = await fs.readFile(fsPath, "utf-8");
  const ast = await loadAst(fsPath, ocPath.file);

  const result = catchSentinel("set", runtime, mode, () => setOcPath(ast, ocPath, value));
  if (result === null) {
    return;
  }
  if (!result.ok) {
    const detail = "detail" in result ? result.detail : undefined;
    emit(
      runtime,
      mode,
      { ok: false, reason: result.reason, detail },
      () => `set failed: ${result.reason}${detail !== undefined ? ` — ${detail}` : ""}`,
    );
    runtime.exit(1);
    return;
  }
  // Per-kind emit can still refuse the sentinel even after set succeeds.
  const newBytes = catchSentinel("emit", runtime, mode, () => emitForKind(result.ast, ocPath.file));
  if (newBytes === null) {
    return;
  }

  if (options.dryRun === true) {
    const diff = options.diff === true ? formatUnifiedDiff(oldBytes, newBytes, fsPath) : undefined;
    emit(
      runtime,
      mode,
      { ok: true, dryRun: true, bytes: newBytes, ...(diff !== undefined ? { diff } : {}) },
      () =>
        diff !== undefined
          ? diff || `--dry-run: no byte changes for ${fsPath}`
          : `--dry-run: would write ${newBytes.length} bytes to ${fsPath}\n${newBytes}`,
    );
    return;
  }
  await fs.writeFile(fsPath, newBytes, "utf-8");
  emit(
    runtime,
    mode,
    { ok: true, dryRun: false, bytesWritten: newBytes.length, fsPath },
    () => `wrote ${newBytes.length} bytes to ${fsPath}`,
  );
}

export async function pathFindCommand(
  patternStr: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (!requireArg(patternStr, "find: missing <pattern> argument", runtime, mode)) {
    return;
  }
  const pattern = tryParse(patternStr, runtime, mode);
  if (pattern === null) {
    return;
  }
  // File-slot wildcards would silently ENOENT during readFile; reject.
  if (/[*?]/.test(pattern.file)) {
    emitError(
      runtime,
      mode,
      `find: file-slot wildcards are not supported (got "${pattern.file}"). ` +
        `Pass a concrete file path; multi-file globbing is a follow-up feature.`,
      "OC_PATH_FILE_WILDCARD_UNSUPPORTED",
    );
    runtime.exit(2);
    return;
  }
  const ast = await loadAst(resolveFsPath(pattern, options), pattern.file);
  const matches = findOcPaths(ast, pattern);
  emit(
    runtime,
    mode,
    {
      pattern: patternStr,
      count: matches.length,
      matches: matches.map((m) => ({ path: formatOcPath(m.path), match: m.match })),
    },
    () => {
      if (matches.length === 0) {
        return `0 matches for ${patternStr}`;
      }
      const plural = matches.length === 1 ? "" : "es";
      const lines = [`${matches.length} match${plural} for ${patternStr}:`];
      for (const m of matches) {
        lines.push(`  ${formatOcPath(m.path)}  →  ${formatMatchHuman(m.match)}`);
      }
      return lines.join("\n");
    },
  );
  if (matches.length === 0) {
    runtime.exit(1);
  }
}

export function pathValidateCommand(
  pathStr: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): void {
  const mode = detectMode(options);
  if (!requireArg(pathStr, "validate: missing <oc-path> argument", runtime, mode)) {
    return;
  }
  try {
    const ocPath = parseOcPath(pathStr);
    emit(
      runtime,
      mode,
      {
        valid: true,
        ocPath: pathStr,
        formatted: formatOcPath(ocPath),
        structure: {
          file: ocPath.file,
          section: ocPath.section,
          item: ocPath.item,
          field: ocPath.field,
          session: ocPath.session,
        },
      },
      () => {
        const lines = [`valid: ${pathStr}`, `  file:    ${ocPath.file}`];
        if (ocPath.section !== undefined) {
          lines.push(`  section: ${ocPath.section}`);
        }
        if (ocPath.item !== undefined) {
          lines.push(`  item:    ${ocPath.item}`);
        }
        if (ocPath.field !== undefined) {
          lines.push(`  field:   ${ocPath.field}`);
        }
        if (ocPath.session !== undefined) {
          lines.push(`  session: ${ocPath.session}`);
        }
        return lines.join("\n");
      },
    );
  } catch (err) {
    if (err instanceof OcPathError) {
      emit(
        runtime,
        mode,
        { valid: false, code: err.code, message: err.message },
        () => `INVALID: ${err.code}: ${err.message}`,
      );
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

export async function pathEmitCommand(
  fileArg: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (!requireArg(fileArg, "emit: missing <file> argument", runtime, mode)) {
    return;
  }
  const fsPath =
    options.file !== undefined
      ? resolvePath(options.file)
      : resolvePath(options.cwd ?? process.cwd(), fileArg);
  const fileName = fsPath.split(/[\\/]/).pop() ?? fileArg;
  const ast = await loadAst(fsPath, fileName);
  const bytes = catchSentinel("emit", runtime, mode, () => emitForKind(ast, fileName));
  if (bytes === null) {
    return;
  }
  if (mode === "json") {
    runtime.writeStdout(scrubSentinel(JSON.stringify({ ok: true, kind: ast.kind, bytes })));
    return;
  }
  runtime.writeStdout(bytes);
}

// ---------- Commander wiring ---------------------------------------------

function withCommonOpts(cmd: Command): Command {
  return cmd
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .option("--cwd <dir>", "Resolve file slot against this directory")
    .option("--file <file>", "Override the file slot's resolved path");
}

export function registerPathCli(program: Command): void {
  const path = program
    .command("path")
    .description("Inspect and edit workspace files via the oc:// addressing scheme")
    .addHelpText("after", "\nDocs: https://docs.openclaw.ai/cli/path\n");

  withCommonOpts(
    path
      .command("resolve")
      .description("Print the match at an oc:// path")
      .argument("<oc-path>", "oc:// path to resolve"),
  ).action(async (pathStr: string, opts: PathCommandOptions) => {
    await pathResolveCommand(pathStr, opts, defaultRuntime);
  });

  withCommonOpts(
    path
      .command("find")
      .description("Enumerate matches for a wildcard / predicate oc:// pattern")
      .argument("<pattern>", "oc:// pattern"),
  ).action(async (patternStr: string, opts: PathCommandOptions) => {
    await pathFindCommand(patternStr, opts, defaultRuntime);
  });

  withCommonOpts(
    path
      .command("set")
      .description("Write a leaf value at an oc:// path")
      .argument("<oc-path>", "oc:// path to write")
      .argument("<value>", "string value to write")
      .option("--dry-run", "Print bytes without writing")
      .option("--diff", "With --dry-run, print a unified diff instead of full bytes"),
  ).action(async (pathStr: string, value: string, opts: PathCommandOptions) => {
    await pathSetCommand(pathStr, value, opts, defaultRuntime);
  });

  path
    .command("validate")
    .description("Parse an oc:// path and print its slot structure")
    .argument("<oc-path>", "oc:// path to validate")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .action((pathStr: string, opts: PathCommandOptions) => {
      pathValidateCommand(pathStr, opts, defaultRuntime);
    });

  withCommonOpts(
    path
      .command("emit")
      .description("Round-trip a file through parse + emit")
      .argument("<file>", "Path to a workspace file"),
  ).action(async (fileArg: string, opts: PathCommandOptions) => {
    await pathEmitCommand(fileArg, opts, defaultRuntime);
  });

  // Bare `openclaw path` prints help and exits 0 (matches the core
  // applyParentDefaultHelpAction contract — see openclaw#73077).
  path.action(() => {
    path.outputHelp();
    process.exitCode = 0;
  });
}
