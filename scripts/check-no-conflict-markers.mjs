#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFLICT_MARKER_GREP_PATTERN = "^(<<<<<<< |\\|\\|\\|\\|\\|\\|\\| |=======$|>>>>>>> )";

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

export function findConflictMarkerLines(content) {
  const lines = content.split(/\r?\n/u);
  const matches = [];
  for (const [index, line] of lines.entries()) {
    if (
      line.startsWith("<<<<<<< ") ||
      line.startsWith("||||||| ") ||
      line === "=======" ||
      line.startsWith(">>>>>>> ")
    ) {
      matches.push(index + 1);
    }
  }
  return matches;
}

export function listTrackedFiles(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => path.join(cwd, relativePath));
}

export function findConflictMarkersInFiles(filePaths, readFile = fs.readFileSync) {
  const violations = [];
  for (const filePath of filePaths) {
    let content;
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    if (!Buffer.isBuffer(content)) {
      content = Buffer.from(String(content));
    }
    if (isBinaryBuffer(content)) {
      continue;
    }
    const lines = findConflictMarkerLines(content.toString("utf8"));
    if (lines.length > 0) {
      violations.push({
        filePath,
        lines,
      });
    }
  }
  return violations;
}

export function listTrackedFilesWithConflictMarkerCandidates(
  cwd = process.cwd(),
  run = spawnSync,
) {
  const result = run(
    "git",
    ["grep", "-l", "-z", "-I", "-E", CONFLICT_MARKER_GREP_PATTERN, "--", "."],
    {
      cwd,
      encoding: "buffer",
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8").trim();
    throw new Error(stderr || `git grep failed with status ${result.status ?? "unknown"}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => path.join(cwd, relativePath));
}

export function findConflictMarkersInTrackedFiles(cwd = process.cwd()) {
  return findConflictMarkersInFiles(listTrackedFilesWithConflictMarkerCandidates(cwd));
}

export async function main() {
  const cwd = process.cwd();
  const violations = findConflictMarkersInTrackedFiles(cwd);
  if (violations.length === 0) {
    return;
  }

  console.error("Found unresolved merge conflict markers:");
  for (const violation of violations) {
    const relativePath = path.relative(cwd, violation.filePath) || violation.filePath;
    console.error(`- ${relativePath}:${violation.lines.join(",")}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
