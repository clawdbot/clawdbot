#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src", "extensions", "packages"];
const SOURCE_FILE_RE = /\.(?:ts|tsx)$/;
const SKIP_PATH_RE =
  /(?:^|\/)(?:node_modules|dist|build|protocol-generated)(?:\/|$)|(?:\.test|\.spec|\.e2e|\.generated)\.tsx?$/;
const DEPRECATED_SURFACE_COMMENT_RE =
  /^(?:back-compat alias|backward-compatible alias(?:es)?|deprecated alias|legacy alias|legacy field|legacy:\s|kept for compatibility with existing imports|keep the legacy helper name exported)\b/i;

function walk(dir, files = []) {
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

function leadingCommentText(sourceFile, node) {
  return (ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [])
    .map((range) => sourceFile.text.slice(range.pos, range.end))
    .join("\n");
}

function normalizeCommentText(comment) {
  return comment
    .replace(/\/\*\*?/g, "")
    .replace(/\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\*|\/\/)\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isExported(node) {
  return (
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    node.parent?.kind === ts.SyntaxKind.SourceFile
  );
}

function symbolName(node) {
  const declaration = node.declarationList?.declarations?.[0] ?? node;
  return declaration.name?.getText?.() ?? "<anonymous>";
}

function shouldInspectNode(node) {
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

function collectViolations(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations = [];

  function visit(node) {
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
