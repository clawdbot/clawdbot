#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const iosRoot = path.join(repoRoot, "apps", "ios");
const outputPath = path.join(iosRoot, "SwiftSources.input.xcfilelist");

const iosSourceRoots = [
  "Sources",
  "ShareExtension",
  "ActivityWidget",
  path.join("WatchApp", "Sources"),
];

const sharedSourceRoots = [
  path.join("..", "shared", "OpenClawKit", "Sources", "OpenClawChatUI"),
  path.join("..", "shared", "OpenClawKit", "Sources", "OpenClawKit"),
  path.join("..", "shared", "OpenClawKit", "Sources", "OpenClawNativeState"),
  path.join("..", "shared", "OpenClawKit", "Sources", "OpenClawProtocol"),
  path.join("..", "swabble", "Sources", "SwabbleKit"),
];

const excludedSwiftFiles = new Set([
  "../shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
]);

function normalizeFileListPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function collectSwiftFiles(rootRelativePath: string): string[] {
  const root = path.join(iosRoot, rootRelativePath);
  if (!existsSync(root)) {
    throw new Error(`Missing Swift source root: ${rootRelativePath}`);
  }

  const entries: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".swift")) {
        entries.push(normalizeFileListPath(path.relative(iosRoot, fullPath)));
      }
    }
  };
  visit(root);
  return entries;
}

function writeGeneratedFile(filePath: string, contents: string): void {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked file: ${filePath}`);
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

const iosFiles = iosSourceRoots.flatMap(collectSwiftFiles);
const sharedFiles = sharedSourceRoots.flatMap(collectSwiftFiles);
const fileList = [...new Set([...iosFiles, ...sharedFiles])]
  .filter((filePath) => !excludedSwiftFiles.has(filePath))
  .toSorted((left, right) => left.localeCompare(right));

writeGeneratedFile(outputPath, `${fileList.join("\n")}\n`);
process.stdout.write(`Prepared iOS Swift file list: ${path.relative(repoRoot, outputPath)}\n`);
