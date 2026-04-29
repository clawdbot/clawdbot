#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { collectPackageDistImportErrors } from "./lib/package-dist-imports.mjs";

function usage() {
  return "Usage: node scripts/check-package-dist-imports.mjs [package-root]";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const packageRoot = path.resolve(process.argv[2] ?? process.cwd());
if (process.argv.length > 3) {
  fail(usage());
}

const distRoot = path.join(packageRoot, "dist");
if (!fs.existsSync(distRoot)) {
  fail(`missing dist directory: ${distRoot}`);
}

function collectFiles(rootDir) {
  const pending = [rootDir];
  const files = [];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(packageRoot, entryPath).replace(/\\/gu, "/"));
      }
    }
  }
  return files;
}

const errors = collectPackageDistImportErrors({
  files: collectFiles(distRoot),
  readText(relativePath) {
    return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
  },
});

if (errors.length > 0) {
  fail(`OpenClaw package dist import closure failed:\n${errors.join("\n")}`);
}

console.log("OpenClaw package dist import closure passed.");
