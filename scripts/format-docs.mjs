#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repairMintlifyAccordionIndentation } from "./lib/mintlify-accordion.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");
const OXFMT_BIN = path.join(ROOT, "node_modules", "oxfmt", "bin", "oxfmt");
const OXFMT_CONFIG = path.join(ROOT, ".oxfmtrc.jsonc");

function docsFiles() {
  const output = execFileSync("git", ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

function runOxfmt(files) {
  const result = spawnSync(
    process.execPath,
    [OXFMT_BIN, "--write", "--threads=1", "--config", OXFMT_CONFIG, ...files],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    },
  );

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`oxfmt failed${stderr ? `:\n${stderr}` : ""}`);
  }
}

function repairFiles(root, files) {
  const changed = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    const formatted = repairMintlifyAccordionIndentation(raw);
    if (formatted === raw) {
      continue;
    }
    fs.writeFileSync(absolutePath, formatted);
    changed.push(relativePath);
  }
  return changed;
}

function copyDocsToTemp(files) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-format-"));
  for (const relativePath of files) {
    const source = path.join(ROOT, relativePath);
    const target = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tempRoot;
}

const changed = [];
const files = docsFiles();

if (CHECK) {
  const tempRoot = copyDocsToTemp(files);
  try {
    runOxfmt(files.map((relativePath) => path.join(tempRoot, relativePath)));
    repairFiles(tempRoot, files);
    for (const relativePath of files) {
      const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
      const formatted = fs.readFileSync(path.join(tempRoot, relativePath), "utf8");
      if (formatted !== raw) {
        changed.push(relativePath);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
} else {
  runOxfmt(files);
  changed.push(...repairFiles(ROOT, files));
}

if (CHECK && changed.length > 0) {
  console.error(`Format issues found in ${changed.length} docs file(s):`);
  for (const relativePath of changed) {
    console.error(`- ${relativePath}`);
  }
  process.exit(1);
}

if (changed.length > 0) {
  console.log(`Formatted ${changed.length} docs file(s).`);
} else {
  console.log(`Docs formatting clean (${files.length} files).`);
}
