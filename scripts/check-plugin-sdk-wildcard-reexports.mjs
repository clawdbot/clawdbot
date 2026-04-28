#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsRoot = path.join(repoRoot, "extensions");

const WILDCARD_PLUGIN_SDK_REEXPORT_PATTERN =
  /^\s*export\s+(?:type\s+)?\*\s+from\s+["']openclaw\/plugin-sdk\//u;

async function listExtensionApiFiles(rootDir = extensionsRoot) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const fileName of ["api.ts", "runtime-api.ts"]) {
      const filePath = path.join(rootDir, entry.name, fileName);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          files.push(filePath);
        }
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

export function findPluginSdkWildcardReexports(source) {
  return source
    .split(/\r?\n/u)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => WILDCARD_PLUGIN_SDK_REEXPORT_PATTERN.test(text));
}

export async function collectPluginSdkWildcardReexports(rootDir = repoRoot) {
  const files = await listExtensionApiFiles(path.join(rootDir, "extensions"));
  const violations = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    for (const match of findPluginSdkWildcardReexports(source)) {
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
  const violations = await collectPluginSdkWildcardReexports();

  if (json) {
    io.stdout.write(`${JSON.stringify(violations, null, 2)}\n`);
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    io.stdout.write("No plugin-sdk wildcard re-exports found in extension API barrels.\n");
    return 0;
  }

  io.stderr.write("Found plugin-sdk wildcard re-exports in extension API barrels:\n");
  for (const violation of violations) {
    io.stderr.write(`- ${violation.file}:${violation.line} ${violation.text}\n`);
  }
  io.stderr.write("Use explicit named exports from the narrow SDK subpath instead.\n");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
