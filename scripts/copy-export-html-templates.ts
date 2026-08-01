#!/usr/bin/env tsx
/**
 * Copy export-html templates from src to dist
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDirectory, logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";

const context = resolveBuildCopyContext(import.meta.url);

export function copyExportHtmlTemplates(params: { projectRoot?: string } = {}) {
  const projectRoot = params.projectRoot ?? context.projectRoot;
  const exportHtmlSrcDir = path.join(projectRoot, "src", "auto-reply", "reply", "export-html");
  const exportHtmlDistDir = path.join(projectRoot, "dist", "export-html");
  assertRealOutputRoot(path.join(projectRoot, "dist"));
  if (!fs.existsSync(exportHtmlSrcDir)) {
    console.warn(`${context.prefix} Source directory not found:`, exportHtmlSrcDir);
    return;
  }

  fs.rmSync(exportHtmlDistDir, { recursive: true, force: true });
  ensureDirectory(exportHtmlDistDir);
  let copiedCount = 0;

  const copyDir = (srcDir: string, distDir: string, relativePrefix = "") => {
    ensureDirectory(distDir);
    for (const file of fs.readdirSync(srcDir)) {
      const srcFile = path.join(srcDir, file);
      const distFile = path.join(distDir, file);
      const relativeName = path.join(relativePrefix, file);
      if (file.endsWith(".test.ts")) {
        continue;
      }
      if (fs.statSync(srcFile).isDirectory()) {
        copyDir(srcFile, distFile, relativeName);
        continue;
      }
      fs.copyFileSync(srcFile, distFile);
      copiedCount += 1;
      logVerboseCopy(context, `Copied ${relativeName}`);
    }
  };

  copyDir(exportHtmlSrcDir, exportHtmlDistDir);

  console.log(`${context.prefix} Copied ${copiedCount} export-html assets.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyExportHtmlTemplates();
}
