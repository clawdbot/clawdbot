/**
 * `openclaw path` — shell access to the OcPath substrate verbs.
 *
 * Subcommands: `resolve` / `set` / `find` / `validate` / `emit`.
 * TTY-aware output: human when interactive, JSON when piped; `--json`
 * / `--human` override.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import {
  MAX_JSONC_INPUT_BYTES,
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

type OutputRuntimeEnv = {
  writeStdout(value: string): void;
  error(value: string): void;
  exit(code: number): void;
};

interface PathCommandOptions {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly valueJson?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

type OutputMode = "human" | "json";

// Keep every parser behind the shipped JSONC ceiling so user-selected files
// cannot allocate an unbounded input before format-specific validation runs.
const MAX_OC_PATH_INPUT_BYTES = MAX_JSONC_INPUT_BYTES;

type LoadedOcPathFile = {
  readonly ast: OcAst;
  readonly raw: string;
};

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
function scrubSentinel(s: string): string {
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

async function loadOcPathFile(
  absPath: string,
  fileName: string,
  runtime: OutputRuntimeEnv,
  mode: OutputMode,
): Promise<LoadedOcPathFile | null> {
  const kind = inferKind(fileName);
  // A blocking open can hang on a FIFO before stat can reject it. O_NONBLOCK
  // preserves regular-file and symlink reads while making that check reachable.
  const handle = await fs.open(absPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      emitError(runtime, mode, `not a regular file: ${absPath}`, "OC_PATH_FILE_NOT_REGULAR");
      runtime.exit(2);
      return null;
    }
    // `end` is inclusive, so a raced growth can return at most the cap plus one byte.
    const bytes =
      stat.size > MAX_OC_PATH_INPUT_BYTES
        ? null
        : Buffer.concat(
            await handle
              .createReadStream({ autoClose: false, end: MAX_OC_PATH_INPUT_BYTES, start: 0 })
              .toArray(),
          );
    if (bytes === null || bytes.length > MAX_OC_PATH_INPUT_BYTES) {
      emitError(
        runtime,
        mode,
        `input exceeds ${MAX_OC_PATH_INPUT_BYTES} bytes${stat.size > MAX_OC_PATH_INPUT_BYTES ? `; got ${stat.size}` : ""}`,
        kind === "jsonc" ? "OC_JSONC_INPUT_TOO_LARGE" : "OC_PATH_INPUT_TOO_LARGE",
      );
      runtime.exit(2);
      return null;
    }
    raw = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  if (kind === "jsonc") {
    const result = parseJsonc(raw);
    const sizeDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "OC_JSONC_INPUT_TOO_LARGE",
    );
    if (sizeDiagnostic) {
      emitError(runtime, mode, sizeDiagnostic.message, sizeDiagnostic.code);
      runtime.exit(2);
      return null;
    }
    return { ast: result.ast, raw };
  }
  if (kind === "jsonl") {
    return { ast: parseJsonl(raw).ast, raw };
  }
  if (kind === "yaml") {
    return { ast: parseYaml(raw).ast, raw };
  }
  return { ast: parseMd(raw).ast, raw };
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

function formatUnifiedDiff(oldBytes: string, newBytes: string, fsPath: string): string {
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

async function pathResolveCommand(
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
  const loaded = await loadOcPathFile(resolveFsPath(ocPath, options), ocPath.file, runtime, mode);
  if (loaded === null) {
    return;
  }
  let match: OcMatch | null;
  try {
    match = resolveOcPath(loaded.ast, ocPath);
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

async function pathSetCommand(
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
  const loaded = await loadOcPathFile(fsPath, ocPath.file, runtime, mode);
  if (loaded === null) {
    return;
  }

  const result = catchSentinel("set", runtime, mode, () =>
    setOcPath(loaded.ast, ocPath, value, { valueJson: options.valueJson === true }),
  );
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

  const byteLength = Buffer.byteLength(newBytes, "utf8");

  if (options.dryRun === true) {
    const diff =
      options.diff === true ? formatUnifiedDiff(loaded.raw, newBytes, fsPath) : undefined;
    emit(
      runtime,
      mode,
      { ok: true, dryRun: true, bytes: newBytes, ...(diff !== undefined ? { diff } : {}) },
      () =>
        diff !== undefined
          ? diff || `--dry-run: no byte changes for ${fsPath}`
          : `--dry-run: would write ${byteLength} bytes to ${fsPath}\n${newBytes}`,
    );
    return;
  }
  await fs.writeFile(fsPath, newBytes, "utf-8");
  emit(
    runtime,
    mode,
    { ok: true, dryRun: false, bytesWritten: byteLength, fsPath },
    () => `wrote ${byteLength} bytes to ${fsPath}`,
  );
}

async function pathFindCommand(
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
  const loaded = await loadOcPathFile(resolveFsPath(pattern, options), pattern.file, runtime, mode);
  if (loaded === null) {
    return;
  }
  const matches = findOcPaths(loaded.ast, pattern);
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

function pathValidateCommand(
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

async function pathEmitCommand(
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
  const loaded = await loadOcPathFile(fsPath, fileName, runtime, mode);
  if (loaded === null) {
    return;
  }
  const bytes = catchSentinel("emit", runtime, mode, () => emitForKind(loaded.ast, fileName));
  if (bytes === null) {
    return;
  }
  if (mode === "json") {
    runtime.writeStdout(scrubSentinel(JSON.stringify({ ok: true, kind: loaded.ast.kind, bytes })));
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
      .option("--value-json", "Parse <value> as JSON for JSON/JSONC/JSONL leaf replacement")
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
