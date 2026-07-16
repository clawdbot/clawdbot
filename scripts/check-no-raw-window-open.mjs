#!/usr/bin/env node

// Ensures UI code opens external URLs through the safe helper.
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFiles,
  resolveRepoRoot,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const uiSourceDir = path.join(repoRoot, "ui", "src", "ui");
const allowedCallsites = new Set([path.join(uiSourceDir, "open-external-url.ts")]);

function isRawWindowOpenCall(expression) {
  const propertyAccess = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(propertyAccess) || propertyAccess.name.text !== "open") {
    return false;
  }

  const receiver = unwrapExpression(propertyAccess.expression);
  return (
    ts.isIdentifier(receiver) && (receiver.text === "window" || receiver.text === "globalThis")
  );
}

/**
 * Finds raw `window.open(...)` or `globalThis.open(...)` call lines.
 */
export function findRawWindowOpenLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isRawWindowOpenCall(node.expression)) {
      lines.push(toLine(sourceFile, node.expression));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return lines;
}

/**
 * Runs the raw window.open guard.
 */
export async function main() {
  const files = await collectTypeScriptFiles(uiSourceDir, {
    extraTestSuffixes: [".browser.test.ts", ".node.test.ts"],
    ignoreMissing: true,
  });
  const violations = [];

  for (const filePath of files) {
    if (allowedCallsites.has(filePath)) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    for (const line of findRawWindowOpenLines(content, filePath)) {
      const relPath = path.relative(repoRoot, filePath);
      violations.push(`${relPath}:${line}`);
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found raw window.open usage outside safe helper:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error("Use openExternalUrlSafe(...) from ui/src/lib/open-external-url.ts instead.");
  process.exit(1);
}

runAsScript(import.meta.url, main);
