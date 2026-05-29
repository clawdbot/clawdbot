#!/usr/bin/env tsx
/**
 * Copy the Copilot SDK install manifest (package.json + package-lock.json)
 * from src/commands/copilot-sdk-install-manifest/ to dist/commands/copilot-sdk-install-manifest/.
 *
 * The Copilot agent runtime's on-demand SDK installer
 * (src/commands/copilot-sdk-install.ts) resolves the manifest dir
 * relative to its compiled location via `import.meta.url`. tsdown does
 * not copy non-source files alongside compiled output, so we mirror the
 * manifest here as part of the build chain. Mirrors the precedent set
 * by scripts/copy-hook-metadata.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, logVerboseCopy, resolveBuildCopyContext } from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const SRC_MANIFEST_DIR = path.join(
  context.projectRoot,
  "src",
  "commands",
  "copilot-sdk-install-manifest",
);
const DIST_MANIFEST_DIR = path.join(
  context.projectRoot,
  "dist",
  "commands",
  "copilot-sdk-install-manifest",
);

const MANIFEST_FILES = ["package.json", "package-lock.json"];

function copyCopilotSdkManifest(): void {
  if (!fs.existsSync(SRC_MANIFEST_DIR)) {
    throw new Error(
      `${context.prefix} Source manifest dir missing: ${SRC_MANIFEST_DIR}. This directory is part of the Copilot agent runtime pinned install graph and must exist in the repo.`,
    );
  }

  ensureDirectory(DIST_MANIFEST_DIR);

  for (const fileName of MANIFEST_FILES) {
    const sourcePath = path.join(SRC_MANIFEST_DIR, fileName);
    const destPath = path.join(DIST_MANIFEST_DIR, fileName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `${context.prefix} Missing manifest file ${sourcePath}. Re-generate with \`npm install --package-lock-only\` in src/commands/copilot-sdk-install-manifest/.`,
      );
    }
    fs.copyFileSync(sourcePath, destPath);
    logVerboseCopy(context, `Copied copilot-sdk-install-manifest/${fileName}`);
  }

  console.log(
    `${context.prefix} Copied Copilot SDK install manifest (${MANIFEST_FILES.length} files).`,
  );
}

copyCopilotSdkManifest();
