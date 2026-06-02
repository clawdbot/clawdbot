#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { pluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const nodeBin = process.execPath;
const WINDOWS_BUILD_MAX_OLD_SPACE_MB = 8192;
const BUILD_CACHE_VERSION = 3;
const PLUGIN_SDK_DTS_CACHE_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "packages/plugin-sdk/package.json",
  "packages/llm-core/package.json",
  "packages/markdown-core/package.json",
  "packages/media-core/package.json",
  "packages/media-understanding-common/package.json",
  "packages/terminal-core/package.json",
  "packages/acp-core/package.json",
  "packages/model-catalog-core/package.json",
  "packages/normalization-core/package.json",
  "packages/web-content-core/package.json",
  "packages/memory-host-sdk/package.json",
  "tsconfig.json",
  "tsconfig.plugin-sdk.dts.json",
  "src/plugin-sdk",
  "packages/llm-core/src",
  "packages/markdown-core/src",
  "packages/media-core/src",
  "packages/media-generation-core/src",
  "packages/model-catalog-core/src",
  "packages/memory-host-sdk/src",
  "packages/normalization-core/src",
  "packages/acp-core/src",
  "packages/media-understanding-common/src",
  "packages/terminal-core/src",
  "packages/web-content-core/src",
  "src/types",
  "src/video-generation/dashscope-compatible.ts",
  "src/video-generation/types.ts",
];
const PLUGIN_SDK_ENTRY_DTS_CACHE_ENV = ["OPENCLAW_BUILD_PRIVATE_QA"];
const PLUGIN_SDK_ENTRY_DTS_CACHE_INPUTS = [
  "scripts/write-plugin-sdk-entry-dts.ts",
  "scripts/lib/plugin-sdk-entries.mjs",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
  ...PLUGIN_SDK_DTS_CACHE_INPUTS,
];
const PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS = [
  { path: "dist/plugin-sdk", extensions: [".d.ts"], recursive: false },
  "dist/plugin-sdk/webhook-path.js",
  "dist/plugin-sdk/.boundary-entry-shims.stamp",
  ...pluginSdkEntrypoints.map((entry) => `packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`),
];
const PNPM_STEP_NODE_FALLBACKS = new Map([
  ["plugins:assets:build", ["scripts/bundled-plugin-assets.mjs", "--phase", "build"]],
  [
    "build:plugin-sdk:dts",
    ["scripts/run-tsgo.mjs", "-p", "tsconfig.plugin-sdk.dts.json", "--declaration", "true"],
  ],
  ["plugins:assets:copy", ["scripts/bundled-plugin-assets.mjs", "--phase", "copy"]],
  ["ui:build", ["scripts/ui.js", "build"]],
]);
export const BUILD_ALL_STEPS = [
  { label: "plugins:assets:build", kind: "pnpm", pnpmArgs: ["plugins:assets:build"] },
  { label: "tsdown", kind: "node", args: ["scripts/tsdown-build.mjs"] },
  {
    label: "check-cli-bootstrap-imports",
    kind: "node",
    args: ["scripts/check-cli-bootstrap-imports.mjs"],
  },
  { label: "runtime-postbuild", kind: "node", args: ["scripts/runtime-postbuild.mjs"] },
  { label: "build-stamp", kind: "node", args: ["scripts/build-stamp.mjs"] },
  {
    label: "runtime-postbuild-stamp",
    kind: "node",
    args: ["scripts/runtime-postbuild-stamp.mjs"],
  },
  {
    label: "build:plugin-sdk:dts",
    kind: "pnpm",
    pnpmArgs: ["build:plugin-sdk:dts"],
    windowsNodeOptions: `--max-old-space-size=${WINDOWS_BUILD_MAX_OLD_SPACE_MB}`,
    cache: {
      inputs: PLUGIN_SDK_DTS_CACHE_INPUTS,
      outputs: ["dist/plugin-sdk/.tsbuildinfo", "dist/plugin-sdk/packages", "dist/plugin-sdk/src"],
    },
  },
  {
    label: "write-plugin-sdk-entry-dts",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-plugin-sdk-entry-dts.ts"],
    cache: {
      env: PLUGIN_SDK_ENTRY_DTS_CACHE_ENV,
      inputs: PLUGIN_SDK_ENTRY_DTS_CACHE_INPUTS,
      outputs: PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS,
      restore: "always",
    },
  },
  {
    label: "check-plugin-sdk-exports",
    kind: "node",
    args: ["scripts/check-plugin-sdk-exports.mjs"],
  },
  {
    label: "plugins:assets:copy",
    kind: "pnpm",
    pnpmArgs: ["plugins:assets:copy"],
  },
  {
    label: "copy-hook-metadata",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/copy-hook-metadata.ts"],
  },
  {
    label: "copy-export-html-templates",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/copy-export-html-templates.ts"],
    cache: {
      inputs: [
        "scripts/copy-export-html-templates.ts",
        "scripts/lib/copy-assets.ts",
        "src/auto-reply/reply/export-html",
      ],
      outputs: ["dist/auto-reply/reply/export-html"],
    },
  },
  {
    label: "ui:build",
    kind: "pnpm",
    pnpmArgs: ["ui:build"],
    // No build-all cache: ui/vite.config.ts derives the Control UI build ID
    // from package.json, git HEAD, and OPENCLAW_CONTROL_UI_BUILD_ID env, so a
    // file-input signature cannot exactly invalidate generated assets and a
    // warm hit could restore stale service-worker/app cache metadata.
    cache: undefined,
  },
  {
    label: "write-build-info",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-build-info.ts"],
  },
  {
    label: "write-cli-startup-metadata",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-cli-startup-metadata.ts"],
  },
  {
    label: "write-cli-compat",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-cli-compat.ts"],
  },
];

