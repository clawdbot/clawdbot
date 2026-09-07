import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  compareRatchetCounts,
  listRatchetRenames,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  parseRatchetCounts,
  reportRatchetFailures,
  reportRatchetSuccess,
  resolveRatchetBase,
  type RatchetCountDelta,
} from "./lib/shrink-ratchet.mts";
import {
  TYPE_ASSERTION_PRODUCTION_ROOTS,
  isSkippedTypeAssertionTestPath,
  pathMatchesTypeAssertionRoot,
} from "./lib/type-assertion-guard-scope.mjs";

const BASELINE_PATH = "config/assertion-safety-baseline.txt";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const BASELINE_HEADER = [
  "# Per-file counts of production type assertions without a // SAFETY: invariant.",
  "# Ratchet: counts may only shrink. New non-const assertions need a SAFETY comment.",
  "# Format: repo-relative path, tab, positive count. Zero-count files are omitted.",
  "",
].join("\n");

type AssertionNode = ts.AsExpression | ts.TypeAssertion;

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function isDeclarationFile(filePath: string) {
  return [".d.ts", ".d.mts", ".d.cts"].some((suffix) => filePath.endsWith(suffix));
}

export function isGovernedAssertionSourcePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return (
    TYPE_ASSERTION_PRODUCTION_ROOTS.some((root) =>
      pathMatchesTypeAssertionRoot(normalized, root),
    ) &&
    SOURCE_EXTENSIONS.has(path.posix.extname(normalized)) &&
    !isDeclarationFile(normalized) &&
    !isSkippedTypeAssertionTestPath(normalized)
  );
}

function scriptKindForPath(filePath: string) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function collectSafetyCommentLines(sourceFile: ts.SourceFile, source: string) {
  // Line text, not token scanning: a raw scanner desyncs on the `}` that ends a
  // template substitution and then misses every later comment in the file.
  const sameLine = new Set<number>();
  const standalone = new Set<number>();
  sourceFile.getLineStarts().forEach((lineStart, line) => {
    const lineEnd = source.indexOf("\n", lineStart);
    const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const commentStart = text.indexOf("//");
    if (commentStart === -1 || !/^\/\/\s*SAFETY:\s*\S/u.test(text.slice(commentStart).trim())) {
      return;
    }
    sameLine.add(line);
    if (text.slice(0, commentStart).trim() === "") {
      standalone.add(line);
    }
  });
  return { sameLine, standalone };
}

function assertionOperatorPosition(sourceFile: ts.SourceFile, node: AssertionNode) {
  const operatorKind = ts.isAsExpression(node)
    ? ts.SyntaxKind.AsKeyword
    : ts.SyntaxKind.LessThanToken;
  return (
    node
      .getChildren(sourceFile)
      .find((child) => child.kind === operatorKind)
      ?.getStart(sourceFile) ?? node.getStart(sourceFile)
  );
}

function isUnknownAssertion(node: AssertionNode) {
  // Casting exactly to unknown strengthens evidence; oxlint still rejects chained assertions such as `x as unknown as T`.
  return node.type.kind === ts.SyntaxKind.UnknownKeyword;
}

