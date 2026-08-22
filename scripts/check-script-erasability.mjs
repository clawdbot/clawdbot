#!/usr/bin/env node

// Verifies that script TypeScript uses Node's transformation-free syntax subset.
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPESCRIPT_IMPLEMENTATION_RE = /\.(?:cts|mts|ts)$/u;
const TYPESCRIPT_DECLARATION_RE = /\.d\.(?:cts|mts|ts)$/u;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function listTypeScriptImplementationFiles(rootDir) {
  const files = [];

  function visit(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .toSorted((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          visit(entryPath);
        }
        continue;
      }
      if (
        entry.isFile() &&
        TYPESCRIPT_IMPLEMENTATION_RE.test(entry.name) &&
        !TYPESCRIPT_DECLARATION_RE.test(entry.name)
      ) {
        files.push(entryPath);
      }
    }
  }

  visit(rootDir);
  return files;
}

function diagnosticLine(error, sourceUrl) {
  if (!(error instanceof Error) || !error.stack) {
    return undefined;
  }
  const firstLine = error.stack.split("\n", 1)[0];
  const prefix = `${sourceUrl}:`;
  if (!firstLine.startsWith(prefix)) {
    return undefined;
  }
  const line = Number.parseInt(firstLine.slice(prefix.length), 10);
  return Number.isFinite(line) ? line : undefined;
}

/**
 * Checks each TypeScript implementation file under a scripts tree without resolving imports.
 */
export function checkScriptErasability(rootDir = SCRIPT_ROOT) {
  const files = listTypeScriptImplementationFiles(rootDir);
  const rootLabel = path.basename(rootDir);
  const errors = [];

  for (const filePath of files) {
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
    const sourceUrl = `${rootLabel}/${relativePath}`;
    try {
      stripTypeScriptTypes(fs.readFileSync(filePath, "utf8"), {
        mode: "strip",
        sourceUrl,
      });
    } catch (error) {
      errors.push({
        file: sourceUrl,
        line: diagnosticLine(error, sourceUrl),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { checkedFiles: files.length, errors };
}

export function main() {
  const result = checkScriptErasability();
  if (result.errors.length === 0) {
    console.log(
      `[script-erasability] checked ${result.checkedFiles} TypeScript implementation files`,
    );
    return;
  }

  console.error(
    "TypeScript syntax under scripts/ must be erasable by Node without transformation:",
  );
  for (const error of result.errors) {
    const location = error.line === undefined ? error.file : `${error.file}:${error.line}`;
    console.error(`- ${location}: ${error.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
