#!/usr/bin/env tsx
/**
 * Copy HOOK.md files from src/hooks/bundled to dist/bundled
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

export function copyHookMetadata(
  params: {
    rootDir?: string;
    fs?: typeof fs;
    verbose?: boolean;
  } = {},
): number {
  const rootDir = params.rootDir ?? context.projectRoot;
  const fsImpl = params.fs ?? fs;
  const srcBundled = path.join(rootDir, "src", "hooks", "bundled");
  const distBundled = path.join(rootDir, "dist", "bundled");
  if (!fsImpl.existsSync(srcBundled)) {
    return 0;
  }

  fsImpl.mkdirSync(distBundled, { recursive: true });

  const entries = fsImpl.readdirSync(srcBundled, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const hookName = entry.name;
    const srcHookDir = path.join(srcBundled, hookName);
    const distHookDir = path.join(distBundled, hookName);
    const srcHookMd = path.join(srcHookDir, "HOOK.md");
    const distHookMd = path.join(distHookDir, "HOOK.md");

    if (!fsImpl.existsSync(srcHookMd)) {
      continue;
    }

    fsImpl.mkdirSync(distHookDir, { recursive: true });

    fsImpl.copyFileSync(srcHookMd, distHookMd);
    copiedCount += 1;
    if (params.verbose) {
      logVerboseCopy(context, `Copied ${hookName}/HOOK.md`);
    }
  }
  return copiedCount;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const copiedCount = copyHookMetadata({ verbose: true });
  console.log(`${context.prefix} Copied ${copiedCount} hook metadata files.`);
}
