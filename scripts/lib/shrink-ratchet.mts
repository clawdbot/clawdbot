import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Owns file-backed shrink-only baseline mechanics: snapshot loading, debt comparison,
// and deterministic failure/shrink guidance. The chained-assertion exclusion ledger stays in
// type-assertion-guard-scope.mjs because it is live scope policy synchronously imported by the
// plain-JS oxlint plugin, not a baseline; folding it here would couple that runtime to git/fs
// machinery without reusing any ratchet behavior.

export type RatchetCountDelta = { allowed: number; current: number; entry: string };
export type RatchetFailureGroup = { entries: readonly string[]; title: string };
export type RatchetScalarMessages = { decreased?: string; increased?: string };

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const compareEntries = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

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
    return execFileSync("git", ["merge-base", "HEAD", resolved], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
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
    ? execFileSync("git", ["show", ":" + baselinePath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    : fs.readFileSync(path.join(root, baselinePath), "utf8");
  return parse(source);
}

export function loadRatchetReference<T>(
  root: string,
  ref: string,
  baselinePath: string,
  parse: (source: string) => T,
) {
  execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
    cwd: root,
    stdio: "ignore",
  });
  const entry = execFileSync("git", ["ls-tree", "--name-only", ref, "--", baselinePath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (entry !== baselinePath) {
    return null;
  }
  return parse(
    execFileSync("git", ["show", ref + ":" + baselinePath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
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
    increased: [...current]
      .filter(([entry, count]) => count > (allowed.get(entry) ?? 0))
      .map(
        ([entry, count]): RatchetCountDelta => ({
          allowed: allowed.get(entry) ?? 0,
          current: count,
          entry,
        }),
      )
      .toSorted((left, right) => compareEntries(left.entry, right.entry)),
    decreased: [...allowed]
      .filter(([entry, count]) => (current.get(entry) ?? 0) < count)
      .map(
        ([entry, count]): RatchetCountDelta => ({
          allowed: count,
          current: current.get(entry) ?? 0,
          entry,
        }),
      )
      .toSorted((left, right) => compareEntries(left.entry, right.entry)),
  };
}

export function compareRatchetScalar(current: number, allowed: number) {
  return { decreased: current < allowed, increased: current > allowed };
}

export function formatRatchetMessage(title: string, entries: readonly string[]) {
  return [title, ...entries.map((entry) => "  " + entry)].join("\n");
}

export function reportRatchetFailures(groups: readonly RatchetFailureGroup[], guidance?: string) {
  let failed = false;
  for (const group of groups) {
    if (group.entries.length === 0) {
      continue;
    }
    console.error(formatRatchetMessage(group.title, group.entries));
    failed = true;
  }
  if (failed && guidance) {
    console.error(guidance);
  }
  return failed;
}

export function reportRatchetSuccess(message: string) {
  console.log(message);
}

export function enforceRatchetScalar(
  current: number,
  allowed: number,
  messages: RatchetScalarMessages,
) {
  const comparison = compareRatchetScalar(current, allowed);
  const failure = comparison.increased ? messages.increased : messages.decreased;
  if ((comparison.increased || comparison.decreased) && failure) {
    throw new Error(failure);
  }
}
