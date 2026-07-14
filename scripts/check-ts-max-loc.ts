// Enforces a changed-file TypeScript size ratchet without a repository-wide baseline.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isProductionTypeScriptFile } from "./lib/ts-loc-policy.mjs";

export { isProductionTypeScriptFile } from "./lib/ts-loc-policy.mjs";

const DEFAULT_MAX_LINES = 500;
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

type ComparisonMode = "head" | "staged" | "worktree";

export type ParsedArgs = {
  base: string;
  head?: string;
  maxLines: number;
  paths: string[];
  staged: boolean;
};

export type GitDiffEntry = {
  path: string;
  previousPath?: string;
  status: string;
};

export type ChangedFileLoc = GitDiffEntry & {
  baseLines?: number;
  lines: number;
};

export type LocRatchetViolation = ChangedFileLoc & {
  reason: "crossed-limit" | "grew" | "new-file";
};

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let base = "origin/main";
  let baseWasExplicit = false;
  let head: string | undefined;
  let maxLines = DEFAULT_MAX_LINES;
  let staged = false;
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const paths = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1).map(normalizePath);

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--base") {
      base = readValue(optionArgs, index, "--base");
      baseWasExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--head") {
      head = readValue(optionArgs, index, "--head");
      index += 1;
      continue;
    }
    if (arg === "--max") {
      const value = readValue(optionArgs, index, "--max");
      if (!/^\d+$/u.test(value)) {
        throw new Error("--max requires a positive integer");
      }
      maxLines = Number(value);
      if (!Number.isSafeInteger(maxLines) || maxLines <= 0) {
        throw new Error("--max requires a positive integer");
      }
      index += 1;
      continue;
    }
    if (arg === "--staged") {
      staged = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (staged && (baseWasExplicit || head)) {
    throw new Error("--staged cannot be combined with --base or --head");
  }
  return { base, head, maxLines, paths: paths.filter(Boolean), staged };
}

export function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

export function countPhysicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const splitCount = content.split("\n").length;
  return content.endsWith("\n") ? splitCount - 1 : splitCount;
}

export function parseNameStatusZ(output: string): GitDiffEntry[] {
  const fields = output.split("\0");
  const entries: GitDiffEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const statusField = fields[index++];
    if (!statusField) {
      continue;
    }
    const status = statusField[0] ?? "";
    if (status === "R" || status === "C") {
      const previousPath = fields[index++];
      const filePath = fields[index++];
      if (!previousPath || !filePath) {
        throw new Error(`Malformed git name-status entry: ${statusField}`);
      }
      entries.push({
        path: normalizePath(filePath),
        previousPath: normalizePath(previousPath),
        status,
      });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) {
      throw new Error(`Malformed git name-status entry: ${statusField}`);
    }
    entries.push({ path: normalizePath(filePath), status });
  }
  return entries;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryRunGit(args: string[], cwd: string): string | undefined {
  try {
    return runGit(args, cwd).trim();
  } catch {
    return undefined;
  }
}

function resolveCommit(ref: string, cwd: string): string {
  const commit = tryRunGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  if (!commit) {
    throw new Error(`Invalid TypeScript LOC comparison ref: ${ref}`);
  }
  return commit;
}

export function resolveComparisonBase(params: { base: string; cwd: string; head: string }): string {
  const baseCommit = resolveCommit(params.base, params.cwd);
  const headCommit = resolveCommit(params.head, params.cwd);
  // Shallow CI checkouts may not contain ancestry between the exact event base and head.
  // The event base is still the correct merge target, so fall back to it when needed.
  return tryRunGit(["merge-base", baseCommit, headCommit], params.cwd) ?? baseCommit;
}

function listChangedEntries(params: {
  base: string;
  cwd: string;
  head?: string;
  mode: ComparisonMode;
}): GitDiffEntry[] {
  const args = ["diff", "--name-status", "-z", "--find-renames", "--find-copies"];
  if (params.mode === "staged") {
    args.push("--cached", params.base);
  } else if (params.mode === "head") {
    args.push(params.base, params.head ?? "HEAD");
  } else {
    args.push(params.base);
  }
  args.push("--");
  const entries = parseNameStatusZ(runGit(args, params.cwd));
  if (params.mode !== "worktree") {
    return entries;
  }

  const trackedEntryIndices = new Map(entries.map((entry, index) => [entry.path, index]));
  for (const filePath of runGit(["ls-files", "--others", "--exclude-standard", "-z"], params.cwd)
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)) {
    const trackedIndex = trackedEntryIndices.get(filePath);
    if (trackedIndex === undefined) {
      entries.push({ path: filePath, status: "A" });
    } else if (entries[trackedIndex]?.status === "D") {
      // A staged deletion can hide a recreated untracked file at the same path.
      // Treat the worktree content as a modification against the base blob.
      entries[trackedIndex] = { path: filePath, status: "M" };
    }
  }
  return entries;
}