export function countUnsafeAssertions(source: string, filePath = "src/source.ts") {
  const repoPath = filePath.replaceAll("\\", "/");
  if (isDeclarationFile(repoPath)) {
    return 0;
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  const diagnostic = parseDiagnostics[0];
  if (diagnostic) {
    const position = diagnostic.start ?? 0;
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    throw new Error(
      `${filePath}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }

  const safetyCommentLines = collectSafetyCommentLines(sourceFile, source);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (!ts.isConstTypeReference(node.type) && !isUnknownAssertion(node)) {
        const operatorLine = sourceFile.getLineAndCharacterOfPosition(
          assertionOperatorPosition(sourceFile, node),
        ).line;
        if (
          !safetyCommentLines.sameLine.has(operatorLine) &&
          !safetyCommentLines.standalone.has(operatorLine - 1)
        ) {
          count += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function parseAssertionBaseline(source: string) {
  return parseRatchetCounts(source, BASELINE_PATH);
}

function formatBaseline(counts: ReadonlyMap<string, number>) {
  const entries = [...counts]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([filePath, count]) => `${filePath}\t${count}`);
  return BASELINE_HEADER + entries.join("\n") + (entries.length > 0 ? "\n" : "");
}

function baselineWithVerifiedRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  baseline: ReadonlyMap<string, number>,
  baseBaseline: ReadonlyMap<string, number>,
) {
  const allowed = new Map(baseBaseline);
  for (const { from, to } of listRatchetRenames(
    root,
    baseRef,
    staged,
    TYPE_ASSERTION_PRODUCTION_ROOTS,
  )) {
    const oldCount = baseBaseline.get(from);
    const newCount = baseline.get(to);
    if (
      oldCount !== undefined &&
      newCount !== undefined &&
      newCount <= oldCount &&
      !baseline.has(from)
    ) {
      allowed.delete(from);
      allowed.set(to, oldCount);
    }
  }
  return allowed;
}

export function collectCurrentAssertionSafetyCounts(
  root = process.cwd(),
  options: { staged?: boolean } = {},
) {
  const staged = options.staged === true;
  const filePaths = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      ...(staged ? ["--cached"] : ["--cached", "--others", "--exclude-standard"]),
      "--",
      ...TYPE_ASSERTION_PRODUCTION_ROOTS,
    ],
    { cwd: root, maxBuffer: GIT_MAX_BUFFER },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isGovernedAssertionSourcePath)
    .filter((filePath) => staged || fs.existsSync(path.join(root, filePath)))
    .toSorted(compareStrings);
  const sources = staged
    ? [...loadRatchetSources(root, filePaths)]
    : filePaths.map((filePath): [string, string] => [
        filePath,
        fs.readFileSync(path.join(root, filePath), "utf8"),
      ]);
  const counts = new Map<string, number>();
  for (const [filePath, source] of sources) {
    const count = countUnsafeAssertions(source, filePath);
    if (count > 0) {
      counts.set(filePath, count);
    }
  }
  return counts;
}

function allowanceWithExistingBaseCounts(
  root: string,
  baseRef: string,
  proposed: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
) {
  const effective = new Map(allowed);
  for (const [filePath, count] of proposed) {
    if (count <= (effective.get(filePath) ?? 0)) {
      continue;
    }
    try {
      const source = execFileSync("git", ["show", `${baseRef}:${filePath}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const baseCount = countUnsafeAssertions(source, filePath);
      if (baseCount > (effective.get(filePath) ?? 0)) {
        effective.set(filePath, baseCount);
      }
    } catch {
      // Missing base paths are branch additions and receive no allowance.
    }
  }
  return effective;
}

function writeBaseline(root: string, counts: ReadonlyMap<string, number>) {
  fs.writeFileSync(path.join(root, BASELINE_PATH), formatBaseline(counts));
}

function formatDeltas(entries: RatchetCountDelta[], comparison: ">" | "<") {
  return entries.map((entry) => `${entry.entry}: ${entry.current} ${comparison} ${entry.allowed}`);
}

function totalCount(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

export function main(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    const baseRef = resolveRatchetBase(root, { base: args.base, staged: args.staged });
    const baseBaseline = baseRef
      ? loadRatchetReference(root, baseRef, BASELINE_PATH, parseAssertionBaseline)
      : null;
    const current = collectCurrentAssertionSafetyCounts(root, { staged: args.staged });

    let baselineSource;
    try {
      baselineSource = loadRatchetSnapshot(
        root,
        BASELINE_PATH,
        args.staged,
        parseAssertionBaseline,
      );
    } catch {
      if (args.prune && !args.staged && baseBaseline === null) {
        writeBaseline(root, current);
        reportRatchetSuccess(
          `Initialized ${BASELINE_PATH}: ${current.size} files, ${totalCount(current)} assertions.`,
        );
        return 0;
      }
      throw new Error("Missing " + BASELINE_PATH + (args.staged ? " in the index" : ""));
    }

    const baseline = baselineSource;
    if (args.prune && !args.staged && baseBaseline === null) {
      writeBaseline(root, current);
      reportRatchetSuccess(
        `Refreshed initial ${BASELINE_PATH}: ${current.size} files, ${totalCount(current)} assertions.`,
      );
      return 0;
    }
    const allowedBaseline =
      baseRef && baseBaseline
        ? baselineWithVerifiedRenames(root, baseRef, args.staged, baseline, baseBaseline)
        : baseBaseline;
    const currentAllowance =
      baseRef && baseBaseline
        ? allowanceWithExistingBaseCounts(root, baseRef, current, baseline)
        : baseline;
    const expansionAllowance =
      baseRef && allowedBaseline
        ? allowanceWithExistingBaseCounts(root, baseRef, baseline, allowedBaseline)
        : allowedBaseline;
    const increases = compareRatchetCounts(current, currentAllowance).increased;
    const expanded = expansionAllowance
      ? compareRatchetCounts(baseline, expansionAllowance).increased
      : [];

    if (
      reportRatchetFailures(
        [
          {
            entries: formatDeltas(increases, ">"),
            title: "Uncommented type assertions exceed the grandfathered per-file baseline:",
          },
          {
            entries: formatDeltas(expanded, ">"),
            title: "The assertion SAFETY baseline may only shrink:",
          },
        ],
        "Every new non-const type assertion needs // SAFETY: <invariant> above it or on the same line.",
      )
    ) {
      return 1;
    }

    if (args.prune) {
      const oldFiles = baseline.size;
      const oldAssertions = totalCount(baseline);
      writeBaseline(root, current);
      reportRatchetSuccess(
        `Pruned ${BASELINE_PATH}: ${oldFiles} -> ${current.size} files; ${oldAssertions} -> ${totalCount(current)} assertions.`,
      );
      return 0;
    }

    const stale = compareRatchetCounts(current, baseline).decreased;
    if (
      reportRatchetFailures([
        {
          entries: formatDeltas(stale, "<"),
          title: `Shrink ${BASELINE_PATH} entries (or run with --prune):`,
        },
      ])
    ) {
      return 1;
    }

    reportRatchetSuccess(
      `assertion SAFETY ratchet OK: ${current.size} files, ${totalCount(current)} grandfathered assertions.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
