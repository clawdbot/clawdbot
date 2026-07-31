import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const BASELINE_PATH = "config/max-lines-baseline.txt";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SOURCE_ROOTS = ["src", "ui/src", "packages", "extensions"];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const BASELINE_HEADER = [
  "# Files currently allowed to exceed the oxlint max-lines budget.",
  "# Ratchet: this list may only shrink. Split files; never add entries.",
  "# Existing suppressions carry a TODO at the file site.",
  "",
].join("\n");
const compareStrings = (left, right) => left.localeCompare(right);

export function isGovernedSourcePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (!SOURCE_ROOTS.some((root) => normalized === root || normalized.startsWith(root + "/"))) {
    return false;
  }
  if (!SOURCE_EXTENSIONS.has(path.posix.extname(normalized))) {
    return false;
  }
  return !(
    normalized.startsWith("ui/src/i18n/locales/") ||
    normalized.startsWith("src/wizard/i18n/locales/") ||
    /(?:^|\/)(?:__generated__|generated|protocol-gen|dist)(?:\/|$)/u.test(normalized) ||
    /\.generated\.[^/]+$/u.test(normalized)
  );
}

export function collectLintDisableDirectives(source, filePath = "source.ts") {
  if (!source.includes("oxlint-disable") && !source.includes("eslint-disable")) {
    return [];
  }
  const directive = /^(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=$|\s)([\s\S]*)$/u;
  const scriptKind = /\.[cm]?[jt]sx$/u.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const comments = new Map();
  const addComments = (ranges) => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, source.slice(range.pos, range.end));
    }
  };
  const visit = (node) => {
    addComments(ts.getLeadingCommentRanges(source, node.pos));
    addComments(ts.getTrailingCommentRanges(source, node.end));
    // getChildren includes delimiter tokens; forEachChild misses directives before closing tokens.
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);
  addComments(ts.getLeadingCommentRanges(source, sourceFile.endOfFileToken.pos));

  const directives = [];
  for (const text of comments.values()) {
    const comment = text.slice(2, text.startsWith("/*") ? -2 : undefined);
    const match = directive.exec(comment.trim());
    if (!match) {
      continue;
    }
    const directiveBody = match[1] ?? "";
    const reason = /--|(?<=\s)-(?=\s)/u.exec(directiveBody);
    const rules = (reason ? directiveBody.slice(0, reason.index) : directiveBody).trim();
    directives.push(rules === "" ? [] : rules.split(/[\s,]+/u));
  }
  return directives;
}

export function isMaxLinesRule(rule) {
  return rule === "max-lines" || rule.endsWith("/max-lines");
}

export function hasMaxLinesDisable(source, filePath = "source.ts") {
  return collectLintDisableDirectives(source, filePath).some((rules) => rules.some(isMaxLinesRule));
}

export function hasAllRuleDisable(source, filePath = "source.ts") {
  return collectLintDisableDirectives(source, filePath).some((rules) => rules.length === 0);
}

