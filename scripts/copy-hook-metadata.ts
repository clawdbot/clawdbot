#!/usr/bin/env tsx
/**
 * Copy HOOK.md files from src/hooks/bundled to dist/bundled
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

type CopyHookMetadataParams = {
  rootDir?: string;
  fs?: typeof fs;
  verbose?: boolean;
};

function listHookMetadataFiles(rootDir: string, fsImpl: typeof fs) {
  const sourceRoot = path.join(rootDir, "src", "hooks", "bundled");
  if (!fsImpl.existsSync(sourceRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      source: path.join(sourceRoot, entry.name, "HOOK.md"),
      target: path.join(rootDir, "dist", "bundled", entry.name, "HOOK.md"),
    }))
    .filter(({ source }) => fsImpl.existsSync(source));
}

export function listHookMetadataOutputs(params: CopyHookMetadataParams = {}): string[] {
  const rootDir = params.rootDir ?? context.projectRoot;
  const fsImpl = params.fs ?? fs;
  return listHookMetadataFiles(rootDir, fsImpl).map(({ target }) =>
    path.relative(rootDir, target).replaceAll(path.sep, "/"),
  );
}

export function copyHookMetadata(params: CopyHookMetadataParams = {}): number {
  const rootDir = params.rootDir ?? context.projectRoot;
  const fsImpl = params.fs ?? fs;
  let copiedCount = 0;
  for (const { source, target } of listHookMetadataFiles(rootDir, fsImpl)) {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(source, target);
    copiedCount += 1;
    if (params.verbose) {
      logVerboseCopy(context, `Copied ${path.basename(path.dirname(target))}/HOOK.md`);
    }
  }
  return copiedCount;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const copiedCount = copyHookMetadata({ verbose: true });
  console.log(`${context.prefix} Copied ${copiedCount} hook metadata files.`);
}
