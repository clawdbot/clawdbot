/**
 * `openclaw path` — shell-level access to the OcPath substrate verbs.
 * Self-hosters and editor extensions use it to inspect and surgically
 * edit workspace files without scripting against the SDK directly.
 *
 * Subcommands:
 *   - `resolve <oc-path>`     — print the match at the path
 *   - `set <oc-path> <value>` — write a leaf at the path; supports `--dry-run`
 *   - `find <pattern>`        — enumerate matches for a wildcard/predicate path
 *   - `validate <oc-path>`    — parse-only; print structure
 *   - `emit <file>`           — read + parseXxx + emitXxx; verifies byte-fidelity
 *
 * Output is TTY-aware: defaults to human-readable when stdout is a TTY,
 * switches to JSON otherwise (so pipes don't get formatting noise).
 * `--json` and `--human` flags override the auto-detection.
 *
 * Boundaries this CLI does NOT cross (v0):
 *   - Doesn't know about LKG. `set` writes raw bytes through the
 *     substrate emit; if the file is LKG-tracked, the next observe
 *     call decides whether to promote / recover.
 *   - Doesn't know about lint rules or doctor fixers — that's a
 *     different surface.
 */

import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
  type SetResult,
} from "../oc-path/index.js";
import type { OutputRuntimeEnv } from "../runtime.js";

export interface PathCommandOptions {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
}

type OutputMode = "human" | "json";

const SCRUB_PLACEHOLDER = "[REDACTED]";

/**
 * Output-boundary sentinel scrub. Replaces every occurrence of the
 * redaction sentinel with `[REDACTED]` before writing to the output
 * stream. Defense-in-depth — even if a future code path surfaces raw
 * file content carrying the sentinel, the CLI must not echo it.
 */
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
  // Plumb fileName through so OcEmitSentinelError messages carry the
  // file context (`oc://gateway.jsonc/[raw]`) instead of the
  // empty-slot fallback (`oc:///[raw]`). Test S-12 in the wave-21
  // sentinel suite asserts the OcPath context appears in the error;
  // without this plumbing, CLI emits had it stripped.
  const opts = fileName !== undefined ? { fileNameForGuard: fileName } : {};
  switch (ast.kind) {
    case "jsonc":
      return emitJsonc(ast, opts);
    case "jsonl":
      return emitJsonl(ast, opts);
    case "yaml":
      // Default round-trip mode preserves bytes verbatim for unmodified
      // ASTs (so `openclaw path emit foo.yaml` is a true byte-fidelity
      // diagnostic). After `setOcPath` mutates a YAML AST the substrate
      // re-renders into `ast.raw` already, so round-trip mode emits the
      // mutated bytes too — no need for the render-mode override.
      return emitYaml(ast, opts);
    case "md":
      return emitMd(ast, opts);
  }
  throw new Error(`unreachable: emitForKind kind`);
}

function resolveFsPath(path: OcPath, options: PathCommandOptions): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.file !== undefined) {
    return resolvePath(options.file);
  }
  return resolvePath(cwd, path.file);
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

export async function pathResolveCommand(
  pathStr: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (pathStr === undefined) {
    emitError(runtime, mode, "resolve: missing <oc-path> argument");
    runtime.exit(2);
    return;
  }
  let ocPath: OcPath;
  try {
    ocPath = parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(runtime, mode, `parse failed: ${err.message}`, err.code);
      runtime.exit(2);
      return;
    }
    throw err;
  }
  const fsPath = resolveFsPath(ocPath, options);
  const ast = await loadAst(fsPath, ocPath.file);
  let match;
  try {
    match = resolveOcPath(ast, ocPath);
  } catch (err) {
    if (err instanceof OcPathError) {
      // resolveOcPath now throws on wildcard patterns (the pattern
      // belongs in `find`, not `resolve`). Surface the structured code
      // so the CLI message points the caller at the right verb.
      emitError(runtime, mode, `resolve refused: ${err.message}`, err.code);
      runtime.exit(2);
      return;
    }
    throw err;
  }
  if (match === null) {
    emit(
      runtime,
      mode,
      { resolved: false, ocPath: pathStr },
      () => `not found: ${pathStr}`,
    );
    runtime.exit(1);
    return;
  }
  emit(
    runtime,
    mode,
    { resolved: true, ocPath: pathStr, match },
    () => formatMatchHuman(match),
  );
}

