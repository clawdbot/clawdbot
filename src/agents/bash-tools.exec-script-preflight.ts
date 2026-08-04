/** Safely reads script files and rejects common shell-to-script bleed. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExecAsk, ExecHost, ExecSecurity } from "../infra/exec-approvals.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { shouldFailClosedInterpreterPreflight } from "./bash-tools.exec-script-ambiguity.js";
import { extractScriptTargetFromCommand } from "./bash-tools.exec-script-target.js";

const SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ELOOP",
  "EINVAL",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);
const SCRIPT_PREFLIGHT_MAX_BYTES = 512 * 1024;
const FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK = fsConstants as typeof fsConstants & {
  O_NONBLOCK?: number;
};
const SCRIPT_PREFLIGHT_OPEN_FLAGS =
  fsConstants.O_RDONLY | (FS_CONSTANTS_WITH_OPTIONAL_NONBLOCK.O_NONBLOCK ?? 0);

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String((error as { code?: unknown }).code);
}

type FsSafeModule = typeof import("../infra/fs-safe.js");

const fsSafeModuleLoader = createLazyImportLoader<FsSafeModule>(
  () => import("../infra/fs-safe.js"),
);

async function loadFsSafeModule(): Promise<FsSafeModule> {
  return await fsSafeModuleLoader.load();
}

function shouldSkipScriptPreflightPathError(
  error: unknown,
  FsSafeError: FsSafeModule["FsSafeError"],
): boolean {
  if (error instanceof FsSafeError) {
    return true;
  }
  const errorCode = getNodeErrorCode(error);
  return Boolean(errorCode && SKIPPABLE_SCRIPT_PREFLIGHT_FS_ERROR_CODES.has(errorCode));
}

function resolvePreflightRelativePath(params: { rootDir: string; absPath: string }): string | null {
  const root = path.resolve(params.rootDir);
  const candidate = path.resolve(params.absPath);
  const relative = path.relative(root, candidate);
  if (/^\.\.(?:[\\/]|$)/u.test(relative) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function hasLeadingTildePathSegment(relativePath: string): boolean {
  return /^~(?:$|[\\/])/u.test(relativePath);
}

async function readLiteralTildePreflightScript(params: {
  absPath: string;
  fsSafe: FsSafeModule;
  workspaceRoot: Awaited<ReturnType<FsSafeModule["root"]>>;
}): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(params.absPath, SCRIPT_PREFLIGHT_OPEN_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new params.fsSafe.FsSafeError("not-file", "not a file");
    }
    if (stat.size > SCRIPT_PREFLIGHT_MAX_BYTES) {
      throw new params.fsSafe.FsSafeError(
        "too-large",
        `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${stat.size})`,
      );
    }
    const realPath = await params.fsSafe.resolveOpenedFileRealPathForHandle(handle, params.absPath);
    if (!params.fsSafe.isPathInside(params.workspaceRoot.rootReal, realPath)) {
      throw new params.fsSafe.FsSafeError("outside-workspace", "file is outside workspace root");
    }
    const buffer = await handle.readFile();
    if (buffer.byteLength > SCRIPT_PREFLIGHT_MAX_BYTES) {
      throw new params.fsSafe.FsSafeError(
        "too-large",
        `file exceeds limit of ${SCRIPT_PREFLIGHT_MAX_BYTES} bytes (got ${buffer.byteLength})`,
      );
    }
    return buffer.toString("utf-8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    const {
      hasInterpreterInvocation,
      hasComplexSyntax,
      hasProcessSubstitution,
      hasInterpreterSegmentScriptHint,
      hasInterpreterPipelineScriptHint,
      isDirectInterpreterCommand,
    } = shouldFailClosedInterpreterPreflight(params.command);
    if (
      hasInterpreterInvocation &&
      hasComplexSyntax &&
      (hasInterpreterSegmentScriptHint ||
        hasInterpreterPipelineScriptHint ||
        (hasProcessSubstitution && isDirectInterpreterCommand))
    ) {
      // Fail closed when interpreter-driven script execution is ambiguous; otherwise
      // attackers can route script content through forms our fast parser cannot validate.
      throw new Error(
        "exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. " +
          "Use a direct `python <file>.py` or `node <file>.js` command.",
      );
    }
    return;
  }

  const fsSafe = await loadFsSafeModule();
  const { FsSafeError, root: fsRoot } = fsSafe;
  const workspaceRoot = await fsRoot(params.workdir);
  for (const relOrAbsPath of target.relOrAbsPaths) {
    const absPath = path.isAbsolute(relOrAbsPath)
      ? path.resolve(relOrAbsPath)
      : path.resolve(params.workdir, relOrAbsPath);
    const relativePath = resolvePreflightRelativePath({
      rootDir: params.workdir,
      absPath,
    });
    if (!relativePath) {
      continue;
    }

    // Best-effort: only validate files that safely resolve within workdir and
    // are reasonably small. This keeps preflight checks on a pinned file
    // identity instead of trusting mutable pathnames across multiple ops.
    // Use non-blocking open to avoid stalls if a path is swapped to a FIFO.
    let content: string;
    try {
      content = hasLeadingTildePathSegment(relativePath)
        ? await readLiteralTildePreflightScript({
            absPath,
            fsSafe,
            workspaceRoot,
          })
        : (
            await workspaceRoot.read(relativePath, {
              nonBlockingRead: true,
              symlinks: "follow-within-root",
              maxBytes: SCRIPT_PREFLIGHT_MAX_BYTES,
            })
          ).buffer.toString("utf-8");
    } catch (error) {
      if (shouldSkipScriptPreflightPathError(error, FsSafeError)) {
        // Preflight validation is best-effort: skip path/read failures and
        // continue to execute the command normally.
        continue;
      }
      throw error;
    }

    // Common failure mode: shell env var syntax leaking into Python/JS.
    // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
    const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
    const first = envVarRegex.exec(content);
    if (first) {
      const idx = first.index;
      const before = content.slice(0, idx);
      const line = before.split("\n").length;
      const token = first[0];
      throw new Error(
        [
          `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
            absPath,
          )}:${line}.`,
          target.kind === "python"
            ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
            : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
          "(If this is inside a string literal on purpose, escape it or restructure the code.)",
        ].join("\n"),
      );
    }

    // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
    if (target.kind === "node") {
      const firstNonEmpty = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
        throw new Error(
          `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
            `This looks like a shell command, not JavaScript.`,
        );
      }
    }
  }
}

export function shouldSkipExecScriptPreflight(params: {
  host: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
}): boolean {
  return params.host === "gateway" && params.security === "full" && params.ask === "off";
}
