// Check No Extension Src Imports script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mjs";

const FORBIDDEN_REPO_SRC_IMPORT = /["'](?:\.\.\/)+(?:src\/)[^"']+["']/;

function collectExtensionSourceFiles(rootDir: string): string[] {
  return collectFilesSync(rootDir, {
    includeFile: (filePath) =>
      isCodeFile(filePath) && classifyBundledExtensionSourcePath(filePath).isProductionSource,
  });
}

function main() {
  const extensionsDir = path.join(process.cwd(), "extensions");
  const files = collectExtensionSourceFiles(extensionsDir);
  const offenders: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    if (FORBIDDEN_REPO_SRC_IMPORT.test(content)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    console.error("Production extension files must not import the repo src/ tree directly.");
    for (const offender of offenders.toSorted()) {
      console.error(`- ${relativeToCwd(offender)}`);
    }
    console.error(
      "Publish a focused openclaw/plugin-sdk/<subpath> surface or use the extension's own public barrel instead.",
    );
    process.exit(1);
  }

  console.log(
    `OK: production extension files avoid direct repo src/ imports (${files.length} checked).`,
  );
}

main();
