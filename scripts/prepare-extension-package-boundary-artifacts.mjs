import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path, { resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const tscBin = require.resolve("typescript/bin/tsc");
const TYPE_INPUT_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json"]);
const VALID_MODES = new Set(["all", "package-boundary"]);

const ROOT_DTS_INPUTS = [
  "tsconfig.json",
  "tsconfig.plugin-sdk.dts.json",
  "src/channels/plugins",
  "src/plugin-sdk",
  "src/video-generation/dashscope-compatible.ts",
  "src/video-generation/types.ts",
  "src/types",
];
const ROOT_DTS_STAMP = "dist/plugin-sdk/.boundary-dts.stamp";
const ROOT_DTS_REQUIRED_OUTPUTS = [
  "dist/plugin-sdk/src/plugin-sdk/error-runtime.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/plugin-entry.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/provider-auth.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/video-generation.d.ts",
];
const PACKAGE_DTS_INPUTS = [
  "tsconfig.json",
  "packages/plugin-sdk/tsconfig.json",
  "src/channels/plugins",
  "src/plugin-sdk",
  "src/video-generation/dashscope-compatible.ts",
  "src/video-generation/types.ts",
  "src/types",
];
const PACKAGE_DTS_STAMP = "packages/plugin-sdk/dist/.boundary-dts.stamp";
const PACKAGE_DTS_REQUIRED_OUTPUTS = [
  "packages/plugin-sdk/dist/src/plugin-sdk/error-runtime.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/plugin-entry.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/provider-auth.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/video-generation.d.ts",
];
const ENTRY_SHIMS_INPUTS = [
  "scripts/write-plugin-sdk-entry-dts.ts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-entries.mjs",
];

function isRelevantTypeInput(filePath) {
  const basename = path.basename(filePath);
  if (basename.endsWith(".test.ts")) {
    return false;
  }
  return TYPE_INPUT_EXTENSIONS.has(path.extname(filePath));
}

export function parseMode(argv = process.argv.slice(2)) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

function collectNewestMtime(paths, params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const includeFile = params.includeFile ?? (() => true);
  let newestMtimeMs = 0;

  function visit(entryPath) {
    if (!fs.existsSync(entryPath)) {
      return;
    }
    const stats = fs.statSync(entryPath);
    if (stats.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (!includeFile(entryPath)) {
      return;
    }
    newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
  }

  for (const relativePath of paths) {
    visit(resolve(rootDir, relativePath));
  }

  return newestMtimeMs;
}

function collectOldestMtime(paths, params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  let oldestMtimeMs = Number.POSITIVE_INFINITY;

  for (const relativePath of paths) {
    const absolutePath = resolve(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    oldestMtimeMs = Math.min(oldestMtimeMs, fs.statSync(absolutePath).mtimeMs);
  }

  return Number.isFinite(oldestMtimeMs) ? oldestMtimeMs : null;
}

export function isArtifactSetFresh(params) {
  const newestInputMtimeMs = collectNewestMtime(params.inputPaths, {
    rootDir: params.rootDir,
    includeFile: params.includeFile,
  });
  const oldestOutputMtimeMs = collectOldestMtime(params.outputPaths, { rootDir: params.rootDir });
  return oldestOutputMtimeMs !== null && oldestOutputMtimeMs >= newestInputMtimeMs;
}

function hasMissingOutput(paths) {
  return paths.some((relativePath) => !fs.existsSync(resolve(repoRoot, relativePath)));
}

function removeIncrementalStateForMissingOutput(params) {
  if (!hasMissingOutput(params.outputPaths)) {
    return;
  }
  fs.rmSync(resolve(repoRoot, params.tsBuildInfoPath), { force: true });
}

function writeStampFile(relativePath) {
  const filePath = resolve(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${new Date().toISOString()}\n`, "utf8");
}

export function createPrefixedOutputWriter(label, target) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk) {
      buffered += chunk;
      while (true) {
        const newlineIndex = buffered.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffered.slice(0, newlineIndex + 1);
        buffered = buffered.slice(newlineIndex + 1);
        target.write(`${prefix}${line}`);
      }
    },
    flush() {
      if (!buffered) {
        return;
      }
      target.write(`${prefix}${buffered}`);
      buffered = "";
    },
  };
}

function abortSiblingSteps(abortController) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

export function runNodeStep(label, args, timeoutMs, params = {}) {
  const abortController = params.abortController;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      signal: abortController?.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const stdoutWriter = createPrefixedOutputWriter(label, process.stdout);
    const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutWriter.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrWriter.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      if (error.name === "AbortError" && abortController?.signal.aborted) {
        rejectPromise(new Error(`${label} canceled after sibling failure`));
        return;
      }
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      if (code === 0) {
        resolvePromise();
        return;
      }
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} failed with exit code ${code ?? 1}`));
    });
  });
}

