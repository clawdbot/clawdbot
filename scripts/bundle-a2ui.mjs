#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = path.join(rootDir, "src", "canvas-host", "a2ui", ".bundle.hash");
const outputFile = path.join(rootDir, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const a2uiRendererDir = path.join(rootDir, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(rootDir, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const inputPaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];
const ignoredBundleHashInputPrefixes = ["vendor/a2ui/renderers/lit/dist"];
const relativeInputPaths = inputPaths.map((inputPath) =>
  normalizePath(path.relative(rootDir, inputPath)),
);

function fail(message) {
  console.error(message);
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isBundleHashInputPath(filePath, repoRoot = rootDir) {
  const relativePath = normalizePath(path.relative(repoRoot, filePath));
  return !ignoredBundleHashInputPrefixes.some(
    (ignoredPath) => relativePath === ignoredPath || relativePath.startsWith(`${ignoredPath}/`),
  );
}

export function getLocalRolldownCliCandidates(repoRoot = rootDir) {
  return [
    path.join(repoRoot, "node_modules", "rolldown", "bin", "cli.mjs"),
    path.join(repoRoot, "node_modules", ".pnpm", "node_modules", "rolldown", "bin", "cli.mjs"),
    path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "rolldown@1.0.0-rc.12",
      "node_modules",
      "rolldown",
      "bin",
      "cli.mjs",
    ),
  ];
}

async function walkFiles(entryPath, files) {
  if (!isBundleHashInputPath(entryPath)) {
    return;
  }
  const stat = await fs.stat(entryPath);
  if (!stat.isDirectory()) {
    files.push(entryPath);
    return;
  }
  const entries = await fs.readdir(entryPath);
  for (const entry of entries) {
    await walkFiles(path.join(entryPath, entry), files);
  }
}

function listTrackedInputFiles() {
  const result = spawnSync("git", ["ls-files", "--", ...relativeInputPaths], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((filePath) => path.join(rootDir, filePath))
    .filter((filePath) => isBundleHashInputPath(filePath));
}

async function computeHash() {
  let files = listTrackedInputFiles();
  if (!files) {
    files = [];
    for (const inputPath of inputPaths) {
      await walkFiles(inputPath, files);
    }
  }
  files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(normalizePath(path.relative(rootDir, filePath)));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runStep(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runPnpm(pnpmArgs) {
  const runner = resolvePnpmRunner({
    pnpmArgs,
    nodeExecPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    comSpec: process.env.ComSpec,
    platform: process.platform,
  });
  runStep(runner.command, runner.args, {
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

async function main() {
  const hasRendererDir = await pathExists(a2uiRendererDir);
  const hasAppDir = await pathExists(a2uiAppDir);
  const hasOutputFile = await pathExists(outputFile);
  if (!hasRendererDir || !hasAppDir) {
    if (hasOutputFile) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    if (process.env.OPENCLAW_SPARSE_PROFILE || process.env.OPENCLAW_A2UI_SKIP_MISSING === "1") {
      console.error(
        "A2UI sources missing; skipping bundle because OPENCLAW_A2UI_SKIP_MISSING=1 or OPENCLAW_SPARSE_PROFILE is set.",
      );
      return;
    }
    fail(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash();
  if (await pathExists(hashFile)) {
    const previousHash = (await fs.readFile(hashFile, "utf8")).trim();
    if (previousHash === currentHash && hasOutputFile) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  runPnpm(["-s", "exec", "tsc", "-p", path.join(a2uiRendererDir, "tsconfig.json")]);

  const localRolldownCliCandidates = getLocalRolldownCliCandidates(rootDir);
  const localRolldownCli = (
    await Promise.all(
      localRolldownCliCandidates.map(async (candidate) =>
        (await pathExists(candidate)) ? candidate : null,
      ),
    )
  ).find(Boolean);

  if (localRolldownCli) {
    runStep(process.execPath, [
      localRolldownCli,
      "-c",
      path.join(a2uiAppDir, "rolldown.config.mjs"),
    ]);
  } else {
    runPnpm(["-s", "exec", "rolldown", "-c", path.join(a2uiAppDir, "rolldown.config.mjs")]);
  }

  await fs.writeFile(hashFile, `${currentHash}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
