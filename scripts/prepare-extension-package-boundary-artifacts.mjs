import { spawn } from "node:child_process";
import fs from "node:fs";
import path, { resolve } from "node:path";
import { isLocalCheckEnabled } from "./lib/local-heavy-check-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const runTsgoScript = path.join(repoRoot, "scripts/run-tsgo.mjs");
const TYPE_INPUT_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json"]);
const VALID_MODES = new Set(["all", "package-boundary"]);

const PLUGIN_SDK_TYPE_INPUTS = [
  "tsconfig.json",
  "src/plugin-sdk",
  "src/auto-reply",
  "packages/memory-host-sdk/src",
  "src/video-generation/dashscope-compatible.ts",
  "src/video-generation/types.ts",
  "src/types",
];
const ROOT_DTS_INPUTS = ["tsconfig.plugin-sdk.dts.json", ...PLUGIN_SDK_TYPE_INPUTS];
const ROOT_DTS_STAMP = "dist/plugin-sdk/.boundary-dts.stamp";
const ROOT_DTS_REQUIRED_OUTPUTS = [
  "dist/plugin-sdk/packages/memory-host-sdk/src/engine-embeddings.d.ts",
  "dist/plugin-sdk/packages/memory-host-sdk/src/secret.d.ts",
  "dist/plugin-sdk/packages/memory-host-sdk/src/status.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/error-runtime.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/plugin-entry.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/provider-auth.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/video-generation.d.ts",
];
const PACKAGE_DTS_INPUTS = ["packages/plugin-sdk/tsconfig.json", ...PLUGIN_SDK_TYPE_INPUTS];
const PACKAGE_DTS_STAMP = "packages/plugin-sdk/dist/.boundary-dts.stamp";
const PACKAGE_DTS_REQUIRED_OUTPUTS = [
  "packages/plugin-sdk/dist/src/plugin-sdk/error-runtime.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/plugin-entry.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/provider-auth.d.ts",
  "packages/plugin-sdk/dist/src/plugin-sdk/video-generation.d.ts",
];
const QA_CHANNEL_DTS_INPUTS = [
  "extensions/qa-channel/api.ts",
  "extensions/qa-channel/runtime-api.ts",
  "extensions/qa-channel/test-api.ts",
  "extensions/qa-channel/src",
  "extensions/qa-channel/tsconfig.json",
];
const QA_CHANNEL_DTS_STAMP = "dist/plugin-sdk/extensions/qa-channel/.boundary-dts.stamp";
const QA_CHANNEL_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/qa-channel/api.d.ts"];
const DISCORD_DTS_INPUTS = [
  "extensions/discord/api.ts",
  "extensions/discord/src/api.ts",
  "extensions/discord/tsconfig.json",
];
const DISCORD_DTS_STAMP = "dist/plugin-sdk/extensions/discord/.boundary-dts.stamp";
const DISCORD_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/discord/api.d.ts"];
const SLACK_DTS_INPUTS = [
  "extensions/slack/api.ts",
  "extensions/slack/src/client.ts",
  "extensions/slack/tsconfig.json",
];
const SLACK_DTS_STAMP = "dist/plugin-sdk/extensions/slack/.boundary-dts.stamp";
const SLACK_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/slack/api.d.ts"];
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

function runNodeStep(label, args, timeoutMs, params = {}) {
  const abortController = params.abortController;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: params.env ? { ...process.env, ...params.env } : process.env,
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
    steps.map((step) =>
      runNodeStep(step.label, step.args, step.timeoutMs, { abortController, env: step.env }),
    ),
  );
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure) {
    throw firstFailure.reason;
  }
}

