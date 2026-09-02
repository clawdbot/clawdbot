#!/usr/bin/env node
// Test Skip Inventory reports skipped, conditional, todo, and focused tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isCodeFile, isTestRelatedFile, listRepoFilesSync } from "./check-file-utils.js";

type SkipInventoryKind = "alias" | "call";
type SkipInventoryReason =
  | "conditional-skip"
  | "explicit-skip"
  | "focused-only"
  | "live-gate"
  | "optional-dependency"
  | "platform-gate"
  | "todo";

type SkipInventoryTarget = "describe" | "it" | "test" | "unknown";

type TestSkipInventoryFinding = {
  excerpt: string;
  file: string;
  kind: SkipInventoryKind;
  line: number;
  method: "only" | "runIf" | "skip" | "skipIf" | "todo";
  reason: SkipInventoryReason;
  target: SkipInventoryTarget;
};

export type TestSkipInventoryReport = {
  findings: TestSkipInventoryFinding[];
  scannedFileCount: number;
  schemaVersion: 1;
  summary: {
    findingCount: number;
    reasonCounts: Record<SkipInventoryReason, number>;
    scannedFileCount: number;
    touchedFileCount: number;
  };
};

const EMPTY_REASON_COUNTS: Record<SkipInventoryReason, number> = {
  "conditional-skip": 0,
  "explicit-skip": 0,
  "focused-only": 0,
  "live-gate": 0,
  "optional-dependency": 0,
  "platform-gate": 0,
  todo: 0,
};
const SKIP_METHODS = new Set(["only", "runIf", "skip", "skipIf", "todo"]);
const TEST_TARGETS = new Set(["describe", "it", "test"]);
const TRANSPARENT_CHAIN_METHODS = new Set(["concurrent", "each", "sequential"]);

function listCandidateFiles(repoRoot: string): string[] {
  return listRepoFilesSync(repoRoot, {
    includeFile: (file) => isCodeFile(file) && isTestRelatedFile(file),
  });
}

function expressionText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return node.getText(sourceFile);
}

function targetFromExpression(expression: ts.Expression): SkipInventoryTarget {
  if (ts.isIdentifier(expression) && TEST_TARGETS.has(expression.text)) {
    return expression.text as SkipInventoryTarget;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    TRANSPARENT_CHAIN_METHODS.has(expression.name.text)
  ) {
    return targetFromExpression(expression.expression);
  }
  return "unknown";
}

function propertyAccessSkipMethod(
  expression: ts.Expression,
): { method: TestSkipInventoryFinding["method"]; target: SkipInventoryTarget } | null {
  if (!ts.isPropertyAccessExpression(expression) || !SKIP_METHODS.has(expression.name.text)) {
    return null;
  }
  const target = targetFromExpression(expression.expression);
  if (target === "unknown") {
    return null;
  }
  return {
    method: expression.name.text as TestSkipInventoryFinding["method"],
    target,
  };
}

function skipMethodFromExpression(
  expression: ts.Expression,
): { method: TestSkipInventoryFinding["method"]; target: SkipInventoryTarget } | null {
  if (ts.isParenthesizedExpression(expression)) {
    return skipMethodFromExpression(expression.expression);
  }

  const directMethod = propertyAccessSkipMethod(expression);
  if (directMethod) {
    return directMethod;
  }

  if (ts.isConditionalExpression(expression)) {
    return (
      skipMethodFromExpression(expression.whenTrue) ??
      skipMethodFromExpression(expression.whenFalse)
    );
  }
  if (ts.isCallExpression(expression)) {
    return skipMethodFromExpression(expression.expression);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    TRANSPARENT_CHAIN_METHODS.has(expression.name.text)
  ) {
    return skipMethodFromExpression(expression.expression);
  }

  return null;
}

function methodReason(params: {
  file: string;
  method: TestSkipInventoryFinding["method"];
  sourceFile: ts.SourceFile;
  textNode: ts.Node;
}): SkipInventoryReason {
  if (params.method === "todo") {
    return "todo";
  }
  if (params.method === "only") {
    return "focused-only";
  }

  const sourceText = expressionText(params.sourceFile, params.textNode).toLowerCase();
  const text = `${params.file}\n${sourceText}`.toLowerCase();
  if (
    sourceText.includes("process.platform") ||
    sourceText.includes("win32") ||
    sourceText.includes("darwin") ||
    sourceText.includes("linux")
  ) {
    return "platform-gate";
  }
  if (
    text.includes(".live.test.") ||
    sourceText.includes("openclaw_live") ||
    sourceText.includes("live_test") ||
    sourceText.includes("api_key") ||
    sourceText.includes("token") ||
    /\blive\b/u.test(sourceText)
  ) {
    return "live-gate";
  }
  if (
    text.includes("chromium") ||
    text.includes("browser") ||
    text.includes("docker") ||
    text.includes("ffmpeg") ||
    text.includes("gotoolchain") ||
    text.includes("go toolchain")
  ) {
    return "optional-dependency";
  }
  if (params.method === "skipIf" || params.method === "runIf") {
    return "conditional-skip";
  }
  if (params.method === "skip" && containsConditionalExpression(params.textNode)) {
    return "conditional-skip";
  }
  return "explicit-skip";
}

