#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_WILDCARD_REEXPORT_PATTERN = /^\s*export\s+(?:type\s+)?\*\s+from\s+["'](?:\.{1,2}\/)/u;

async function walkFiles(rootDir, predicate) {
  const files = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (entry.isFile() && predicate(filePath)) {
        files.push(filePath);
      }
    }
  }
  await visit(rootDir);
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function listGuardedFiles(rootDir = repoRoot) {
  return walkFiles(
    path.join(rootDir, "extensions"),
    (filePath) =>
      filePath.endsWith(`${path.sep}runtime-api.ts`) || filePath.endsWith(`${path.sep}api.ts`),
  );
}

export function findLocalWildcardReexports(source) {
  return source
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => LOCAL_WILDCARD_REEXPORT_PATTERN.test(text));
}

export async function collectExtensionWildcardReexports(rootDir = repoRoot) {
  const files = await listGuardedFiles(rootDir);
  const violations = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    for (const match of findLocalWildcardReexports(source)) {
      violations.push({
        file: path.relative(rootDir, filePath).split(path.sep).join("/"),
        line: match.line,
        text: match.text.trim(),
      });
    }
  }
  return violations;
}

export async function main(argv = process.argv.slice(2), io = process) {
  const json = argv.includes("--json");
  const violations = await collectExtensionWildcardReexports();

  if (json) {
    io.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    io.stdout.write("No guarded extension wildcard re-exports found.\n");
    return 0;
  }

  io.stderr.write("Found guarded extension wildcard re-exports:\n");
  for (const violation of violations) {
    io.stderr.write(`- ${violation.file}:${violation.line} ${violation.text}\n`);
  }
  io.stderr.write("Use explicit named exports so runtime and public API barrels stay pinned.\n");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
