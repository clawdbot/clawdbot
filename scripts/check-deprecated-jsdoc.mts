#!/usr/bin/env node
// Checks deprecated JSDoc blocks for required migration details.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const require = createRequire(import.meta.url);
const ts: typeof import("typescript") = require("typescript");

const repoRoot = resolveRepoRoot(import.meta.url);
const SCAN_ROOTS = ["src", "extensions", "packages"];
const SOURCE_FILE_RE = /\.(?:ts|tsx)$/;
const SKIP_PATH_RE =
  /(?:^|\/)(?:node_modules|dist|build|protocol-generated)(?:\/|$)|(?:\.test|\.spec|\.e2e|\.generated)\.tsx?$/;
const DEPRECATED_SURFACE_COMMENT_RE =
  /^(?:back-compat alias|backward-compatible alias(?:es)?|deprecated alias|legacy alias|legacy field|legacy:\s|kept for compatibility with existing imports|keep the legacy helper name exported)\b/i;

function walk(dir: string, files: string[] = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    if (SKIP_PATH_RE.test(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(filePath, files);
    } else if (SOURCE_FILE_RE.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}

function leadingCommentText(sourceFile: Ts.SourceFile, node: Ts.Node) {
  return (ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [])
    .map((range) => sourceFile.text.slice(range.pos, range.end))
    .join("\n");
}

function normalizeCommentText(comment: string) {
  return comment
    .replace(/\/\*\*?/g, "")
    .replace(/\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*|\/\/)\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function lineOf(sourceFile: Ts.SourceFile, node: Ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isExported(node: Ts.Node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    node.parent?.kind === ts.SyntaxKind.SourceFile
  );
}

type InspectedNode = Ts.Declaration | Ts.VariableStatement;
type Violation = { filePath: string; line: number; name: string };

function symbolName(node: InspectedNode) {
  const declaration = ts.isVariableStatement(node) ? node.declarationList.declarations[0] : node;
  return ts.getNameOfDeclaration(declaration)?.getText() ?? "<anonymous>";
}

function shouldInspectNode(node: Ts.Node): node is InspectedNode {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node)
  ) {
    return isExported(node);
  }
  return (
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isEnumMember(node)
  );
}

function collectViolations(filePath: string) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  function visit(node: Ts.Node) {
    if (shouldInspectNode(node)) {
      const comment = leadingCommentText(sourceFile, node);
      const normalizedComment = normalizeCommentText(comment);
      if (
        normalizedComment &&
        DEPRECATED_SURFACE_COMMENT_RE.test(normalizedComment) &&
        !/@deprecated\b/.test(comment)
      ) {
        violations.push({
          line: lineOf(sourceFile, node),
          name: symbolName(node),
          filePath: path.relative(repoRoot, filePath).replaceAll(path.sep, "/"),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

const violations = SCAN_ROOTS.flatMap((root) =>
  walk(path.join(repoRoot, root)).flatMap(collectViolations),
);

if (violations.length > 0) {
  console.error("Deprecated JSDoc guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.line} ${violation.name}`);
  }
  console.error(
    "Add an @deprecated JSDoc tag or reword the comment if the symbol is not deprecated.",
  );
  process.exitCode = 1;
} else {
  console.log("deprecated JSDoc guard passed");
}
