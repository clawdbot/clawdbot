#!/usr/bin/env node

// Checks pairing config logic for account-scoped allowlist handling.
import ts from "typescript";
import { createPairingGuardContext } from "./lib/pairing-guard-context.mts";
import {
  collectFileViolations,
  getPropertyNameText,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mts";

const { repoRoot, sourceRoots } = createPairingGuardContext(import.meta.url);

function isUndefinedLikeExpression(node: ts.Node) {
  if (ts.isIdentifier(node) && node.text === "undefined") {
    return true;
  }
  return node.kind === ts.SyntaxKind.NullKeyword;
}

function hasRequiredAccountIdProperty(node: ts.Node) {
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "accountId") {
      return true;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (getPropertyNameText(property.name) !== "accountId") {
      continue;
    }
    if (isUndefinedLikeExpression(property.initializer)) {
      return false;
    }
    return true;
  }
  return false;
}

function findViolations(content: string, filePath: string) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const violations: { line: number; reason: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callName = node.expression.text;
      if (callName === "readChannelAllowFromStore") {
        const accountIdArgument = node.arguments[2];
        if (!accountIdArgument || isUndefinedLikeExpression(accountIdArgument)) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: "readChannelAllowFromStore call must pass explicit accountId as 3rd arg",
          });
        }
      } else if (callName === "upsertChannelPairingRequest") {
        const firstArg = node.arguments[0];
        if (!firstArg || !hasRequiredAccountIdProperty(firstArg)) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: "upsertChannelPairingRequest call must include accountId in params",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

async function main() {
  const violations = await collectFileViolations({
    sourceRoots,
    repoRoot,
    findViolations,
  });

  if (violations.length === 0) {
    return;
  }

  console.error("Found unscoped pairing-store calls:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line} (${violation.reason})`);
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