export const BUILD_ALL_PROFILES = {
  full: BUILD_ALL_STEPS.map((step) => step.label),
  ciArtifacts: [
    "plugins:assets:build",
    "tsdown",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
    "build:plugin-sdk:dts",
    "write-plugin-sdk-entry-dts",
    "check-plugin-sdk-exports",
    "plugins:assets:copy",
    "copy-hook-metadata",
    "copy-export-html-templates",
    "ui:build",
    "write-build-info",
    "write-cli-startup-metadata",
    "write-cli-compat",
  ],
  gatewayWatch: [
    "tsdown",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
  ],
  qaRuntime: [
    "plugins:assets:build",
    "tsdown",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
  ],
  cliStartup: [
    "tsdown",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
    "write-cli-startup-metadata",
    "write-cli-compat",
  ],
};

export const BUILD_ALL_PROFILE_STEP_ENV = {
  full: {
    tsdown: {
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  ciArtifacts: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  gatewayWatch: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
  qaRuntime: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
  },
  cliStartup: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
};

export function buildAllUsage() {
  return [
    "Usage: node scripts/build-all.mjs [profile]",
    "",
    "Builds OpenClaw artifacts for the selected profile.",
    "",
    "Profiles:",
    ...Object.keys(BUILD_ALL_PROFILES).map((profile) => `  ${profile}`),
    "",
    "Options:",
    "  -h, --help  Show this help.",
  ].join("\n");
}

export function parseBuildAllArgs(argv) {
  const args = {
    help: false,
    profile: "full",
  };
  let sawProfile = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}\n\n${buildAllUsage()}`);
    } else if (sawProfile) {
      throw new Error(`unexpected argument: ${arg}\n\n${buildAllUsage()}`);
    } else {
      args.profile = arg;
      sawProfile = true;
    }
  }
  if (!args.help && !BUILD_ALL_PROFILES[args.profile]) {
    throw new Error(`Unknown build profile: ${args.profile}\n\n${buildAllUsage()}`);
  }
  return args;
}

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
  const envOverrides = BUILD_ALL_PROFILE_STEP_ENV[profile] ?? {};
  return selected.map((step) => {
    const env = envOverrides[step.label];
    if (!env) {
      return step;
    }
    const mergedEnv = Object.assign({}, step.env, env);
    return Object.assign({}, step, { env: mergedEnv });
  });
}

function resolveStepEnv(step, env, platform) {
  const stepEnv = step.env ? Object.assign({}, env, step.env) : env;
  if (platform !== "win32" || !step.windowsNodeOptions) {
    return stepEnv;
  }
  const currentNodeOptions = stepEnv.NODE_OPTIONS?.trim() ?? "";
  if (currentNodeOptions.includes(step.windowsNodeOptions)) {
    return stepEnv;
  }
  return {
    ...stepEnv,
    NODE_OPTIONS: currentNodeOptions
      ? `${currentNodeOptions} ${step.windowsNodeOptions}`
      : step.windowsNodeOptions,
  };
}

export function resolveBuildAllStep(step, params = {}) {
  const platform = params.platform ?? process.platform;
  const env = resolveStepEnv(step, params.env ?? process.env, platform);
  if (step.kind === "pnpm") {
    const nodeFallbackArgs =
      env.OPENCLAW_BUILD_ALL_NO_PNPM === "1" ? PNPM_STEP_NODE_FALLBACKS.get(step.label) : undefined;
    if (nodeFallbackArgs) {
      return {
        command: params.nodeExecPath ?? nodeBin,
        args: nodeFallbackArgs,
        options: {
          stdio: "inherit",
          env,
        },
      };
    }
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

function normalizeCacheEntry(entry) {
  if (typeof entry === "string") {
    return { path: entry };
  }
  return entry;
}

function cacheEntryIncludesFile(entry, filePath) {
  if (!entry.extensions?.length) {
    return true;
  }
  return entry.extensions.some((extension) => filePath.endsWith(extension));
}

function listFilesRecursively(rootPath, fsImpl, cacheEntry = { path: rootPath }) {
  let stat;
  try {
    stat = fsImpl.statSync(rootPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return cacheEntryIncludesFile(cacheEntry, rootPath) ? [rootPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const out = [];
  const entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  const recursive = cacheEntry.recursive !== false;
  for (const dirent of entries) {
    if (dirent.name === ".DS_Store") {
      continue;
    }
    const entryPath = path.join(rootPath, dirent.name);
    if (dirent.isDirectory() && recursive) {
      out.push(...listFilesRecursively(entryPath, fsImpl, cacheEntry));
    } else if (dirent.isFile() && cacheEntryIncludesFile(cacheEntry, entryPath)) {
      out.push(entryPath);
    }
  }
  return out;
}

function listCacheFiles(rootDir, entries, fsImpl) {
  return entries
    .map(normalizeCacheEntry)
    .flatMap((entry) => listFilesRecursively(path.resolve(rootDir, entry.path), fsImpl, entry))
    .toSorted();
}

function portableRelativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function normalizePortablePath(filePath) {
  return filePath.replaceAll("\\", "/");
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

function hashInputFiles(rootDir, files, fsImpl, envEntries = [], env = process.env) {
  const hash = createHash("sha256");
  hash.update(`v${BUILD_CACHE_VERSION}\0`);
  for (const name of envEntries.toSorted((left, right) => left.localeCompare(right))) {
    hash.update(`env:${name}`);
    hash.update("\0");
    hash.update(env[name] ?? "");
    hash.update("\0");
  }
  for (const file of files) {
    hash.update(portableRelativePath(rootDir, file));
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
  const signature = hashInputFiles(
    rootDir,
    inputFiles,
    fsImpl,
    step.cache.env ?? [],
    params.env ?? process.env,
  );
  const { outputRoot, stampPath } = resolveCachePaths(rootDir, step);
  const stamp = readCacheStamp(stampPath, fsImpl);
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  const relativeOutputFiles = outputFiles.map((file) => portableRelativePath(rootDir, file));
  const stampedOutputs = Array.isArray(stamp?.outputs)
    ? stamp.outputs.map((entry) => normalizePortablePath(entry))
    : [];
  const stampMatches = stamp?.version === BUILD_CACHE_VERSION && stamp.signature === signature;
  const actualOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(rootDir, stampedOutputs, fsImpl);
  const cachedOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(outputRoot, stampedOutputs, fsImpl);
  const alwaysRestore = step.cache.restore === "always";
  const actualOutputsAcceptable = actualOutputsPresent && !alwaysRestore;
  const restorable =
    stampMatches && cachedOutputsPresent && (alwaysRestore || !actualOutputsPresent);
  const fresh = stampMatches && (actualOutputsAcceptable || cachedOutputsPresent);
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

export function resolveBuildAllStepCacheStampState(step, cacheState, params = {}) {
  if (!cacheState.cacheable || !cacheState.signature || !step.cache) {
    return cacheState;
  }
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  return {
    ...cacheState,
    outputFiles: outputFiles.length,
    relativeOutputFiles: outputFiles.map((file) => portableRelativePath(rootDir, file)),
  };
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

export function formatBuildAllDuration(durationMs) {
  const clampedMs = Math.max(0, durationMs);
  if (clampedMs < 1000) {
    return `${Math.round(clampedMs)}ms`;
  }
  if (clampedMs < 10000) {
    return `${(clampedMs / 1000).toFixed(2)}s`;
  }
  return `${(clampedMs / 1000).toFixed(1)}s`;
}

export function formatBuildAllTimingSummary(timings) {
  if (timings.length === 0) {
    return "[build-all] phase timings: no phases ran";
  }
  const totalMs = timings.reduce((sum, timing) => sum + timing.durationMs, 0);
  const phases = timings
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .map((timing) => {
      const status = timing.status === "ran" ? "" : ` (${timing.status})`;
      return `${timing.label}${status} ${formatBuildAllDuration(timing.durationMs)}`;
    })
    .join("; ");
  return `[build-all] phase timings: total ${formatBuildAllDuration(totalMs)}; slowest ${phases}`;
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  let args;
  try {
    args = parseBuildAllArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (args?.help) {
    console.log(buildAllUsage());
  } else {
    const timings = [];
    let exitCode = 0;
    for (const step of resolveBuildAllSteps(args.profile)) {
      const startedAt = performance.now();
      const cacheState = resolveBuildAllStepCacheState(step);
      if (process.env.OPENCLAW_BUILD_CACHE !== "0" && cacheState.fresh) {
        restoreBuildAllStepCacheOutputs(cacheState);
        const durationMs = performance.now() - startedAt;
        timings.push({ label: step.label, status: "cached", durationMs });
        console.error(`[build-all] ${step.label} (cached) ${formatBuildAllDuration(durationMs)}`);
        continue;
      }
      console.error(`[build-all] ${step.label}`);
      const invocation = resolveBuildAllStep(step);
      const result = spawnSync(invocation.command, invocation.args, invocation.options);
      const durationMs = performance.now() - startedAt;
      if (typeof result.status === "number") {
        if (result.status !== 0) {
          timings.push({ label: step.label, status: "failed", durationMs });
          console.error(
            `[build-all] ${step.label} failed after ${formatBuildAllDuration(durationMs)}`,
          );
          exitCode = result.status;
          break;
        }
        writeBuildAllStepCacheStamp(step, resolveBuildAllStepCacheStampState(step, cacheState));
        timings.push({ label: step.label, status: "ran", durationMs });
        console.error(`[build-all] ${step.label} done in ${formatBuildAllDuration(durationMs)}`);
        continue;
      }
      timings.push({ label: step.label, status: "failed", durationMs });
      console.error(`[build-all] ${step.label} failed after ${formatBuildAllDuration(durationMs)}`);
      exitCode = 1;
      break;
    }
    console.error(formatBuildAllTimingSummary(timings));
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}
