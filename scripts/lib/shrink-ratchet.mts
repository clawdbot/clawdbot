import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Owns file-backed baseline loading, comparison, and deterministic failure/shrink guidance.
// The chained-assertion ledger stays in type-assertion-guard-scope.mjs: it is live scope policy
// loaded by plain-JS oxlint, not a baseline, and folding it here would couple oxlint to git/fs.

export type RatchetCountDelta = { allowed: number; current: number; entry: string };

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const compareEntries = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function readGitText(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolvesCommit(root: string, ref: string) {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRatchetBase(root: string, options: { base?: string; staged: boolean }) {
  const resolved =
    options.base ??
    (options.staged ? ["HEAD"] : ["origin/main", "HEAD"]).find((ref) => resolvesCommit(root, ref));
  if (!resolved || options.staged) {
    return resolved ?? null;
  }

  // Branches own their grandfathered debt from the fork. Comparing against a
  // moving base tip turns unrelated cleanup there into a local expansion.
  try {
    return readGitText(root, ["merge-base", "HEAD", resolved]).trim();
  } catch {
    return resolved;
  }
}

export function loadRatchetSnapshot<T>(
  root: string,
  baselinePath: string,
  staged: boolean,
  parse: (source: string) => T,
) {
  const source = staged
    ? readGitText(root, ["show", ":" + baselinePath])
    : fs.readFileSync(path.join(root, baselinePath), "utf8");
  return parse(source);
}

export function loadRatchetReference<T>(
  root: string,
  ref: string,
  baselinePath: string,
  parse: (source: string) => T,
) {
  const entry = readGitText(root, ["ls-tree", "--name-only", ref, "--", baselinePath]).trim();
  return entry === baselinePath
    ? parse(readGitText(root, ["show", ref + ":" + baselinePath]))
    : null;
}

export function loadRatchetSources(root: string, filePaths: string[]) {
  if (filePaths.length === 0) {
    return new Map<string, string>();
  }
  const output = execFileSync("git", ["cat-file", "--batch", "-z"], {
    cwd: root,
    input: filePaths.map((filePath) => ":" + filePath).join("\0") + "\0",
    maxBuffer: GIT_MAX_BUFFER,
  });
  const sources = new Map<string, string>();
  let offset = 0;
  // `-z` frames requests only; each response still has a newline header and payload terminator.
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) {
      throw new Error("Invalid git cat-file response for " + filePath);
    }
    const size = Number(output.subarray(offset, headerEnd).toString("utf8").split(" ")[2]);
    if (!Number.isSafeInteger(size)) {
      throw new Error("Could not read staged source " + filePath);
    }
    const sourceStart = headerEnd + 1;
    const sourceEnd = sourceStart + size;
    if (output[sourceEnd] !== 10) {
      throw new Error("Invalid git cat-file framing for " + filePath);
    }
    sources.set(filePath, output.subarray(sourceStart, sourceEnd).toString("utf8"));
    offset = sourceEnd + 1;
  }
  return sources;
}

export function listRatchetRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  sourceRoots: string[],
) {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (staged) {
    args.push("--cached");
  }
  args.push(baseRef, "--", ...sourceRoots);
  const fields = execFileSync("git", args, { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString("utf8")
    .split("\0");
  const renames: { from: string; to: string }[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      break;
    }
    const from = fields[index++];
    if (!status.startsWith("R") && !status.startsWith("C")) {
      continue;
    }
    const to = fields[index++];
    if (status.startsWith("R") && from && to) {
      renames.push({ from, to });
    }
  }
  return renames;
}

export function parseRatchetPaths(source: string) {
  return new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export function parseRatchetCounts(source: string, baselinePath: string) {
  const counts = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine === "" || rawLine.startsWith("#")) {
      continue;
    }
    const separator = rawLine.lastIndexOf("\t");
    const entry = rawLine.slice(0, separator);
    const count = Number(rawLine.slice(separator + 1));
    if (separator <= 0 || !Number.isSafeInteger(count) || count <= 0 || counts.has(entry)) {
      throw new Error(`Invalid ${baselinePath} entry: ${rawLine}`);
    }
    counts.set(entry, count);
  }
  return counts;
}

export function parseRatchetScalar(source: string, baselinePath: string) {
  const values = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`${baselinePath} must contain exactly one non-negative integer`);
  }
  return Number(value);
}

export function compareRatchetSets(
  current: Iterable<string>,
  allowed: ReadonlySet<string>,
  compare = compareEntries,
) {
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((entry) => !allowed.has(entry)).toSorted(compare),
    removed: [...allowed].filter((entry) => !currentSet.has(entry)).toSorted(compare),
  };
}

export function compareRatchetCounts(
  current: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
) {
  return {
    increased: collectRatchetDeltas(current, allowed, true),
    decreased: collectRatchetDeltas(allowed, current, false),
  };
}

function collectRatchetDeltas(
  entries: ReadonlyMap<string, number>,
  counterpart: ReadonlyMap<string, number>,
  increased: boolean,
) {
  return [...entries]
    .flatMap(([entry, count]): RatchetCountDelta[] => {
      const other = counterpart.get(entry) ?? 0;
      return count > other
        ? [{ allowed: increased ? other : count, current: increased ? count : other, entry }]
        : [];
    })
    .toSorted((left, right) => compareEntries(left.entry, right.entry));
}

export function formatRatchetMessage(title: string, entries: readonly string[]) {
  return [title, ...entries.map((entry) => "  " + entry)].join("\n");
}

export function reportRatchetFailures(
  groups: readonly { entries: readonly string[]; title: string }[],
  guidance?: string,
) {
  const active = groups.filter((group) => group.entries.length > 0);
  for (const group of active) {
    console.error(formatRatchetMessage(group.title, group.entries));
  }
  if (active.length > 0 && guidance) {
    console.error(guidance);
  }
  return active.length > 0;
}

export function reportRatchetSuccess(message: string) {
  console.log(message);
}

export function enforceRatchetScalar(
  current: number,
  allowed: number,
  messages: { decreased?: string; increased?: string },
) {
  const failure =
    current > allowed ? messages.increased : current < allowed ? messages.decreased : undefined;
  if (failure) {
    throw new Error(failure);
  }
}
