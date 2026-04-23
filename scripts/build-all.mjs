#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const nodeBin = process.execPath;
const WINDOWS_BUILD_MAX_OLD_SPACE_MB = 4096;
const BUILD_CACHE_VERSION = 2;
export const BUILD_ALL_STEPS = [
  { label: "canvas:a2ui:bundle", kind: "pnpm", pnpmArgs: ["canvas:a2ui:bundle"] },
  { label: "tsdown", kind: "node", args: ["scripts/tsdown-build.mjs"] },
  { label: "runtime-postbuild", kind: "node", args: ["scripts/runtime-postbuild.mjs"] },
  { label: "build-stamp", kind: "node", args: ["scripts/build-stamp.mjs"] },
  {
    label: "build:plugin-sdk:dts",
    kind: "pnpm",
    pnpmArgs: ["build:plugin-sdk:dts"],
    windowsNodeOptions: `--max-old-space-size=${WINDOWS_BUILD_MAX_OLD_SPACE_MB}`,
    cache: {
      inputs: [
        "tsconfig.json",
        "tsconfig.plugin-sdk.dts.json",
        "src/plugin-sdk",
        "src/types",
        "src/video-generation/dashscope-compatible.ts",
        "src/video-generation/types.ts",
      ],
      outputs: ["dist/plugin-sdk/.tsbuildinfo", "dist/plugin-sdk/src"],
    },
  },
  {
    label: "write-plugin-sdk-entry-dts",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-plugin-sdk-entry-dts.ts"],
  },
  {
    label: "check-plugin-sdk-exports",
    kind: "node",
    args: ["scripts/check-plugin-sdk-exports.mjs"],
  },
  {
    label: "canvas-a2ui-copy",
    kind: "node",
    args: ["--import", "tsx", "scripts/canvas-a2ui-copy.ts"],
    cache: {
      inputs: ["scripts/canvas-a2ui-copy.ts", "src/canvas-host/a2ui"],
      outputs: ["dist/canvas-host/a2ui/index.html", "dist/canvas-host/a2ui/a2ui.bundle.js"],
    },
  },
  {
    label: "copy-hook-metadata",
    kind: "node",
    args: ["--import", "tsx", "scripts/copy-hook-metadata.ts"],
  },
  {
    label: "copy-export-html-templates",
    kind: "node",
    args: ["--import", "tsx", "scripts/copy-export-html-templates.ts"],
    cache: {
      inputs: [
        "scripts/copy-export-html-templates.ts",
        "scripts/lib/copy-assets.ts",
        "src/auto-reply/reply/export-html",
      ],
      outputs: ["dist/export-html"],
    },
  },
  {
    label: "write-build-info",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-build-info.ts"],
  },
  {
    label: "write-cli-startup-metadata",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-cli-startup-metadata.ts"],
  },
  {
    label: "write-cli-compat",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-cli-compat.ts"],
  },
];

export const BUILD_ALL_PROFILES = {
  full: BUILD_ALL_STEPS.map((step) => step.label),
  ciArtifacts: [
    "canvas:a2ui:bundle",
    "tsdown",
    "runtime-postbuild",
    "build-stamp",
    "canvas-a2ui-copy",
    "copy-hook-metadata",
    "copy-export-html-templates",
    "write-build-info",
    "write-cli-startup-metadata",
    "write-cli-compat",
  ],
  gatewayWatch: ["tsdown", "runtime-postbuild", "build-stamp"],
};

export function resolveBuildAllSteps(profile = "full") {
  const labels = BUILD_ALL_PROFILES[profile];
  if (!labels) {
    throw new Error(`Unknown build profile: ${profile}`);
  }
  const selected = labels.map((label) => BUILD_ALL_STEPS.find((step) => step.label === label));
  if (selected.some((step) => !step)) {
    const missing = labels.filter((label) => !BUILD_ALL_STEPS.some((step) => step.label === label));
    throw new Error(`Build profile ${profile} references unknown steps: ${missing.join(", ")}`);
  }
  return selected;
}

function resolveStepEnv(step, env, platform) {
  if (platform !== "win32" || !step.windowsNodeOptions) {
    return env;
  }
  const currentNodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  if (currentNodeOptions.includes(step.windowsNodeOptions)) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: currentNodeOptions
      ? `${currentNodeOptions} ${step.windowsNodeOptions}`
      : step.windowsNodeOptions,
  };
}

export function resolveBuildAllStep(step, params = {}) {
  const platform = params.platform ?? process.platform;
  const env = resolveStepEnv(step, params.env ?? process.env, platform);
  if (step.kind === "pnpm") {
    const runner = resolvePnpmRunner({
      pnpmArgs: step.pnpmArgs,
      nodeExecPath: params.nodeExecPath ?? nodeBin,
      npmExecPath: params.npmExecPath ?? env.npm_execpath,
      comSpec: params.comSpec ?? env.ComSpec,
      platform,
    });
    return {
      command: runner.command,
      args: runner.args,
      options: {
        stdio: "inherit",
        env,
        shell: runner.shell,
        windowsVerbatimArguments: runner.windowsVerbatimArguments,
      },
    };
  }
  return {
    command: params.nodeExecPath ?? nodeBin,
    args: step.args,
    options: {
      stdio: "inherit",
      env,
    },
  };
}

