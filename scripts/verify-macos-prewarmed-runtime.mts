#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { collectExcludedPackagedExtensionDirs } from "./lib/packaged-extension-dirs.mts";

function parseArgs(argv: string[]): { repoRoot: string; runtimeBin: string; runtimeRoot: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: verify-macos-prewarmed-runtime --repo-root <dir> --runtime-root <dir> --runtime-bin <dir>",
      );
    }
    values.set(key, value);
  }
  const repoRoot = values.get("--repo-root");
  const runtimeRoot = values.get("--runtime-root");
  const runtimeBin = values.get("--runtime-bin");
  if (!repoRoot || !runtimeRoot || !runtimeBin || values.size !== 3) {
    throw new Error(
      "usage: verify-macos-prewarmed-runtime --repo-root <dir> --runtime-root <dir> --runtime-bin <dir>",
    );
  }
  return {
    repoRoot: path.resolve(repoRoot),
    runtimeBin: path.resolve(runtimeBin),
    runtimeRoot: path.resolve(runtimeRoot),
  };
}

function main(): void {
  const { repoRoot, runtimeBin, runtimeRoot } = parseArgs(process.argv.slice(2));
  if (!fs.statSync(runtimeRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Prewarmed runtime root is missing: ${runtimeRoot}`);
  }
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const externalizedDirs = collectExcludedPackagedExtensionDirs(packageJson);
  const bundledExternalizedDirs = [...externalizedDirs]
    .filter((dirName) => fs.existsSync(path.join(runtimeRoot, "dist", "extensions", dirName)))
    .toSorted();
  if (bundledExternalizedDirs.length > 0) {
    throw new Error(
      `Prewarmed runtime contains external plugins: ${bundledExternalizedDirs.join(", ")}`,
    );
  }
  if (fs.existsSync(path.join(runtimeBin, "codex"))) {
    throw new Error("Prewarmed runtime contains a managed Codex executable");
  }
  console.error("[prewarm] verified Stable-equivalent core runtime contents");
}

main();
