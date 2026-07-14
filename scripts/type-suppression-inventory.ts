#!/usr/bin/env node
// Type Suppression Inventory reports unchecked any casts and expected TypeScript errors.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectFilesSync, isCodeFile, toPosixPath } from "./check-file-utils.js";

type TypeSuppressionKind = "as-any" | "expect-error" | "type-assertion-any";

export type TypeSuppressionFinding = {
  excerpt: string;
  file: string;
  kind: TypeSuppressionKind;
  line: number;
};

export type TypeSuppressionReport = {
  findings: TypeSuppressionFinding[];
  scannedFileCount: number;
  schemaVersion: 1;
  summary: {
    findingCount: number;
    kindCounts: Record<TypeSuppressionKind, number>;
    scannedFileCount: number;
    touchedFileCount: number;
  };
};

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

function listGitFiles(repoRoot: string, roots: readonly string[]): string[] | null {
  try {
    const stdout = execFileSync("git", ["-C", repoRoot, "ls-files", "--", ...roots], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.split(/\r?\n/u).filter(Boolean);
  } catch {
    return null;
  }
}

function listCandidateFiles(repoRoot: string, roots: readonly string[]): string[] {
  const gitFiles = listGitFiles(repoRoot, roots);
  const relativeFiles =
    gitFiles ??
    roots.flatMap((root) => {
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
    .filter((file) => {
      const pathSegments = toPosixPath(file).split("/");
      return (
        /\.[cm]?tsx?$/u.test(file) &&
        !file.endsWith(".d.ts") &&
        !pathSegments.some((segment) => DEFAULT_SKIPPED_DIR_NAMES.has(segment))
      );
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function sourceKindForFile(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function addAnyCastFindings(
  sourceFile: ts.SourceFile,
  file: string,
  findings: TypeSuppressionFinding[],
): void {
  const visit = (node: ts.Node): void => {
    const kind =
      ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword
        ? "as-any"
        : ts.isTypeAssertionExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword
          ? "type-assertion-any"
          : null;
    if (kind) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({
        excerpt: node.getText(sourceFile).replace(/\s+/gu, " ").trim(),
        file,
        kind,
        line: line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function addExpectErrorFindings(
  sourceFile: ts.SourceFile,
  file: string,
  findings: TypeSuppressionFinding[],
): void {
  const source = sourceFile.getFullText();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const comment = scanner.getTokenText();
    const markerPattern = /@ts-expect-error[^\r\n]*/gu;
    for (const match of comment.matchAll(markerPattern)) {
      const position = scanner.getTokenPos() + (match.index ?? 0);
      const line = sourceFile.getLineAndCharacterOfPosition(position).line;
      findings.push({
        excerpt: match[0].trim(),
        file,
        kind: "expect-error",
        line: line + 1,
      });
    }
  }
}

export function collectTypeSuppressionReport(params: {
  files?: readonly string[];
  repoRoot: string;
  roots?: readonly string[];
}): TypeSuppressionReport {
  const files = [
    ...(params.files ?? listCandidateFiles(params.repoRoot, params.roots ?? DEFAULT_SCAN_ROOTS)),
  ]
    .map(toPosixPath)
    .toSorted((left, right) => left.localeCompare(right));
  const findings: TypeSuppressionFinding[] = [];

  for (const file of files) {
    const absolutePath = path.join(params.repoRoot, file);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      sourceKindForFile(file),
    );
    addAnyCastFindings(sourceFile, file, findings);
    addExpectErrorFindings(sourceFile, file, findings);
  }

  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind),
  );
  const kindCounts: Record<TypeSuppressionKind, number> = {
    "as-any": 0,
    "expect-error": 0,
    "type-assertion-any": 0,
  };
  for (const finding of findings) {
    kindCounts[finding.kind] = kindCounts[finding.kind] + 1;
  }

  return {
    findings,
    scannedFileCount: files.length,
    schemaVersion: 1,
    summary: {
      findingCount: findings.length,
      kindCounts,
      scannedFileCount: files.length,
      touchedFileCount: new Set(findings.map((finding) => finding.file)).size,
    },
  };
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(`${JSON.stringify(collectTypeSuppressionReport({ repoRoot }), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
