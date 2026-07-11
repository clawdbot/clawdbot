#!/usr/bin/env node

import ts from "typescript";
import {
  collectFileViolations,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const removedAsyncTransactionNames = new Set([
  "runOpenClawAgentWriteTransactionAsync",
  "runSqliteImmediateTransactionAsync",
]);
const synchronousTransactionCallbackIndexes = new Map([
  ["runOpenClawAgentWriteTransaction", 0],
  ["runSqliteImmediateTransactionSync", 1],
]);

function expressionName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isStringLiteral(unwrapped.argumentExpression)) {
    return unwrapped.argumentExpression.text;
  }
  return undefined;
}

function hasAsyncModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function collectLocalAsyncFunctionNames(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && hasAsyncModifier(node)) {
      names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        hasAsyncModifier(initializer)
      ) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function collectSynchronousTransactionAliases(sourceFile) {
  const aliases = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (synchronousTransactionCallbackIndexes.has(importedName)) {
        aliases.set(specifier.name.text, importedName);
      }
    }
  }
  return aliases;
}

function isAsyncCallback(expression, localAsyncFunctionNames) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return hasAsyncModifier(unwrapped);
  }
  return ts.isIdentifier(unwrapped) && localAsyncFunctionNames.has(unwrapped.text);
}

export function findSqliteTransactionBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const localAsyncFunctionNames = collectLocalAsyncFunctionNames(sourceFile);
  const transactionAliases = collectSynchronousTransactionAliases(sourceFile);
  const violations = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (removedAsyncTransactionNames.has(importedName)) {
            violations.push({
              line: toLine(sourceFile, specifier),
              reason: `imports removed async SQLite transaction primitive "${importedName}"`,
            });
          }
        }
      }
    }

    if (
      ((ts.isFunctionDeclaration(node) && node.name) ||
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))) &&
      removedAsyncTransactionNames.has(node.name.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `declares removed async SQLite transaction primitive "${node.name.text}"`,
      });
    }

    if (ts.isCallExpression(node)) {
      const calledName = expressionName(node.expression);
      if (calledName && removedAsyncTransactionNames.has(calledName)) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls removed async SQLite transaction primitive "${calledName}"`,
        });
      }
      const canonicalName = calledName
        ? (transactionAliases.get(calledName) ?? calledName)
        : undefined;
      const callbackIndex = canonicalName
        ? synchronousTransactionCallbackIndexes.get(canonicalName)
        : undefined;
      const callback = callbackIndex === undefined ? undefined : node.arguments[callbackIndex];
      if (canonicalName && callback && isAsyncCallback(callback, localAsyncFunctionNames)) {
        violations.push({
          line: toLine(sourceFile, callback),
          reason: `passes an async callback to synchronous SQLite transaction helper "${canonicalName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const violations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src", "extensions", "packages"]),
    skipFile: (filePath) => /(^|[\\/])dist([\\/]|$)/.test(filePath),
    findViolations: findSqliteTransactionBoundaryViolations,
  });
  if (violations.length === 0) {
    console.log("SQLite transaction boundary guard passed.");
    return;
  }
  console.error("Found asynchronous SQLite transaction work:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Complete asynchronous preparation before the transaction, then validate and apply inside a synchronous transaction callback.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
