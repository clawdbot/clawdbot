#!/usr/bin/env node
// Type Suppression Inventory reports unchecked any casts and expected TypeScript errors.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  REPO_SCAN_ROOTS,
  REPO_SCAN_SKIPPED_DIR_NAMES,
  listRepoFilesSync,
  toPosixPath,
} from "./check-file-utils.js";

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

const TYPE_SUPPRESSION_WHITESPACE_PATTERN = /\s/u;

function skipTypeScriptTrivia(source: string, start: number): number {
  let offset = start;
  while (offset < source.length) {
    const character = source[offset];
    if (character && TYPE_SUPPRESSION_WHITESPACE_PATTERN.test(character)) {
      offset += 1;
      continue;
    }
    if (source.startsWith("/*", offset)) {
      const commentEnd = source.indexOf("*/", offset + 2);
      offset = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (source.startsWith("//", offset)) {
      offset += 2;
      while (offset < source.length && !/[\r\n\u2028\u2029]/u.test(source[offset] ?? "")) {
        offset += 1;
      }
      continue;
    }
    break;
  }
  return offset;
}

function isAnyKeywordAt(source: string, offset: number): boolean {
  return (
    source.startsWith("any", offset) && !/[A-Za-z0-9_$]/u.test(source[offset + "any".length] ?? "")
  );
}

function hasTypeSuppressionTextCandidate(source: string): boolean {
  if (source.includes("@ts-expect-error")) {
    return true;
  }
  for (const match of source.matchAll(/\bas\b/gu)) {
    if (
      isAnyKeywordAt(source, skipTypeScriptTrivia(source, (match.index ?? 0) + match[0].length))
    ) {
      return true;
    }
  }
  for (let offset = source.indexOf("<"); offset !== -1; offset = source.indexOf("<", offset + 1)) {
    const anyOffset = skipTypeScriptTrivia(source, offset + 1);
    if (
      isAnyKeywordAt(source, anyOffset) &&
      source[skipTypeScriptTrivia(source, anyOffset + "any".length)] === ">"
    ) {
      return true;
    }
  }
  return false;
}

function listCandidateFiles(repoRoot: string, roots: readonly string[]): string[] {
  return listRepoFilesSync(repoRoot, {
    includeFile: (file) => {
      const pathSegments = toPosixPath(file).split("/");
      return (
        /\.[cm]?tsx?$/u.test(file) &&
        !file.endsWith(".d.ts") &&
        !pathSegments.some((segment) => REPO_SCAN_SKIPPED_DIR_NAMES.has(segment))
      );
    },
    roots,
  });
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
  if (!source.includes("@ts-expect-error")) {
    return;
  }
  const comments = new Map<number, ts.CommentRange>();
  const addComments = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, range);
    }
  };
  const visit = (node: ts.Node): void => {
    addComments(ts.getLeadingCommentRanges(source, node.pos));
    addComments(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);
  addComments(ts.getLeadingCommentRanges(source, sourceFile.endOfFileToken.pos));

  for (const range of comments.values()) {
    const comment = source.slice(range.pos, range.end);
    const markerPattern = /@ts-expect-error[^\r\n]*/gu;
    for (const match of comment.matchAll(markerPattern)) {
      const position = range.pos + (match.index ?? 0);
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
    ...(params.files ?? listCandidateFiles(params.repoRoot, params.roots ?? REPO_SCAN_ROOTS)),
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
    // Full AST parsing dominates the repository ratchet. This syntax-shaped text
    // gate keeps false positives cheap; the AST remains the source of truth.
    if (!hasTypeSuppressionTextCandidate(source)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
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
