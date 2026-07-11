#!/usr/bin/env node
// Test Env Mutation Report script supports OpenClaw repository automation.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectFilesSync, isCodeFile, toPosixPath } from "./check-file-utils.js";

type EnvMutationOperation = "assign" | "delete" | "replace" | "stubEnv";

type TestEnvMutationFinding = {
  allowed: boolean;
  allowReason?: string;
  excerpt: string;
  file: string;
  key: string;
  line: number;
  operation: EnvMutationOperation;
};

export type TestEnvMutationReport = {
  activeFindings: TestEnvMutationFinding[];
  allowedFindings: TestEnvMutationFinding[];
  findings: TestEnvMutationFinding[];
  scannedFileCount: number;
  schemaVersion: 1;
  summary: {
    activeFindingCount: number;
    activeFileCount: number;
    allowedFindingCount: number;
    allowedFileCount: number;
    findingCount: number;
    scannedFileCount: number;
  };
};

const DYNAMIC_ENV_KEY = "<dynamic>";
const DEFAULT_SCAN_ROOTS = ["src", "test", "extensions", "packages", "ui", "scripts"];
const DEFAULT_SKIPPED_DIR_NAMES = new Set([
  ".artifacts",
  ".generated",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "vendor",
]);
const TRACKED_ENV_KEYS = new Set([
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_WORKSPACE_DIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const DEFAULT_ALLOWED_FILES = new Map([
  ["src/test-utils/openclaw-test-state.ts", "canonical OpenClaw test state helper"],
  ["test/non-isolated-runner.ts", "shared Vitest runner restores global env between files"],
  ["test/setup.extensions.ts", "global extension-test setup owns process env isolation"],
  ["test/setup.shared.ts", "global shared-test setup owns process env isolation"],
  ["test/setup.ts", "global test setup owns process env isolation"],
  ["test/setup-openclaw-runtime.ts", "global runtime-test setup owns process env isolation"],
  [
    "test/helpers/auto-reply/trigger-handling-test-harness.ts",
    "auto-reply harness owns a suite-scoped temporary home",
  ],
]);

function isTestRelatedFile(relativePath: string): boolean {
  return (
    /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:e2e|live)\.test\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:test-helpers|test-utils|test-harness|test-support)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /-(?:test-helpers|test-utils|test-harness|test-support)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /(?:^|\/)(?:test|tests|test-helpers|test-utils|test-harness|test-support)\//u.test(
      relativePath,
    ) ||
    relativePath.startsWith("scripts/e2e/") ||
    /^scripts\/.*-(?:client|e2e|harness|probe|smoke)\.[cm]?[jt]s$/u.test(relativePath)
  );
}

