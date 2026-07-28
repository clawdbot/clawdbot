#!/usr/bin/env node

// Keeps the native OpenClawKit Canvas A2UI resources in sync with the plugin-owned bundle.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_RESOURCE_FILES = ["a2ui.bundle.js", "index.html"];

export function getNativeA2uiResourcePaths(repoRoot = rootDir) {
  return {
    sourceDir: path.join(repoRoot, "extensions", "canvas", "src", "host", "a2ui"),
    nativeDir: path.join(
      repoRoot,
      "apps",
      "shared",
      "OpenClawKit",
      "Sources",
      "OpenClawKit",
      "Resources",
      "CanvasA2UI",
    ),
    linuxConsumerFile: path.join(repoRoot, "apps", "linux", "src-tauri", "src", "canvas.rs"),
  };
}

export async function checkLinuxCanvasA2uiReferences({ linuxConsumerFile }) {
  const source = await fs.readFile(linuxConsumerFile, "utf8");
  const expectedReferences = [
    "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/index.html",
    "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js",
  ];
  const missing = expectedReferences.filter((reference) => !source.includes(reference));
  if (missing.length > 0) {
    throw new Error(
      `Linux Canvas must embed the synced native A2UI resources.\nMissing references:\n${formatList(missing)}`,
    );
  }
}

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function listRelativeFiles(dir, baseDir = dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(entryPath, baseDir)));
      continue;
    }
    files.push(normalizeRelativePath(path.relative(baseDir, entryPath)));
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function formatList(values) {
  return values.length === 0 ? "(none)" : values.map((value) => `- ${value}`).join("\n");
}

async function assertSourceResourcesExist(sourceDir) {
  const missing = [];
  for (const fileName of REQUIRED_RESOURCE_FILES) {
    try {
      await fs.stat(path.join(sourceDir, fileName));
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing.push(fileName);
        continue;
      }
      throw error;
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing generated A2UI resources. Run "pnpm canvas:a2ui:bundle".\nMissing:\n${formatList(missing)}`,
    );
  }
}

export async function syncNativeA2uiResources({ sourceDir, nativeDir }) {
  await assertSourceResourcesExist(sourceDir);
  await fs.rm(nativeDir, { recursive: true, force: true });
  await fs.mkdir(nativeDir, { recursive: true });
  for (const fileName of REQUIRED_RESOURCE_FILES) {
    await fs.copyFile(path.join(sourceDir, fileName), path.join(nativeDir, fileName));
  }
}

export async function checkNativeA2uiResources({ sourceDir, nativeDir }) {
  await assertSourceResourcesExist(sourceDir);
  const actualFiles = await listRelativeFiles(nativeDir);
  const expectedFiles = [...REQUIRED_RESOURCE_FILES].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const missing = expectedFiles.filter((fileName) => !actualFiles.includes(fileName));
  const unexpected = actualFiles.filter((fileName) => !expectedFiles.includes(fileName));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        'Native A2UI resource tree is stale. Run "pnpm canvas:a2ui:native:sync".',
        `Missing:\n${formatList(missing)}`,
        `Unexpected:\n${formatList(unexpected)}`,
      ].join("\n"),
    );
  }

  const mismatched = [];
  for (const fileName of expectedFiles) {
    const [source, native] = await Promise.all([
      fs.readFile(path.join(sourceDir, fileName)),
      fs.readFile(path.join(nativeDir, fileName)),
    ]);
    if (!source.equals(native)) {
      mismatched.push(fileName);
    }
  }
  if (mismatched.length > 0) {
    throw new Error(
      `Native A2UI resources differ from generated source. Run "pnpm canvas:a2ui:native:sync".\nMismatched:\n${formatList(mismatched)}`,
    );
  }
}

function parseMode(argv) {
  const check = argv.includes("--check");
  const write = argv.includes("--write");
  if (check === write) {
    throw new Error("Usage: node scripts/sync-native-a2ui.mjs --check|--write");
  }
  return write ? "write" : "check";
}

function bundleA2ui(repoRoot = rootDir, env = process.env) {
  const result = spawnSync(process.execPath, ["scripts/bundle-a2ui.mjs"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("A2UI bundling failed before native resource sync.");
  }
}

async function withFreshBundleCheckSource(sourceDir, run) {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-a2ui-native-check-"));
  try {
    const checkSourceDir = path.join(tempDir, "a2ui");
    await fs.mkdir(checkSourceDir, { recursive: true });
    await fs.copyFile(path.join(sourceDir, "index.html"), path.join(checkSourceDir, "index.html"));
    bundleA2ui(rootDir, {
      ...process.env,
      OPENCLAW_A2UI_BUNDLE_OUT: path.join(checkSourceDir, "a2ui.bundle.js"),
      OPENCLAW_A2UI_BUNDLE_HASH_FILE: path.join(tempDir, ".bundle.hash"),
    });
    await run(checkSourceDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const paths = getNativeA2uiResourcePaths();
  if (mode === "write") {
    bundleA2ui();
    await syncNativeA2uiResources(paths);
    console.log("[canvas] native A2UI resources synced.");
    return;
  }
  await withFreshBundleCheckSource(paths.sourceDir, async (sourceDir) => {
    await checkNativeA2uiResources({ sourceDir, nativeDir: paths.nativeDir });
  });
  await checkLinuxCanvasA2uiReferences(paths);
  console.log("[canvas] native A2UI resources up to date.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
