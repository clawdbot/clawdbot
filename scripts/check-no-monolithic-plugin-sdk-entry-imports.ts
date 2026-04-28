import fs from "node:fs";
import path from "node:path";
import { discoverOpenClawPlugins } from "../src/plugins/discovery.js";
import { collectFilesSync, isCodeFile, relativeToCwd } from "./check-file-utils.js";

// Match exact monolithic-root specifier in any code path:
// imports/exports, require/dynamic import, and test mocks (vi.mock/jest.mock).
const ROOT_IMPORT_PATTERN = /["']openclaw\/plugin-sdk["']/;
const LEGACY_COMPAT_IMPORT_PATTERN = /["']openclaw\/plugin-sdk\/compat["']/;
const LEGACY_BROAD_SUBPATH_PATTERNS = [
  {
    pattern: /["']openclaw\/plugin-sdk\/channel-runtime["']/,
    label: "openclaw/plugin-sdk/channel-runtime",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/config-runtime["']/,
    label: "openclaw/plugin-sdk/config-runtime",
  },
  {
    pattern: /["']openclaw\/plugin-sdk\/infra-runtime["']/,
    label: "openclaw/plugin-sdk/infra-runtime",
  },
] as const;

function hasMonolithicRootImport(content: string): boolean {
  return ROOT_IMPORT_PATTERN.test(content);
}

function hasLegacyCompatImport(content: string): boolean {
  return LEGACY_COMPAT_IMPORT_PATTERN.test(content);
}

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
  let entries: fs.Dirent[] = [];
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

  const monolithicOffenders: string[] = [];
  const legacyCompatOffenders: string[] = [];
  const legacyBroadSubpathOffenders = new Map<string, string[]>();
  for (const entryFile of filesToCheck) {
    let content = "";
    try {
      content = fs.readFileSync(entryFile, "utf8");
    } catch {
      continue;
    }
    if (hasMonolithicRootImport(content)) {
      monolithicOffenders.push(entryFile);
    }
    if (hasLegacyCompatImport(content)) {
      legacyCompatOffenders.push(entryFile);
    }
    const legacyBroadSubpaths = findLegacyBroadSubpathImports(content);
    if (legacyBroadSubpaths.length > 0) {
      legacyBroadSubpathOffenders.set(entryFile, legacyBroadSubpaths);
    }
  }

  if (
    monolithicOffenders.length > 0 ||
    legacyCompatOffenders.length > 0 ||
    legacyBroadSubpathOffenders.size > 0
  ) {
    if (monolithicOffenders.length > 0) {
      console.error("Bundled plugin source files must not import monolithic openclaw/plugin-sdk.");
      for (const file of monolithicOffenders.toSorted()) {
        console.error(`- ${relativeToCwd(file)}`);
      }
    }
    if (legacyCompatOffenders.length > 0) {
      console.error(
        "Bundled plugin source files must not import legacy openclaw/plugin-sdk/compat.",
      );
      for (const file of legacyCompatOffenders.toSorted()) {
        console.error(`- ${relativeToCwd(file)}`);
      }
    }
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
    if (
      monolithicOffenders.length > 0 ||
      legacyCompatOffenders.length > 0 ||
      legacyBroadSubpathOffenders.size > 0
    ) {
      console.error(
        "Use focused openclaw/plugin-sdk/<domain> subpaths for bundled plugins; root, compat, and broad runtime barrels are legacy surfaces only.",
      );
    }
    process.exit(1);
  }

  console.log(
    `OK: bundled plugin source files use scoped plugin-sdk subpaths (${filesToCheck.size} checked).`,
  );
}

main();
