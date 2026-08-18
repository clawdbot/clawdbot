import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { main as checkEnvVarCount } from "./check-env-var-count.mts";
import {
  compareRatchetSets,
  listRatchetRenames,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetPaths,
  reportRatchetFailures,
  reportRatchetSuccess,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

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
const compareStrings = (left: string, right: string) => left.localeCompare(right);

export function isGovernedSourcePath(filePath: string) {
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

export function collectLintDisableDirectives(source: string, filePath = "source.ts") {
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
  const comments = new Map<number, string>();
  const addComments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, source.slice(range.pos, range.end));
    }
  };
  const visit = (node: ts.Node) => {
    addComments(ts.getLeadingCommentRanges(source, node.pos));
    addComments(ts.getTrailingCommentRanges(source, node.end));
    // getChildren includes delimiter tokens; forEachChild misses directives before closing tokens.
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);
  addComments(ts.getLeadingCommentRanges(source, sourceFile.endOfFileToken.pos));

  const directives: string[][] = [];
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

export function isMaxLinesRule(rule: string) {
  return rule === "max-lines" || rule.endsWith("/max-lines");
}

export function hasMaxLinesDisable(source: string, filePath = "source.ts") {
  return collectLintDisableDirectives(source, filePath).some((rules) => rules.some(isMaxLinesRule));
}

export function hasAllRuleDisable(source: string, filePath = "source.ts") {
  return collectLintDisableDirectives(source, filePath).some((rules) => rules.length === 0);
}

function baselineWithVerifiedRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  baseline: ReadonlySet<string>,
  baseBaseline: ReadonlySet<string>,
) {
  const allowed = new Set(baseBaseline);
  for (const { from, to } of listRatchetRenames(root, baseRef, staged, SOURCE_ROOTS)) {
    if (baseBaseline.has(from) && !baseline.has(from) && baseline.has(to)) {
      allowed.delete(from);
      allowed.add(to);
    }
  }
  return allowed;
}

function listStagedSuppressionCandidates(root: string) {
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

export function collectCurrentSuppressionState(
  root = process.cwd(),
  options: { staged?: boolean } = {},
) {
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
  const governedPaths = filePaths
    .filter(Boolean)
    .filter(isGovernedSourcePath)
    .filter((filePath) => staged || fs.existsSync(path.join(root, filePath)));
  const sources = staged
    ? [...loadRatchetSources(root, governedPaths)]
    : governedPaths.map((filePath): [string, string] => [
        filePath,
        fs.readFileSync(path.join(root, filePath), "utf8"),
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

function writeBaseline(root: string, entries: string[]) {
  fs.writeFileSync(path.join(root, BASELINE_PATH), BASELINE_HEADER + entries.join("\n") + "\n");
}

function parseArgs(argv: string[]) {
  const args: { base?: string; prune: boolean; staged: boolean } = { prune: false, staged: false };
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

function envVarCountArgs(argv: string[]) {
  const args = parseArgs(argv);
  return [...(args.staged ? ["--staged"] : []), ...(args.base ? ["--base", args.base] : [])];
}

export function main(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    let baselineSource;
    try {
      baselineSource = loadRatchetSnapshot(root, BASELINE_PATH, args.staged, parseRatchetPaths);
    } catch {
      throw new Error("Missing " + BASELINE_PATH + (args.staged ? " in the index" : ""));
    }
    const baseline = baselineSource;
    const { allRules, explicit: current } = collectCurrentSuppressionState(root, {
      staged: args.staged,
    });
    const { added, removed: stale } = compareRatchetSets(current, baseline, compareStrings);
    const baseRef = resolveRatchetBase(root, { base: args.base, staged: args.staged });
    const baseBaseline = baseRef
      ? loadRatchetReference(root, baseRef, BASELINE_PATH, parseRatchetPaths)
      : null;
    const allowedBaseline =
      baseRef && baseBaseline
        ? baselineWithVerifiedRenames(root, baseRef, args.staged, baseline, baseBaseline)
        : baseBaseline;
    const expanded = allowedBaseline
      ? compareRatchetSets(baseline, allowedBaseline, compareStrings).added
      : [];

    if (
      reportRatchetFailures([
        { entries: added, title: "New max-lines suppressions are forbidden; split these files:" },
        {
          entries: expanded,
          title: "The max-lines baseline may only shrink; remove these entries:",
        },
        {
          entries: allRules,
          title: "All-rule lint disables are forbidden; name only the required rules:",
        },
      ])
    ) {
      return 1;
    }

    if (args.prune) {
      const kept = [...baseline]
        .filter((entry) => current.includes(entry))
        .toSorted(compareStrings);
      writeBaseline(root, kept);
      reportRatchetSuccess(
        "Pruned " + BASELINE_PATH + ": " + baseline.size + " -> " + kept.length + ".",
      );
      return 0;
    }
    if (
      reportRatchetFailures([
        {
          entries: stale,
          title: "Remove stale max-lines baseline entries (or run with --prune):",
        },
      ])
    ) {
      return 1;
    }

    reportRatchetSuccess(
      "max-lines ratchet OK: " + current.length + " grandfathered suppressions.",
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runBaselineRatchets(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  const maxLinesStatus = main(root, argv);
  if (maxLinesStatus !== 0) {
    return maxLinesStatus;
  }
  try {
    // CI invokes this entry with its frozen fork-point ref. Carry the same snapshot
    // into the env budget so every baseline ratchet judges one tested tree.
    checkEnvVarCount(envVarCountArgs(argv), root);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runBaselineRatchets();
}
