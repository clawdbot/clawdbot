#!/usr/bin/env node

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

function readStringLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function isTypeOnlyImportDeclaration(node) {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name) {
    return false;
  }
  const bindings = clause.namedBindings;
  return (
    Boolean(bindings) &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function readDeclarationName(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  if (ts.isPropertyAssignment(node)) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
      return node.name.text;
    }
  }

  return null;
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

export function findDynamicImportAdvisories(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const staticRuntimeImports = new Map();
  const dynamicImports = new Map();
  const directExecuteImports = [];
  const declarationStack = [];

  const addLine = (map, specifier, line) => {
    const lines = map.get(specifier) ?? [];
    lines.push(line);
    map.set(specifier, lines);
  };

  const visit = (node) => {
    const declarationName = readDeclarationName(node);
    if (declarationName) {
      declarationStack.push(declarationName);
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyImportDeclaration(node)
    ) {
      addLine(staticRuntimeImports, node.moduleSpecifier.text, toLine(sourceFile, node));
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const specifier = readStringLiteral(node.arguments[0]);
      if (specifier) {
        const line = toLine(sourceFile, node);
        addLine(dynamicImports, specifier, line);
        if (declarationStack.includes("execute")) {
          directExecuteImports.push({
            line,
            reason: `direct dynamic import of "${specifier}" inside execute path; move it behind a cached loader`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
    if (declarationName) {
      declarationStack.pop();
    }
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

export async function collectDynamicImportAdvisories(options = {}) {
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
