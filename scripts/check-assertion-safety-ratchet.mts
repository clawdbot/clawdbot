import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolveRatchetBase } from "./lib/ratchet-base.mts";
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
type CountDelta = { allowed: number; current: number; filePath: string };

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
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    source,
  );
  const sameLine = new Set<number>();
  const standalone = new Set<number>();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) {
      continue;
    }
    const comment = source.slice(scanner.getTokenPos(), scanner.getTextPos()).trim();
    if (!/^\/\/\s*SAFETY:\s*\S/u.test(comment)) {
      continue;
    }
    const position = scanner.getTokenPos();
    const line = sourceFile.getLineAndCharacterOfPosition(position).line;
    sameLine.add(line);
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    if (source.slice(lineStart, position).trim() === "") {
      standalone.add(line);
    }
  }
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

export function parseAssertionSafetyBaseline(source: string) {
  const baseline = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/u)) {
    if (rawLine === "" || rawLine.startsWith("#")) {
      continue;
    }
    const separator = rawLine.lastIndexOf("\t");
    const filePath = rawLine.slice(0, separator);
    const countText = rawLine.slice(separator + 1);
    const count = Number(countText);
    if (separator <= 0 || !Number.isSafeInteger(count) || count <= 0 || baseline.has(filePath)) {
      throw new Error(`Invalid ${BASELINE_PATH} entry: ${rawLine}`);
    }
    baseline.set(filePath, count);
  }
  return baseline;
}

function formatBaseline(counts: ReadonlyMap<string, number>) {
  const entries = [...counts]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([filePath, count]) => `${filePath}\t${count}`);
  return BASELINE_HEADER + entries.join("\n") + (entries.length > 0 ? "\n" : "");
}

function findCountIncreases(
  current: ReadonlyMap<string, number>,
  allowed: ReadonlyMap<string, number>,
) {
  return [...current]
    .filter(([filePath, count]) => count > (allowed.get(filePath) ?? 0))
    .map(
      ([filePath, count]): CountDelta => ({
        allowed: allowed.get(filePath) ?? 0,
        current: count,
        filePath,
      }),
    )
    .toSorted((left, right) => compareStrings(left.filePath, right.filePath));
}

function findCountDecreases(
  current: ReadonlyMap<string, number>,
  baseline: ReadonlyMap<string, number>,
) {
  return [...baseline]
    .filter(([filePath, count]) => (current.get(filePath) ?? 0) < count)
    .map(
      ([filePath, count]): CountDelta => ({
        allowed: count,
        current: current.get(filePath) ?? 0,
        filePath,
      }),
    )
    .toSorted((left, right) => compareStrings(left.filePath, right.filePath));
}

function baselineWithVerifiedRenames(
  root: string,
  baseRef: string,
  staged: boolean,
  baseline: ReadonlyMap<string, number>,
  baseBaseline: ReadonlyMap<string, number>,
) {
  const args = ["diff", "--name-status", "-z", "--find-renames"];
  if (staged) {
    args.push("--cached");
  }
  args.push(baseRef, "--", ...TYPE_ASSERTION_PRODUCTION_ROOTS);
  const fields = execFileSync("git", args, { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString("utf8")
    .split("\0");
  const allowed = new Map(baseBaseline);
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      break;
    }
    const oldPath = fields[index++];
    if (!status.startsWith("R") && !status.startsWith("C")) {
      continue;
    }
    const newPath = fields[index++];
    const oldCount = oldPath ? baseBaseline.get(oldPath) : undefined;
    const newCount = newPath ? baseline.get(newPath) : undefined;
    if (
      status.startsWith("R") &&
      oldPath &&
      newPath &&
      oldCount !== undefined &&
      newCount !== undefined &&
      newCount <= oldCount &&
      !baseline.has(oldPath)
    ) {
      allowed.delete(oldPath);
      allowed.set(newPath, oldCount);
    }
  }
  return allowed;
}

function readSnapshotFile(root: string, filePath: string, staged: boolean) {
  if (staged) {
    return execFileSync("git", ["show", ":" + filePath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
  return fs.readFileSync(path.join(root, filePath), "utf8");
}

function readStagedSources(root: string, filePaths: string[]) {
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
    ? [...readStagedSources(root, filePaths)]
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

function readBaselineAtRef(root: string, ref: string) {
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
  return parseAssertionSafetyBaseline(
    execFileSync("git", ["show", ref + ":" + BASELINE_PATH], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
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

function parseArgs(argv: string[]) {
  const args: { base?: string; prune: boolean; staged: boolean } = {
    prune: false,
    staged: false,
  };
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

function printDeltas(title: string, entries: CountDelta[], comparison: ">" | "<") {
  console.error(title);
  for (const entry of entries) {
    console.error(`  ${entry.filePath}: ${entry.current} ${comparison} ${entry.allowed}`);
  }
}

function totalCount(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

export function main(root = process.cwd(), argv: string[] = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }

    const baseRef = resolveRatchetBase(root, { base: args.base, staged: args.staged });
    const baseBaseline = baseRef ? readBaselineAtRef(root, baseRef) : null;
    const current = collectCurrentAssertionSafetyCounts(root, { staged: args.staged });

    let baselineSource;
    try {
      baselineSource = readSnapshotFile(root, BASELINE_PATH, args.staged);
    } catch {
      if (args.prune && !args.staged && baseBaseline === null) {
        writeBaseline(root, current);
        console.log(
          `Initialized ${BASELINE_PATH}: ${current.size} files, ${totalCount(current)} assertions.`,
        );
        return 0;
      }
      throw new Error("Missing " + BASELINE_PATH + (args.staged ? " in the index" : ""));
    }

    const baseline = parseAssertionSafetyBaseline(baselineSource);
    if (args.prune && !args.staged && baseBaseline === null) {
      writeBaseline(root, current);
      console.log(
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
    const increases = findCountIncreases(current, currentAllowance);
    const expanded = expansionAllowance ? findCountIncreases(baseline, expansionAllowance) : [];

    if (increases.length > 0) {
      printDeltas(
        "Uncommented type assertions exceed the grandfathered per-file baseline:",
        increases,
        ">",
      );
    }
    if (expanded.length > 0) {
      printDeltas("The assertion SAFETY baseline may only shrink:", expanded, ">");
    }
    if (increases.length > 0 || expanded.length > 0) {
      console.error(
        "Every new non-const type assertion needs // SAFETY: <invariant> above it or on the same line.",
      );
      return 1;
    }

    if (args.prune) {
      const oldFiles = baseline.size;
      const oldAssertions = totalCount(baseline);
      writeBaseline(root, current);
      console.log(
        `Pruned ${BASELINE_PATH}: ${oldFiles} -> ${current.size} files; ${oldAssertions} -> ${totalCount(current)} assertions.`,
      );
      return 0;
    }

    const stale = findCountDecreases(current, baseline);
    if (stale.length > 0) {
      printDeltas(`Shrink ${BASELINE_PATH} entries (or run with --prune):`, stale, "<");
      return 1;
    }

    console.log(
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