function containsConditionalExpression(node: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) {
    return true;
  }
  return node.getChildren().some((child) => containsConditionalExpression(child));
}

function createFinding(params: {
  file: string;
  kind: SkipInventoryKind;
  lines: string[];
  method: TestSkipInventoryFinding["method"];
  node: ts.Node;
  reasonNode: ts.Node;
  sourceFile: ts.SourceFile;
  target: SkipInventoryTarget;
}): TestSkipInventoryFinding {
  const { line } = params.sourceFile.getLineAndCharacterOfPosition(params.node.getStart());
  return {
    excerpt: params.lines[line]?.trim() ?? "",
    file: params.file,
    kind: params.kind,
    line: line + 1,
    method: params.method,
    reason: methodReason({
      file: params.file,
      method: params.method,
      sourceFile: params.sourceFile,
      textNode: params.reasonNode,
    }),
    target: params.target,
  };
}

function skipAliasInitializer(
  initializer: ts.Expression | undefined,
): { method: TestSkipInventoryFinding["method"]; target: SkipInventoryTarget } | null {
  if (!initializer) {
    return null;
  }
  return skipMethodFromExpression(initializer);
}

function scanFile(params: { file: string; repoRoot: string }): TestSkipInventoryFinding[] {
  const absolutePath = path.join(params.repoRoot, params.file);
  const source = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(params.file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/u);
  const findings: TestSkipInventoryFinding[] = [];

  function addFinding(details: {
    kind: SkipInventoryKind;
    method: TestSkipInventoryFinding["method"];
    node: ts.Node;
    reasonNode: ts.Node;
    target: SkipInventoryTarget;
  }): void {
    findings.push(
      createFinding({
        file: params.file,
        kind: details.kind,
        lines,
        method: details.method,
        node: details.node,
        reasonNode: details.reasonNode,
        sourceFile,
        target: details.target,
      }),
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      const alias = skipAliasInitializer(node.initializer);
      if (alias) {
        addFinding({
          kind: "alias",
          method: alias.method,
          node,
          reasonNode: node.initializer ?? node,
          target: alias.target,
        });
      }
    } else if (ts.isCallExpression(node)) {
      const method = isNestedTestModifierCallee(node)
        ? null
        : skipMethodFromExpression(node.expression);
      if (method) {
        addFinding({
          kind: "call",
          method: method.method,
          node,
          reasonNode: node,
          target: method.target,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function isNestedTestModifierCallee(node: ts.CallExpression): boolean {
  const parent = node.parent;
  return (
    (ts.isCallExpression(parent) && parent.expression === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.expression === node)
  );
}

export function collectTestSkipInventoryReport(
  params: { repoRoot?: string } = {},
): TestSkipInventoryReport {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const files = listCandidateFiles(repoRoot);
  const findings = files.flatMap((file) => scanFile({ file, repoRoot }));
  const reasonCounts = { ...EMPTY_REASON_COUNTS };
  for (const finding of findings) {
    reasonCounts[finding.reason] += 1;
  }
  return {
    findings,
    scannedFileCount: files.length,
    schemaVersion: 1,
    summary: {
      findingCount: findings.length,
      reasonCounts,
      scannedFileCount: files.length,
      touchedFileCount: new Set(findings.map((finding) => finding.file)).size,
    },
  };
}

function groupFindingsByFile(
  findings: TestSkipInventoryFinding[],
): Map<string, TestSkipInventoryFinding[]> {
  const grouped = new Map<string, TestSkipInventoryFinding[]>();
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

function renderReasonCounts(reasonCounts: Record<SkipInventoryReason, number>): string {
  return Object.entries(reasonCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
}

function renderFindingGroups(findings: TestSkipInventoryFinding[], limit: number): string[] {
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
      lines.push(
        `  L${finding.line} ${finding.target}.${finding.method} ${finding.reason}: ${finding.excerpt}`,
      );
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

export function renderTestSkipInventoryReport(
  report: TestSkipInventoryReport,
  options: { limit?: number } = {},
): string {
  const limit = options.limit === 0 ? Number.POSITIVE_INFINITY : (options.limit ?? 120);
  const reasonCounts = renderReasonCounts(report.summary.reasonCounts) || "none";
  const lines = [
    "OpenClaw test skip inventory",
    `Scanned files: ${report.summary.scannedFileCount}`,
    `Findings: ${report.summary.findingCount} in ${report.summary.touchedFileCount} file(s)`,
    `Reasons: ${reasonCounts}`,
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push("Findings:");
    lines.push(...renderFindingGroups(report.findings, limit));
  }

  return `${lines.join("\n")}\n`;
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

function parseArgs(argv: string[]): {
  help: boolean;
  json: boolean;
  limit: number;
  repoRoot: string;
} {
  let help = false;
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

  return { help, json, limit, repoRoot };
}

function printHelp(): void {
  process.stdout.write(`OpenClaw test skip inventory

Usage:
  pnpm test:skip-inventory:report [options]

Options:
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

  const report = collectTestSkipInventoryReport({ repoRoot: args.repoRoot });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTestSkipInventoryReport(report, { limit: args.limit }));
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