function listFilesRecursively(rootPath, fsImpl) {
  let stat;
  try {
    stat = fsImpl.statSync(rootPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [rootPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const out = [];
  const entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursively(entryPath, fsImpl));
    } else if (entry.isFile()) {
      out.push(entryPath);
    }
  }
  return out;
}

function listCacheFiles(rootDir, entries, fsImpl) {
  return entries
    .flatMap((entry) => listFilesRecursively(path.resolve(rootDir, entry), fsImpl))
    .toSorted();
}

function resolveCachePaths(rootDir, step) {
  const safeLabel = step.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = path.resolve(rootDir, ".artifacts/build-all-cache", safeLabel);
  return {
    cacheDir,
    outputRoot: path.join(cacheDir, "outputs"),
    stampPath: path.join(cacheDir, "stamp.json"),
  };
}

function hashInputFiles(rootDir, files, fsImpl) {
  const hash = createHash("sha256");
  hash.update(`v${BUILD_CACHE_VERSION}\0`);
  for (const file of files) {
    hash.update(path.relative(rootDir, file));
    hash.update("\0");
    hash.update(fsImpl.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readCacheStamp(stampPath, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(stampPath, "utf8"));
  } catch {
    return undefined;
  }
}

function hasAllFiles(rootDir, relativeFiles, fsImpl) {
  return relativeFiles.every((relativeFile) => {
    try {
      return fsImpl.statSync(path.resolve(rootDir, relativeFile)).isFile();
    } catch {
      return false;
    }
  });
}

function copyFileSync(fsImpl, sourcePath, targetPath) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.copyFileSync(sourcePath, targetPath);
}

export function resolveBuildAllStepCacheState(step, params = {}) {
  if (!step.cache) {
    return { cacheable: false, fresh: false, reason: "no-cache" };
  }
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const inputFiles = listCacheFiles(rootDir, step.cache.inputs, fsImpl);
  if (inputFiles.length === 0) {
    return { cacheable: true, fresh: false, reason: "missing-inputs" };
  }
  const signature = hashInputFiles(rootDir, inputFiles, fsImpl);
  const { outputRoot, stampPath } = resolveCachePaths(rootDir, step);
  const stamp = readCacheStamp(stampPath, fsImpl);
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  const relativeOutputFiles = outputFiles.map((file) => path.relative(rootDir, file));
  const stampedOutputs = Array.isArray(stamp?.outputs) ? stamp.outputs : [];
  const stampMatches = stamp?.version === BUILD_CACHE_VERSION && stamp.signature === signature;
  const actualOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(rootDir, stampedOutputs, fsImpl);
  const cachedOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(outputRoot, stampedOutputs, fsImpl);
  const restorable = stampMatches && !actualOutputsPresent && cachedOutputsPresent;
  const fresh = stampMatches && (actualOutputsPresent || cachedOutputsPresent);
  return {
    cacheable: true,
    fresh,
    restorable,
    reason: fresh ? (restorable ? "fresh-cache" : "fresh") : "stale",
    signature,
    outputRoot,
    stampPath,
    inputFiles: inputFiles.length,
    outputFiles: outputFiles.length,
    relativeOutputFiles,
    stampedOutputs,
  };
}

export function writeBuildAllStepCacheStamp(step, cacheState, params = {}) {
  if (
    !cacheState.cacheable ||
    !cacheState.signature ||
    !cacheState.stampPath ||
    !cacheState.outputRoot ||
    !cacheState.relativeOutputFiles?.length
  ) {
    return;
  }
  const fsImpl = params.fs ?? fs;
  const rootDir = params.rootDir ?? process.cwd();
  for (const relativeFile of cacheState.relativeOutputFiles) {
    copyFileSync(
      fsImpl,
      path.resolve(rootDir, relativeFile),
      path.resolve(cacheState.outputRoot, relativeFile),
    );
  }
  fsImpl.mkdirSync(path.dirname(cacheState.stampPath), { recursive: true });
  fsImpl.writeFileSync(
    cacheState.stampPath,
    `${JSON.stringify({
      version: BUILD_CACHE_VERSION,
      label: step.label,
      signature: cacheState.signature,
      outputs: cacheState.relativeOutputFiles,
    })}\n`,
  );
}

export function restoreBuildAllStepCacheOutputs(cacheState, params = {}) {
  if (!cacheState.restorable || !cacheState.outputRoot || !cacheState.stampedOutputs?.length) {
    return false;
  }
  const fsImpl = params.fs ?? fs;
  const rootDir = params.rootDir ?? process.cwd();
  for (const relativeFile of cacheState.stampedOutputs) {
    copyFileSync(
      fsImpl,
      path.resolve(cacheState.outputRoot, relativeFile),
      path.resolve(rootDir, relativeFile),
    );
  }
  return true;
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  const profile = process.argv[2] ?? "full";
  for (const step of resolveBuildAllSteps(profile)) {
    const cacheState = resolveBuildAllStepCacheState(step);
    if (process.env.OPENCLAW_BUILD_CACHE !== "0" && cacheState.fresh) {
      restoreBuildAllStepCacheOutputs(cacheState);
      console.error(`[build-all] ${step.label} (cached)`);
      continue;
    }
    console.error(`[build-all] ${step.label}`);
    const invocation = resolveBuildAllStep(step);
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (typeof result.status === "number") {
      if (result.status !== 0) {
        process.exit(result.status);
      }
      writeBuildAllStepCacheStamp(step, resolveBuildAllStepCacheState(step));
      continue;
    }
    process.exit(1);
  }
}