export async function runNodeStepsInParallel(steps) {
  const abortController = new AbortController();
  const results = await Promise.allSettled(
    steps.map((step) => runNodeStep(step.label, step.args, step.timeoutMs, { abortController })),
  );
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure) {
    throw firstFailure.reason;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const mode = parseMode(argv);
    const rootDtsFresh =
      isArtifactSetFresh({
        inputPaths: ROOT_DTS_INPUTS,
        outputPaths: [ROOT_DTS_STAMP],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(ROOT_DTS_REQUIRED_OUTPUTS);
    const packageDtsFresh =
      isArtifactSetFresh({
        inputPaths: PACKAGE_DTS_INPUTS,
        outputPaths: [PACKAGE_DTS_STAMP],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(PACKAGE_DTS_REQUIRED_OUTPUTS);
    const entryShimsFresh = isArtifactSetFresh({
      inputPaths: [
        ...ENTRY_SHIMS_INPUTS,
        "dist/plugin-sdk/.tsbuildinfo",
        "packages/plugin-sdk/dist/.tsbuildinfo",
      ],
      outputPaths: ["dist/plugin-sdk/.boundary-entry-shims.stamp"],
    });

    const pendingSteps = [];
    if (mode === "all") {
      if (!rootDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: ROOT_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/.tsbuildinfo",
        });
        pendingSteps.push({
          label: "plugin-sdk boundary dts",
          args: [tscBin, "-p", "tsconfig.plugin-sdk.dts.json"],
          timeoutMs: 300_000,
          stampPath: ROOT_DTS_STAMP,
        });
      } else {
        process.stdout.write("[plugin-sdk boundary dts] fresh; skipping\n");
      }
    }
    if (!packageDtsFresh) {
      removeIncrementalStateForMissingOutput({
        outputPaths: PACKAGE_DTS_REQUIRED_OUTPUTS,
        tsBuildInfoPath: "packages/plugin-sdk/dist/.tsbuildinfo",
      });
      pendingSteps.push({
        label: "plugin-sdk package boundary dts",
        args: [tscBin, "-p", "packages/plugin-sdk/tsconfig.json"],
        timeoutMs: 300_000,
        stampPath: PACKAGE_DTS_STAMP,
      });
    } else {
      process.stdout.write("[plugin-sdk package boundary dts] fresh; skipping\n");
    }

    if (pendingSteps.length > 0) {
      await runNodeStepsInParallel(pendingSteps);
      for (const step of pendingSteps) {
        if (step.stampPath) {
          writeStampFile(step.stampPath);
        }
      }
    }

    if (mode === "all" && (!entryShimsFresh || pendingSteps.length > 0)) {
      await runNodeStep(
        "plugin-sdk boundary root shims",
        ["--import", "tsx", resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts")],
        120_000,
      );
    } else if (mode === "all") {
      process.stdout.write("[plugin-sdk boundary root shims] fresh; skipping\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
