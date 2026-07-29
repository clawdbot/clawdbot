#!/usr/bin/env tsx
/**
 * Copy HOOK.md files from src/hooks/bundled to dist/bundled
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const srcBundled = path.join(context.projectRoot, "src", "hooks", "bundled");
const distBundled = path.join(context.projectRoot, "dist", "bundled");

function copyHookMetadata() {
  if (!fs.existsSync(srcBundled)) {
    console.warn(`${context.prefix} Source directory not found:`, srcBundled);
    return;
  }

  ensureDirectory(distBundled);

  const entries = fs.readdirSync(srcBundled, { withFileTypes: true });
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

    if (!fs.existsSync(srcHookMd)) {
      console.warn(`${context.prefix} No HOOK.md found for ${hookName}`);
      continue;
    }

    ensureDirectory(distHookDir);

    fs.copyFileSync(srcHookMd, distHookMd);
    copiedCount += 1;
    logVerboseCopy(context, `Copied ${hookName}/HOOK.md`);
  }

  console.log(`${context.prefix} Copied ${copiedCount} hook metadata files.`);
}

copyHookMetadata();