function listGitFiles(repoRoot: string): string[] | null {
  try {
    const stdout = execFileSync("git", ["-C", repoRoot, "ls-files", "--", ...DEFAULT_SCAN_ROOTS], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.split(/\r?\n/u).filter(Boolean);
  } catch {
    return null;
  }
}

function listCandidateFiles(repoRoot: string): string[] {
  const gitFiles = listGitFiles(repoRoot);
  const relativeFiles =
    gitFiles ??
    DEFAULT_SCAN_ROOTS.flatMap((root) => {
      const absoluteRoot = path.join(repoRoot, root);
      if (!fs.existsSync(absoluteRoot)) {
        return [];
      }
      return collectFilesSync(absoluteRoot, {
        includeFile: isCodeFile,
        skipDirNames: DEFAULT_SKIPPED_DIR_NAMES,
      }).map((filePath) => toPosixPath(path.relative(repoRoot, filePath)));
    });
  return relativeFiles
    .filter((file) => isCodeFile(file) && isTestRelatedFile(file))
    .toSorted((left, right) => left.localeCompare(right));
}

function isIdentifier(node: ts.Node, text: string): boolean {
  return ts.isIdentifier(node) && node.text === text;
}

function isProcessEnvExpression(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    isIdentifier(node.expression, "process")
  );
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  if (!node) {
    return null;
  }
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function envKeyFromExpression(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnvExpression(node.expression)) {
    return stringLiteralText(node.argumentExpression) ?? DYNAMIC_ENV_KEY;
  }
  return null;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function envKeysFromObjectLiteral(node: ts.Expression): string[] {
  if (!ts.isObjectLiteralExpression(node)) {
    return [];
  }
  return node.properties
    .map((property) => (ts.isPropertyAssignment(property) ? propertyNameText(property.name) : null))
    .filter((key): key is string => key !== null && TRACKED_ENV_KEYS.has(key));
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function stubEnvKeyFromCall(node: ts.CallExpression): string | null {
  const expression = node.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== "stubEnv" ||
    !isIdentifier(expression.expression, "vi")
  ) {
    return null;
  }
  return stringLiteralText(node.arguments[0]);
}

function createFinding(params: {
  allowedFiles: ReadonlyMap<string, string>;
  file: string;
  key: string;
  lines: string[];
  node: ts.Node;
  operation: EnvMutationOperation;
  sourceFile: ts.SourceFile;
}): TestEnvMutationFinding {
  const { line } = params.sourceFile.getLineAndCharacterOfPosition(params.node.getStart());
  const allowReason = params.allowedFiles.get(params.file);
  return {
    allowed: allowReason !== undefined,
    ...(allowReason ? { allowReason } : {}),
    excerpt: params.lines[line]?.trim() ?? "",
    file: params.file,
    key: params.key,
    line: line + 1,
    operation: params.operation,
  };
}

function scanFile(params: {
  allowedFiles: ReadonlyMap<string, string>;
  file: string;
  repoRoot: string;
}): TestEnvMutationFinding[] {
  const absolutePath = path.join(params.repoRoot, params.file);
  const source = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(params.file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/u);
  const findings: TestEnvMutationFinding[] = [];

  function addFinding(node: ts.Node, key: string, operation: EnvMutationOperation): void {
    if (key !== DYNAMIC_ENV_KEY && !TRACKED_ENV_KEYS.has(key)) {
      return;
    }
    findings.push(
      createFinding({
        allowedFiles: params.allowedFiles,
        file: params.file,
        key,
        lines,
        node,
        operation,
        sourceFile,
      }),
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isProcessEnvExpression(node.left)
      ) {
        for (const key of envKeysFromObjectLiteral(node.right)) {
          addFinding(node, key, "replace");
        }
      } else {
        const key = envKeyFromExpression(node.left);
        if (key) {
          addFinding(node, key, "assign");
        }
      }
    } else if (ts.isDeleteExpression(node)) {
      const key = envKeyFromExpression(node.expression);
      if (key) {
        addFinding(node, key, "delete");
      }
    } else if (ts.isCallExpression(node)) {
      const key = stubEnvKeyFromCall(node);
      if (key) {
        addFinding(node, key, "stubEnv");
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export function collectTestEnvMutationReport(
  params: {
    allowedFiles?: ReadonlyMap<string, string>;
    repoRoot?: string;
  } = {},
): TestEnvMutationReport {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const allowedFiles = params.allowedFiles ?? DEFAULT_ALLOWED_FILES;
  const files = listCandidateFiles(repoRoot);
  const findings = files.flatMap((file) => scanFile({ allowedFiles, file, repoRoot }));
  const activeFindings = findings.filter((finding) => !finding.allowed);
  const allowedFindings = findings.filter((finding) => finding.allowed);
  const activeFileCount = new Set(activeFindings.map((finding) => finding.file)).size;
  const allowedFileCount = new Set(allowedFindings.map((finding) => finding.file)).size;
  return {
    activeFindings,
    allowedFindings,
    findings,
    scannedFileCount: files.length,
    schemaVersion: 1,
    summary: {
      activeFindingCount: activeFindings.length,
      activeFileCount,
      allowedFindingCount: allowedFindings.length,
      allowedFileCount,
      findingCount: findings.length,
      scannedFileCount: files.length,
    },
  };
}

function groupFindingsByFile(
  findings: TestEnvMutationFinding[],
): Map<string, TestEnvMutationFinding[]> {
  const grouped = new Map<string, TestEnvMutationFinding[]>();
  for (const finding of findings) {
    const fileFindings = grouped.get(finding.file);
    if (fileFindings) {
      fileFindings.push(finding);
    } else {
      grouped.set(finding.file, [finding]);
    }
  }
  return grouped;
}

function renderFindingGroups(findings: TestEnvMutationFinding[], limit: number): string[] {
  const lines: string[] = [];
  let shown = 0;
  for (const [file, fileFindings] of groupFindingsByFile(findings)) {
    if (shown >= limit) {
      break;
    }
    lines.push(`- ${file} (${fileFindings.length})`);
    for (const finding of fileFindings) {
      if (shown >= limit) {
        break;
      }
      const action =
        finding.operation === "stubEnv" ? "vi.stubEnv" : `${finding.operation} process.env`;
      lines.push(`  L${finding.line} ${finding.key} ${action}: ${finding.excerpt}`);
      shown += 1;
    }
  }
  if (findings.length > shown) {
    lines.push(
      `... ${findings.length - shown} more finding(s) not shown; pass --limit 0 to show all.`,
    );
  }
  return lines;
}

export function renderTestEnvMutationReport(
  report: TestEnvMutationReport,
  options: { includeAllowed?: boolean; limit?: number } = {},
): string {
  const limit = options.limit === 0 ? Number.POSITIVE_INFINITY : (options.limit ?? 120);
  const lines = [
    "OpenClaw test env mutation report",
    `Scanned files: ${report.summary.scannedFileCount}`,
    `Findings: ${report.summary.activeFindingCount} active in ${report.summary.activeFileCount} file(s), ${report.summary.allowedFindingCount} allowed in ${report.summary.allowedFileCount} file(s)`,
    "",
  ];

  if (report.activeFindings.length === 0) {
    lines.push("Active findings: none");
  } else {
    lines.push("Active findings:");
    lines.push(...renderFindingGroups(report.activeFindings, limit));
  }

  if (options.includeAllowed && report.allowedFindings.length > 0) {
    lines.push("", "Allowed harness findings:");
    lines.push(...renderFindingGroups(report.allowedFindings, limit));
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): {
  help: boolean;
  includeAllowed: boolean;
  json: boolean;
  limit: number;
  repoRoot: string;
} {
  let help = false;
  let includeAllowed = false;
  let json = false;
  let limit = 120;
  let repoRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--include-allowed") {
      includeAllowed = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") {
      limit = readNonNegativeIntArg(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--repo-root expects a path");
      }
      repoRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help, includeAllowed, json, limit, repoRoot };
}

function readNonNegativeIntArg(raw: string | undefined): number {
  if (!raw || raw.startsWith("--") || !/^\d+$/u.test(raw)) {
    throw new Error("--limit expects a non-negative integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("--limit expects a non-negative integer");
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`OpenClaw test env mutation report

Usage:
  pnpm test:env-mutations:report [options]

Options:
  --include-allowed    Include allowed harness findings in text output
  --json               Print the full JSON report
  --limit <n>          Maximum text findings to print; use 0 for all (default: 120)
  --repo-root <path>   Repository root to scan (default: current working directory)
  --help, -h           Show this help message
`);
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const report = collectTestEnvMutationReport({ repoRoot: args.repoRoot });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      renderTestEnvMutationReport(report, {
        includeAllowed: args.includeAllowed,
        limit: args.limit,
      }),
    );
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