export async function runNodeSteps(steps, env = process.env) {
  if (!isLocalCheckEnabled(env)) {
    await runNodeStepsInParallel(steps);
    return;
  }

  for (const step of steps) {
    await runNodeStep(step.label, step.args, step.timeoutMs, { env: step.env });
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const mode = parseMode(argv);
    const rootDtsFresh =
      isArtifactSetFresh({
        inputPaths: ROOT_DTS_INPUTS,
        outputPaths: [ROOT_DTS_STAMP, ...ROOT_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(ROOT_DTS_REQUIRED_OUTPUTS);
    const packageDtsFresh =
      isArtifactSetFresh({
        inputPaths: PACKAGE_DTS_INPUTS,
        outputPaths: [PACKAGE_DTS_STAMP, ...PACKAGE_DTS_REQUIRED_OUTPUTS],
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
    const qaChannelDtsFresh =
      isArtifactSetFresh({
        inputPaths: QA_CHANNEL_DTS_INPUTS,
        outputPaths: [QA_CHANNEL_DTS_STAMP, ...QA_CHANNEL_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(QA_CHANNEL_DTS_REQUIRED_OUTPUTS);
    const discordDtsFresh =
      isArtifactSetFresh({
        inputPaths: DISCORD_DTS_INPUTS,
        outputPaths: [DISCORD_DTS_STAMP, ...DISCORD_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(DISCORD_DTS_REQUIRED_OUTPUTS);
    const slackDtsFresh =
      isArtifactSetFresh({
        inputPaths: SLACK_DTS_INPUTS,
        outputPaths: [SLACK_DTS_STAMP, ...SLACK_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(SLACK_DTS_REQUIRED_OUTPUTS);

    const prerequisiteSteps = [];
    const dependentSteps = [];
    if (mode === "all") {
      if (!rootDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: ROOT_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/.tsbuildinfo",
        });
        prerequisiteSteps.push({
          label: "plugin-sdk boundary dts",
          args: [runTsgoScript, "-p", "tsconfig.plugin-sdk.dts.json", "--declaration", "true"],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
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
      prerequisiteSteps.push({
        label: "plugin-sdk package boundary dts",
        args: [runTsgoScript, "-p", "packages/plugin-sdk/tsconfig.json", "--declaration", "true"],
        env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
        timeoutMs: 300_000,
        stampPath: PACKAGE_DTS_STAMP,
      });
    } else {
      process.stdout.write("[plugin-sdk package boundary dts] fresh; skipping\n");
    }
    if (mode === "all") {
      if (!qaChannelDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: QA_CHANNEL_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/qa-channel/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "qa-channel boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/qa-channel/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/qa-channel",
            "--rootDir",
            "extensions/qa-channel",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/qa-channel/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: QA_CHANNEL_DTS_STAMP,
        });
      } else {
        process.stdout.write("[qa-channel boundary dts] fresh; skipping\n");
      }
      if (!discordDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: DISCORD_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/discord/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "discord boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/discord/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/discord",
            "--rootDir",
            "extensions/discord",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/discord/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: DISCORD_DTS_STAMP,
        });
      } else {
        process.stdout.write("[discord boundary dts] fresh; skipping\n");
      }
      if (!slackDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: SLACK_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/slack/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "slack boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/slack/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/slack",
            "--rootDir",
            "extensions/slack",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/slack/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: SLACK_DTS_STAMP,
        });
      } else {
        process.stdout.write("[slack boundary dts] fresh; skipping\n");
      }
    }

    if (prerequisiteSteps.length > 0) {
      await runNodeSteps(prerequisiteSteps);
      for (const step of prerequisiteSteps) {
        if (step.stampPath) {
          writeStampFile(step.stampPath);
        }
      }
    }

    if (mode === "all" && (!entryShimsFresh || prerequisiteSteps.length > 0)) {
      await runNodeStep(
        "plugin-sdk boundary root shims",
        ["--import", "tsx", resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts")],
        120_000,
      );
    } else if (mode === "all") {
      process.stdout.write("[plugin-sdk boundary root shims] fresh; skipping\n");
    }

    if (dependentSteps.length > 0) {
      await runNodeSteps(dependentSteps);
      for (const step of dependentSteps) {
        if (step.stampPath) {
          writeStampFile(step.stampPath);
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
