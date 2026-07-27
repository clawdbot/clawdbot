// Check No Monolithic Plugin Sdk Entry Imports script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { discoverOpenClawPlugins } from "../src/plugins/discovery.js";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";

const LEGACY_BROAD_SUBPATH_PATTERNS = [
  {
    pattern: /["']openclaw\/plugin-sdk\/config-runtime["']/,
    label: "openclaw/plugin-sdk/config-runtime",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/infra-runtime["']/,
    label: "openclaw/plugin-sdk/infra-runtime",
  },
] as const;

function findLegacyBroadSubpathImports(content: string): string[] {
  return LEGACY_BROAD_SUBPATH_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ label }) => label,
  );
}

function collectPluginSourceFiles(rootDir: string): string[] {
  const srcDir = path.join(rootDir, "src");
  if (!fs.existsSync(srcDir)) {
    return [];
  }
  return collectFilesSync(srcDir, {
    includeFile: (filePath) => isCodeFile(filePath),
    skipDirNames: new Set(["node_modules", "dist", ".git", "coverage"]),
  });
}

function collectSharedExtensionSourceFiles(): string[] {
  return collectPluginSourceFiles(path.join(process.cwd(), "extensions", "shared"));
}

function collectBundledExtensionSourceFiles(): string[] {
  const extensionsDir = path.join(process.cwd(), "extensions");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") {
      continue;
    }
    for (const srcFile of collectPluginSourceFiles(path.join(extensionsDir, entry.name))) {
      files.push(srcFile);
    }
  }
  return files;
}

function main() {
  const discovery = discoverOpenClawPlugins({});
  const bundledCandidates = discovery.candidates.filter((c) => c.origin === "bundled");
  const filesToCheck = new Set<string>();
  for (const candidate of bundledCandidates) {
    filesToCheck.add(candidate.source);
    for (const srcFile of collectPluginSourceFiles(candidate.rootDir)) {
      filesToCheck.add(srcFile);
    }
  }
  for (const sharedFile of collectSharedExtensionSourceFiles()) {
    filesToCheck.add(sharedFile);
  }
  for (const extensionFile of collectBundledExtensionSourceFiles()) {
    filesToCheck.add(extensionFile);
  }

  const legacyBroadSubpathOffenders = new Map<string, string[]>();
  for (const entryFile of filesToCheck) {
    let content;
    try {
      content = fs.readFileSync(entryFile, "utf8");
    } catch {
      continue;
    }
    const legacyBroadSubpaths = findLegacyBroadSubpathImports(content);
    if (legacyBroadSubpaths.length > 0) {
      legacyBroadSubpathOffenders.set(entryFile, legacyBroadSubpaths);
    }
  }

  if (legacyBroadSubpathOffenders.size > 0) {
    if (legacyBroadSubpathOffenders.size > 0) {
      console.error(
        "Bundled plugin source files must not import deprecated broad plugin-sdk subpaths.",
      );
      for (const [file, labels] of [...legacyBroadSubpathOffenders.entries()].toSorted(
        ([left], [right]) => left.localeCompare(right),
      )) {
        console.error(`- ${relativeToCwd(file)} (${labels.join(", ")})`);
      }
    }
    console.error("Use focused openclaw/plugin-sdk/<domain> subpaths for bundled plugins.");
    process.exit(1);
  }

  console.log(
    `OK: bundled plugin source files avoid deprecated broad plugin-sdk subpaths (${filesToCheck.size} checked).`,
  );
}

main();
