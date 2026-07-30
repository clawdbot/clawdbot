#!/usr/bin/env node

// Advises on ineffective or suspicious dynamic import patterns.
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const defaultRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "extensions")];

function isTypeOnlyImportDeclaration(node) {
  const clause = node.importClause;
  return Boolean(
    clause &&
    (ts.isTypeOnlyImportDeclaration(clause) ||
      (!clause.name &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every(ts.isTypeOnlyImportOrExportDeclaration))),
  );
}

function isTypeOnlyExportDeclaration(node) {
  const clause = node.exportClause;
  return (
    node.isTypeOnly === true ||
    Boolean(
      clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every(ts.isTypeOnlyImportOrExportDeclaration),
    )
  );
}

function isExecuteDeclaration(node) {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isVariableDeclaration(node) &&
    !ts.isPropertyAssignment(node)
  ) {
    return false;
  }
  const name = ts.getNameOfDeclaration(node);
  return Boolean(
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "execute",
  );
}

function isIgnoredTestHelperContent(content) {
  return /\bfrom\s+["']vitest["']/.test(content) || /\bfrom\s+["']@vitest\//.test(content);
}

function isIgnoredTestHelperPath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  const base = path.basename(filePath);
  return (
    normalized.includes("/test/") ||
    /(?:^|[./-])test(?:[./-]|$)/.test(base) ||
    base.includes("test-support") ||
    base.includes("test-harness") ||
    base.includes("test-helper") ||
    base.includes("test-mocks")
  );
}

/**
 * Finds dynamic import advisories in a single source file.
 */
export function findDynamicImportAdvisories(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const staticRuntimeImports = new Map();
  const dynamicImports = new Map();
  const directExecuteImports = [];

  const addLine = (map, specifier, line) => {
    const lines = map.get(specifier) ?? [];
    lines.push(line);
    map.set(specifier, lines);
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyImportDeclaration(node)
    ) {
      addLine(staticRuntimeImports, node.moduleSpecifier.text, toLine(sourceFile, node));
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyExportDeclaration(node)
    ) {
      addLine(staticRuntimeImports, node.moduleSpecifier.text, toLine(sourceFile, node));
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const specifier = ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null;
      if (specifier) {
        const line = toLine(sourceFile, node);
        addLine(dynamicImports, specifier, line);
        if (ts.findAncestor(node, isExecuteDeclaration)) {
          directExecuteImports.push({
            line,
            reason: `direct dynamic import of "${specifier}" inside execute path; move it behind a cached loader`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const advisories = [...directExecuteImports];
  for (const [specifier, dynamicLines] of dynamicImports) {
    const staticLines = staticRuntimeImports.get(specifier);
    if (staticLines?.length) {
      advisories.push({
        line: dynamicLines[0],
        reason: `runtime static + dynamic import of "${specifier}" (static line ${staticLines[0]})`,
      });
    }
    if (dynamicLines.length > 1) {
      advisories.push({
        line: dynamicLines[0],
        reason: `repeated direct dynamic import of "${specifier}" (${dynamicLines.length} callsites: ${dynamicLines.join(", ")})`,
      });
    }
  }
  return advisories;
}

/**
 * Collects dynamic import advisories across configured source roots.
 */
async function collectDynamicImportAdvisories(options = {}) {
  const roots = options.roots ?? defaultRoots;
  const files = await collectTypeScriptFilesFromRoots(roots, {
    extraTestSuffixes: [".suite.ts"],
  });
  const advisories = [];
  for (const filePath of files) {
    if (isIgnoredTestHelperPath(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    if (isIgnoredTestHelperContent(content)) {
      continue;
    }
    for (const advisory of findDynamicImportAdvisories(content, filePath)) {
      advisories.push({
        path: path.relative(repoRoot, filePath),
        ...advisory,
      });
    }
  }
  return advisories;
}

/**
 * Runs the dynamic import advisory check.
 */
export async function main(argv = process.argv.slice(2)) {
  const fail = argv.includes("--fail");
  const json = argv.includes("--json");
  const advisories = await collectDynamicImportAdvisories();

  if (json) {
    console.log(JSON.stringify({ advisories }, null, 2));
  } else if (advisories.length === 0) {
    console.log("No dynamic import advisories found.");
  } else {
    console.log(`Dynamic import advisories (${advisories.length}):`);
    for (const advisory of advisories) {
      console.log(`- ${advisory.path}:${advisory.line} ${advisory.reason}`);
    }
    console.log("Advisory only. Use --fail when ratcheting this into a hard check.");
  }

  if (fail && advisories.length > 0) {
    process.exit(1);
  }
}

runAsScript(import.meta.url, main);