export function parseBaseline(source) {
  return new Set(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export function diffBaseline(current, baseline) {
  const currentSet = new Set(current);
  return {
    added: [...currentSet].filter((entry) => !baseline.has(entry)).toSorted(compareStrings),
    stale: [...baseline].filter((entry) => !currentSet.has(entry)).toSorted(compareStrings),
  };
}

export function findBaselineExpansion(current, base) {
  return [...current].filter((entry) => !base.has(entry)).toSorted(compareStrings);
}

function baselineWithVerifiedRenames(root, baseRef, staged, baseline, baseBaseline) {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (staged) {
    args.push("--cached");
  }
  args.push(baseRef, "--", ...SOURCE_ROOTS);
  const fields = execFileSync("git", args, { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString("utf8")
    .split("\0");
  const allowed = new Set(baseBaseline);
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      break;
    }
    const oldPath = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const newPath = fields[index++];
      if (
        status.startsWith("R") &&
        oldPath &&
        newPath &&
        baseBaseline.has(oldPath) &&
        !baseline.has(oldPath) &&
        baseline.has(newPath)
      ) {
        allowed.delete(oldPath);
        allowed.add(newPath);
      }
    }
  }
  return allowed;
}

function readSnapshotFile(root, filePath, staged) {
  if (staged) {
    return execFileSync("git", ["show", ":" + filePath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
  return fs.readFileSync(path.join(root, filePath), "utf8");
}

function listStagedSuppressionCandidates(root) {
  // The staged policy covers the whole index. Narrow candidates once so a one-file
  // check does not spawn a Git process for every governed source.
  const result = spawnSync(
    "git",
    [
      "grep",
      "--cached",
      "-z",
      "-l",
      "-e",
      "oxlint-disable",
      "-e",
      "eslint-disable",
      "--",
      ...SOURCE_ROOTS,
    ],
    { cwd: root, maxBuffer: GIT_MAX_BUFFER },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "git grep failed");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function readStagedSources(root, filePaths) {
  if (filePaths.length === 0) {
    return new Map();
  }
  const output = execFileSync("git", ["cat-file", "--batch", "-z"], {
    cwd: root,
    input: filePaths.map((filePath) => ":" + filePath).join("\0") + "\0",
    maxBuffer: GIT_MAX_BUFFER,
  });
  const sources = new Map();
  let offset = 0;
  // -z keeps request paths NUL-framed on older Git; response headers remain newline-framed.
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) {
      throw new Error("Invalid git cat-file response for " + filePath);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
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

export function collectCurrentSuppressionState(root = process.cwd(), options = {}) {
  const staged = options.staged === true;
  const filePaths = staged
    ? listStagedSuppressionCandidates(root)
    : execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_ROOTS],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER },
      )
        .toString("utf8")
        .split("\0");
  const stagedSources = staged ? readStagedSources(root, filePaths) : null;
  const sources = filePaths
    .filter(Boolean)
    .filter(isGovernedSourcePath)
    .filter((filePath) => staged || fs.existsSync(path.join(root, filePath)))
    .map((filePath) => [
      filePath,
      staged ? stagedSources.get(filePath) : fs.readFileSync(path.join(root, filePath), "utf8"),
    ]);
  return {
    allRules: sources
      .filter(([filePath, source]) => hasAllRuleDisable(source, filePath))
      .map(([filePath]) => filePath)
      .toSorted(compareStrings),
    explicit: sources
      .filter(([filePath, source]) => hasMaxLinesDisable(source, filePath))
      .map(([filePath]) => filePath)
      .toSorted(compareStrings),
  };
}

export function collectCurrentSuppressions(root = process.cwd(), options = {}) {
  return collectCurrentSuppressionState(root, options).explicit;
}

function readBaselineAtRef(root, ref) {
  execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
    cwd: root,
    stdio: "ignore",
  });
  const entry = execFileSync("git", ["ls-tree", "--name-only", ref, "--", BASELINE_PATH], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (entry !== BASELINE_PATH) {
    return null;
  }
  return parseBaseline(
    execFileSync("git", ["show", ref + ":" + BASELINE_PATH], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

function resolveDefaultBase(root, staged) {
  const candidates = staged ? ["HEAD"] : ["origin/main", "HEAD"];
  const resolved = candidates.find((ref) => {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], {
        cwd: root,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!resolved || staged || resolved !== "origin/main") {
    return resolved ?? null;
  }
  // A release or long-lived branch owns the suppression debt from its fork.
  // Comparing against moving main would turn unrelated debt cleanup into a blocker.
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

function writeBaseline(root, entries) {
  fs.writeFileSync(path.join(root, BASELINE_PATH), BASELINE_HEADER + entries.join("\n") + "\n");
}

function parseArgs(argv) {
  const args = { base: undefined, prune: false, staged: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prune") {
      args.prune = true;
      continue;
    }
    if (arg === "--staged") {
      args.staged = true;
      continue;
    }
    if (arg === "--base" && argv[index + 1]) {
      args.base = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Unknown or incomplete argument: " + arg);
  }
  return args;
}

function printEntries(title, entries) {
  console.error(title);
  for (const entry of entries) {
    console.error("  " + entry);
  }
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    let baselineSource;
    try {
      baselineSource = readSnapshotFile(root, BASELINE_PATH, args.staged);
    } catch {
      throw new Error("Missing " + BASELINE_PATH + (args.staged ? " in the index" : ""));
    }
    const baseline = parseBaseline(baselineSource);
    const { allRules, explicit: current } = collectCurrentSuppressionState(root, {
      staged: args.staged,
    });
    const { added, stale } = diffBaseline(current, baseline);
    const baseRef = args.base ?? resolveDefaultBase(root, args.staged);
    const baseBaseline = baseRef ? readBaselineAtRef(root, baseRef) : null;
    const allowedBaseline =
      baseRef && baseBaseline
        ? baselineWithVerifiedRenames(root, baseRef, args.staged, baseline, baseBaseline)
        : baseBaseline;
    const expanded = allowedBaseline ? findBaselineExpansion(baseline, allowedBaseline) : [];

    if (added.length > 0) {
      printEntries("New max-lines suppressions are forbidden; split these files:", added);
    }
    if (expanded.length > 0) {
      printEntries("The max-lines baseline may only shrink; remove these entries:", expanded);
    }
    if (allRules.length > 0) {
      printEntries("All-rule lint disables are forbidden; name only the required rules:", allRules);
    }
    if (added.length > 0 || expanded.length > 0 || allRules.length > 0) {
      return 1;
    }

    if (args.prune) {
      const kept = [...baseline]
        .filter((entry) => current.includes(entry))
        .toSorted(compareStrings);
      writeBaseline(root, kept);
      console.log("Pruned " + BASELINE_PATH + ": " + baseline.size + " -> " + kept.length + ".");
      return 0;
    }
    if (stale.length > 0) {
      printEntries("Remove stale max-lines baseline entries (or run with --prune):", stale);
      return 1;
    }

    console.log("max-lines ratchet OK: " + current.length + " grandfathered suppressions.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