export async function pathSetCommand(
  pathStr: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (pathStr === undefined || value === undefined) {
    emitError(runtime, mode, "set: requires <oc-path> <value>");
    runtime.exit(2);
    return;
  }
  let ocPath: OcPath;
  try {
    ocPath = parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(runtime, mode, `parse failed: ${err.message}`, err.code);
      runtime.exit(2);
      return;
    }
    throw err;
  }
  const fsPath = resolveFsPath(ocPath, options);
  const ast = await loadAst(fsPath, ocPath.file);
  // `setOcPath` invokes the per-kind editor which calls back into
  // emit during rebuildRaw; the redaction-sentinel guard fires there
  // and throws `OcEmitSentinelError` for sentinel-bearing values.
  // Catch the throw here so it goes through the structured CLI error
  // path instead of escaping to commander's runCommandWithRuntime
  // (which would print raw String(err) and bypass --json scrubbing).
  let result: SetResult;
  try {
    result = setOcPath(ast, ocPath, value);
  } catch (err) {
    if (err instanceof OcEmitSentinelError) {
      emitError(
        runtime,
        mode,
        `set refused: ${err.message}`,
        "OC_EMIT_SENTINEL",
      );
      runtime.exit(1);
      return;
    }
    throw err;
  }
  if (!result.ok) {
    const detail = "detail" in result ? result.detail : undefined;
    emit(
      runtime,
      mode,
      { ok: false, reason: result.reason, detail },
      () =>
        `set failed: ${result.reason}${detail !== undefined ? ` — ${detail}` : ""}`,
    );
    runtime.exit(1);
    return;
  }
  // `setOcPath` accepted the value into the AST, but the per-kind
  // emit can still refuse to serialize it — most notably when the
  // value contains the redaction sentinel (defense-in-depth: the
  // substrate's emit guard fires there). The throw must NOT escape
  // to commander's runCommandWithRuntime, which would print
  // `String(err)` raw and bypass the CLI's JSON/human scrubbed-error
  // boundary. Catch and route through `emitError` like every other
  // refusal path.
  let newBytes: string;
  try {
    newBytes = emitForKind(result.ast, ocPath.file);
  } catch (err) {
    if (err instanceof OcEmitSentinelError) {
      emitError(
        runtime,
        mode,
        `emit refused: ${err.message}`,
        "OC_EMIT_SENTINEL",
      );
      runtime.exit(1);
      return;
    }
    throw err;
  }
  // Edit-then-emit through render mode drops jsonc comments and yaml
  // formatting. Self-hosters running `openclaw path set` on a
  // commented file should see the warning explicitly.
  const lossyKinds: ReadonlySet<OcAst["kind"]> = new Set(["jsonc", "yaml"]);
  const formatLossWarning = lossyKinds.has(result.ast.kind)
    ? `note: ${result.ast.kind} edit-then-emit drops comments / original formatting (render mode)`
    : null;
  if (options.dryRun === true) {
    emit(
      runtime,
      mode,
      {
        ok: true,
        dryRun: true,
        bytes: newBytes,
        ...(formatLossWarning !== null ? { warning: formatLossWarning } : {}),
      },
      () => {
        const lines = [`--dry-run: would write ${newBytes.length} bytes to ${fsPath}`];
        if (formatLossWarning !== null) {
          lines.push(formatLossWarning);
        }
        lines.push(newBytes);
        return lines.join("\n");
      },
    );
    return;
  }
  await fs.writeFile(fsPath, newBytes, "utf-8");
  emit(
    runtime,
    mode,
    {
      ok: true,
      dryRun: false,
      bytesWritten: newBytes.length,
      fsPath,
      ...(formatLossWarning !== null ? { warning: formatLossWarning } : {}),
    },
    () => {
      const lines = [`wrote ${newBytes.length} bytes to ${fsPath}`];
      if (formatLossWarning !== null) {
        lines.push(formatLossWarning);
      }
      return lines.join("\n");
    },
  );
}

export async function pathFindCommand(
  patternStr: string | undefined,
  options: PathCommandOptions,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const mode = detectMode(options);
  if (patternStr === undefined) {
    emitError(runtime, mode, "find: missing <pattern> argument");
    runtime.exit(2);
    return;
  }
  let pattern: OcPath;
  try {
    pattern = parseOcPath(patternStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(runtime, mode, `parse failed: ${err.message}`, err.code);
      runtime.exit(2);
      return;
    }
    throw err;
  }
  // The CLI resolves `pattern.file` to a single literal filesystem path.
  // Wildcards in the file slot (e.g. `oc://*.jsonc/...`) would silently
  // ENOENT during `fs.readFile`. The substrate's `findOcPaths` walks
  // *inside* an AST — multi-file globbing is out of scope for v0. Surface
  // a clear error so users don't get a confusing missing-file failure.
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
  const fsPath = resolveFsPath(pattern, options);
  const ast = await loadAst(fsPath, pattern.file);
  const matches = findOcPaths(ast, pattern);
  emit(
    runtime,
    mode,
    {
      pattern: patternStr,
      count: matches.length,
      matches: matches.map((m) => ({
        path: formatOcPath(m.path),
        match: m.match,
      })),
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
  if (pathStr === undefined) {
    emitError(runtime, mode, "validate: missing <oc-path> argument");
    runtime.exit(2);
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
    return;
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
  if (fileArg === undefined) {
    emitError(runtime, mode, "emit: missing <file> argument");
    runtime.exit(2);
    return;
  }
  // Resolve the file slot through the same `--cwd`/`--file` rules the
  // sibling subcommands use: `--file` (when set) is the absolute path
  // override; otherwise resolve `fileArg` against `--cwd` (defaulting
  // to `process.cwd()`). Without this, the flags are accepted by
  // commander but ignored by the handler — exactly the bug-shape
  // ClawSweeper flagged for the doc/option mismatch.
  const fsPath =
    options.file !== undefined
      ? resolvePath(options.file)
      : resolvePath(options.cwd ?? process.cwd(), fileArg);
  const fileName = fsPath.split(/[\\/]/).pop() ?? fileArg;
  const ast = await loadAst(fsPath, fileName);
  let bytes: string;
  try {
    bytes = emitForKind(ast, fileName);
  } catch (err) {
    if (err instanceof OcEmitSentinelError) {
      emitError(
        runtime,
        mode,
        `emit refused: ${err.message}`,
        "OC_EMIT_SENTINEL",
      );
      runtime.exit(1);
      return;
    }
    throw err;
  }
  if (mode === "json") {
    runtime.writeStdout(JSON.stringify({ ok: true, kind: ast.kind, bytes }));
    return;
  }
  runtime.writeStdout(bytes);
}