function pathMatchesScope(filePath: string, scopes: string[]): boolean {
  return scopes.some((scope) => filePath === scope || filePath.startsWith(`${scope}/`));
}

function entryMatchesScopes(entry: GitDiffEntry, scopes: string[]): boolean {
  return (
    scopes.length === 0 ||
    pathMatchesScope(entry.path, scopes) ||
    (entry.previousPath !== undefined && pathMatchesScope(entry.previousPath, scopes))
  );
}

function readBlob(ref: string, filePath: string, cwd: string): string | undefined {
  try {
    return runGit(["show", `${ref}:${filePath}`], cwd);
  } catch {
    return undefined;
  }
}

async function readCurrentContent(params: {
  cwd: string;
  head?: string;
  mode: ComparisonMode;
  path: string;
}): Promise<string> {
  if (params.mode === "worktree") {
    return await readFile(resolve(params.cwd, params.path), "utf8");
  }
  return runGit(["show", `${params.head ?? "HEAD"}:${params.path}`], params.cwd);
}

function readIndexBlob(filePath: string, cwd: string): string {
  return runGit(["show", `:${filePath}`], cwd);
}

export async function collectChangedFileLocs(params: {
  base?: string;
  cwd?: string;
  head?: string;
  paths?: string[];
  staged?: boolean;
}): Promise<ChangedFileLoc[]> {
  const cwd = params.cwd ?? process.cwd();
  const mode: ComparisonMode = params.staged ? "staged" : params.head ? "head" : "worktree";
  const head = params.head ?? "HEAD";
  const requestedBase = params.base ?? "origin/main";
  const base = params.staged
    ? resolveCommit("HEAD", cwd)
    : mode === "head"
      ? resolveCommit(requestedBase, cwd)
      : resolveComparisonBase({ base: requestedBase, cwd, head });
  const scopes = (params.paths ?? []).map(normalizePath).filter(Boolean);
  const entries = listChangedEntries({ base, cwd, head, mode });
  const results: ChangedFileLoc[] = [];

  for (const entry of entries) {
    if (
      entry.status === "D" ||
      !entryMatchesScopes(entry, scopes) ||
      !isProductionTypeScriptFile(entry.path)
    ) {
      continue;
    }
    const currentContent =
      mode === "staged"
        ? readIndexBlob(entry.path, cwd)
        : await readCurrentContent({ cwd, head, mode, path: entry.path });

    let basePath: string | undefined;
    if (
      entry.status === "R" &&
      entry.previousPath &&
      isProductionTypeScriptFile(entry.previousPath)
    ) {
      basePath = entry.previousPath;
    } else if (entry.status !== "A" && entry.status !== "C") {
      basePath = entry.path;
    }
    const baseContent = basePath ? readBlob(base, basePath, cwd) : undefined;
    results.push({
      ...entry,
      ...(baseContent === undefined ? {} : { baseLines: countPhysicalLines(baseContent) }),
      lines: countPhysicalLines(currentContent),
    });
  }

  return results.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function findLocRatchetViolations(
  results: ChangedFileLoc[],
  maxLines = DEFAULT_MAX_LINES,
): LocRatchetViolation[] {
  const violations: LocRatchetViolation[] = [];
  for (const result of results) {
    if (result.lines <= maxLines) {
      continue;
    }
    if (result.baseLines === undefined) {
      violations.push({ ...result, reason: "new-file" });
    } else if (result.baseLines <= maxLines) {
      violations.push({ ...result, reason: "crossed-limit" });
    } else if (result.lines > result.baseLines) {
      violations.push({ ...result, reason: "grew" });
    }
  }
  return violations.toSorted(
    (left, right) => right.lines - left.lines || left.path.localeCompare(right.path),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const results = await collectChangedFileLocs(args);
  const violations = findLocRatchetViolations(results, args.maxLines);
  for (const violation of violations) {
    process.stderr.write(
      `${violation.lines}\t${violation.baseLines ?? "-"}\t${violation.reason}\t${violation.path}\n`,
    );
  }
  if (violations.length > 0) {
    process.stderr.write(
      `TypeScript LOC ratchet failed: new files must stay at or below ${args.maxLines} lines; oversized legacy files may not grow.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `TypeScript LOC ratchet: checked ${results.length} changed production files.\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
