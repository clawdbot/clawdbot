#!/usr/bin/env node

// Generates native Canvas A2UI resources from the plugin-owned source.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const rootDir = resolveRepoRoot(import.meta.url);
const REQUIRED_RESOURCE_FILES = ["a2ui.bundle.js", "index.html"];
type NativeResourceDirs = { sourceDir: string; nativeDir: string };

export function getNativeA2uiResourcePaths(repoRoot = rootDir) {
  return {
    sourceDir: path.join(repoRoot, "extensions", "canvas", "src", "host", "a2ui"),
    linuxConsumerFile: path.join(repoRoot, "apps", "linux", "src-tauri", "src", "canvas.rs"),
    linuxBuildFile: path.join(repoRoot, "apps", "linux", "src-tauri", "build.rs"),
    androidBuildFile: path.join(repoRoot, "apps", "android", "app", "build.gradle.kts"),
    iosProjectFile: path.join(repoRoot, "apps", "ios", "project.yml"),
  };
}

export async function checkLinuxCanvasA2uiReferences({
  linuxConsumerFile,
}: Pick<ReturnType<typeof getNativeA2uiResourcePaths>, "linuxConsumerFile">) {
  const source = await fs.readFile(linuxConsumerFile, "utf8");
  const expectedReferences = [
    'include_bytes!(env!("OPENCLAW_CANVAS_A2UI_INDEX_HTML"))',
    'include_bytes!(env!("OPENCLAW_CANVAS_A2UI_BUNDLE_JS"))',
  ];
  const missing = expectedReferences.filter((reference) => !source.includes(reference));
  if (missing.length > 0) {
    throw new Error(
      `Linux Canvas must embed the staged native A2UI resources.\nMissing references:\n${formatList(missing)}`,
    );
  }
}

export async function checkNativeA2uiBuildReferences({
  linuxBuildFile,
  androidBuildFile,
  iosProjectFile,
}: Pick<
  ReturnType<typeof getNativeA2uiResourcePaths>,
  "linuxBuildFile" | "androidBuildFile" | "iosProjectFile"
>) {
  const [linuxBuild, androidBuild, iosProject] = await Promise.all([
    fs.readFile(linuxBuildFile, "utf8"),
    fs.readFile(androidBuildFile, "utf8"),
    fs.readFile(iosProjectFile, "utf8"),
  ]);
  const stagingCommand = "scripts/sync-native-a2ui.mts";
  const missing = [];
  if (
    !linuxBuild.includes(stagingCommand) ||
    !linuxBuild.includes('"--write"') ||
    !linuxBuild.includes('"--output"')
  ) {
    missing.push("Linux Cargo build script");
  }
  if (
    !androidBuild.includes(stagingCommand) ||
    !androidBuild.includes("addGeneratedSourceDirectory") ||
    !androidBuild.includes("StageCanvasA2uiTask::outputDirectory") ||
    !androidBuild.includes('"--output"')
  ) {
    missing.push("Android Gradle preBuild task");
  }
  if (
    !iosProject.includes("Stage Canvas A2UI resources") ||
    !iosProject.includes(stagingCommand) ||
    !iosProject.includes("pwd -P") ||
    !iosProject.includes("--output") ||
    !iosProject.includes("$BUILT_PRODUCTS_DIR/OpenClawKit_OpenClawKit.bundle") ||
    !iosProject.includes("$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH") ||
    !iosProject.includes('cp -R "$resource_product/CanvasA2UI"')
  ) {
    missing.push("iOS app post-build resource stage");
  }
  if (missing.length > 0) {
    throw new Error(
      `Native A2UI build staging is incomplete.\nMissing owners:\n${formatList(missing)}`,
    );
  }
}

function normalizeRelativePath(filePath: string) {
  return filePath.split(path.sep).join("/");
}

async function listRelativeFiles(dir: string, baseDir = dir): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
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

function formatList(values: string[]) {
  return values.length === 0 ? "(none)" : values.map((value) => `- ${value}`).join("\n");
}

async function assertSourceResourcesExist(sourceDir: string) {
  const missing = [];
  for (const fileName of REQUIRED_RESOURCE_FILES) {
    try {
      await fs.stat(path.join(sourceDir, fileName));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
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

export async function syncNativeA2uiResources({ sourceDir, nativeDir }: NativeResourceDirs) {
  await assertSourceResourcesExist(sourceDir);
  await fs.mkdir(nativeDir, { recursive: true });
  for (const entry of await fs.readdir(nativeDir)) {
    await fs.rm(path.join(nativeDir, entry), { recursive: true, force: true });
  }
  for (const fileName of REQUIRED_RESOURCE_FILES) {
    await fs.copyFile(path.join(sourceDir, fileName), path.join(nativeDir, fileName));
  }
}

export async function checkNativeA2uiResources({ sourceDir, nativeDir }: NativeResourceDirs) {
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
        "Native A2UI resource generation is incomplete.",
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
      `Native A2UI resources differ from generated source.\nMismatched:\n${formatList(mismatched)}`,
    );
  }
}

function parseOptions(argv: string[]) {
  let mode: "check" | "write" | null = null;
  let outputDir: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--write") {
      if (mode) {
        throw new Error("Only one native A2UI staging mode may be selected.");
      }
      mode = arg === "--check" ? "check" : "write";
      continue;
    }
    if (arg === "--output") {
      outputDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown native A2UI staging argument: ${arg}`);
  }
  if (!mode || (mode === "write") !== Boolean(outputDir)) {
    throw new Error(
      "Usage: node --import tsx scripts/sync-native-a2ui.mts --check|--write [--output <directory>]",
    );
  }
  return { mode, outputDir };
}

function bundleA2ui(repoRoot = rootDir, env = process.env) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/bundle-a2ui.mts"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("A2UI bundling failed before native resource sync.");
  }
}

async function withFreshBundleCheckSource(
  sourceDir: string,
  run: (freshSourceDir: string) => Promise<void>,
) {
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
  const { mode, outputDir } = parseOptions(process.argv.slice(2));
  const paths = getNativeA2uiResourcePaths();
  if (mode === "write") {
    await withFreshBundleCheckSource(paths.sourceDir, async (sourceDir) => {
      if (!outputDir) {
        throw new Error("Native A2UI output directory is required in write mode.");
      }
      await syncNativeA2uiResources({ sourceDir, nativeDir: path.resolve(outputDir) });
    });
    console.log("[canvas] native A2UI resources generated.");
    return;
  }
  await withFreshBundleCheckSource(paths.sourceDir, async (firstSourceDir) => {
    await withFreshBundleCheckSource(paths.sourceDir, async (secondSourceDir) => {
      await checkNativeA2uiResources({ sourceDir: firstSourceDir, nativeDir: secondSourceDir });
    });
  });
  await checkLinuxCanvasA2uiReferences(paths);
  await checkNativeA2uiBuildReferences(paths);
  console.log("[canvas] native A2UI resources are reproducible and build-owned.");
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
