// Prepares declaration and entry-shim artifacts that prove plugin package
// boundary imports resolve through public package surfaces.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path, { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureRepoToolNodeModulesLink,
  isLocalCheckEnabled,
  resolveRepoToolBinPath,
} from "./lib/local-heavy-check-runtime.mjs";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { pluginSdkEntrypoints, productionPluginSdkEntrypoints } from "./lib/plugin-sdk-entries.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const runTsgoScript = path.join(repoRoot, "scripts/run-tsgo.mjs");
const TYPE_INPUT_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json"]);
const VALID_MODES = new Set(["all", "package-boundary"]);
const ROOT_SHIMS_TIMEOUT_MS = resolveBoundaryRootShimsTimeoutMs(process.env);
const ROOT_SHIMS_MAX_OLD_SPACE_SIZE =
  process.env.OPENCLAW_ROOT_SHIMS_MAX_OLD_SPACE_SIZE?.trim() || "8192";
const ROOT_SHIMS_NODE_OPTIONS =
  `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${ROOT_SHIMS_MAX_OLD_SPACE_SIZE}`.trim();
const DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS = 1_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const NODE_STEP_PARENT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const NODE_STEP_PARENT_SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const ACTIVE_NODE_STEP_KILLERS = new Map();
let nodeStepParentSignalForwardersInstalled = false;
let exitingAfterParentSignal = false;
let parentSignalExitCode = 1;
let parentSignalExitTimer;

/** Resolve tsx's loader through the selected checkout toolchain. */
export function resolveTsxImportSpecifier({
  resolveTool = resolveRepoToolBinPath,
  createRequireFrom = createRequire,
  ensureToolchain = ensureRepoToolNodeModulesLink,
} = {}) {
  const tsxBinPath = resolveTool("tsx");
  ensureToolchain(tsxBinPath);
  return pathToFileURL(createRequireFrom(tsxBinPath).resolve("tsx")).href;
}

function listPackageDtsOutputsFromExports({ packageDir, outputPrefix }) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages", packageDir, "package.json"), "utf8"),
  );
  return Object.entries(packageJson.exports ?? {})
    .flatMap(([exportKey, value]) => {
      const entry =
        exportKey === "." ? "index" : exportKey.startsWith("./") ? exportKey.slice(2) : "";
      const importPath =
        value && typeof value === "object" && !Array.isArray(value) ? value.import : value;
      if (!entry || entry.includes("..") || typeof importPath !== "string") {
        return [];
      }
      if (!importPath.startsWith("./dist/") || !importPath.endsWith(".mjs")) {
        return [];
      }
      return [`${outputPrefix}/${entry}.d.ts`];
    })
    .toSorted((a, b) => a.localeCompare(b));
}

function listSourceDtsOutputs({ sourceDir, outputPrefix }) {
  const outputs = [];

  function visit(relativeDir) {
    const absoluteDir = path.join(repoRoot, sourceDir, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (
        !entry.name.endsWith(".ts") ||
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".test-helpers.ts")
      ) {
        continue;
      }
      outputs.push(`${outputPrefix}/${relativePath.replace(/\.ts$/u, ".d.ts")}`);
    }
  }

  visit("");
  return outputs.toSorted((a, b) => a.localeCompare(b));
}

const PLUGIN_SDK_TYPE_INPUTS = [
  "tsconfig.json",
  "src/plugin-sdk",
  "src/plugins/provider-runtime-model.types.ts",
  "src/plugins/types.ts",
  "src/auto-reply",
  "packages/ai/src",
  "packages/llm-core/src",
  "packages/markdown-core/src",
  "packages/media-core/src",
  "packages/model-catalog-core/src",
  "packages/memory-host-sdk/src",
  "packages/media-generation-core/src",
  "packages/media-understanding-common/src",
  "packages/normalization-core/src",
  "packages/retry/src",
  "packages/acp-core/src",
  "packages/terminal-core/src",
  "src/video-generation/dashscope-compatible.ts",
  "src/video-generation/types.ts",
  "src/types",
];
const ROOT_DTS_INPUTS = ["tsconfig.plugin-sdk.dts.json", ...PLUGIN_SDK_TYPE_INPUTS];
const ROOT_DTS_STAMP = "dist/plugin-sdk/.boundary-dts.stamp";
const ACP_CORE_REQUIRED_DTS_OUTPUTS = listPackageDtsOutputsFromExports({
  packageDir: "acp-core",
  outputPrefix: "dist/plugin-sdk/packages/acp-core/src",
});
const AI_REQUIRED_DTS_OUTPUTS = listSourceDtsOutputs({
  sourceDir: "packages/ai/src",
  outputPrefix: "dist/plugin-sdk/packages/ai/src",
});
const ROOT_DTS_REQUIRED_OUTPUTS = [
  ...AI_REQUIRED_DTS_OUTPUTS,
  "dist/plugin-sdk/packages/memory-host-sdk/src/engine-embeddings.d.ts",
  "dist/plugin-sdk/packages/memory-host-sdk/src/secret.d.ts",
  "dist/plugin-sdk/packages/memory-host-sdk/src/status.d.ts",
  "dist/plugin-sdk/packages/llm-core/src/index.d.ts",
  "dist/plugin-sdk/packages/llm-core/src/types.d.ts",
  "dist/plugin-sdk/packages/llm-core/src/utils/diagnostics.d.ts",
  "dist/plugin-sdk/packages/llm-core/src/utils/event-stream.d.ts",
  "dist/plugin-sdk/packages/llm-core/src/validation.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/code-spans.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/fences.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/frontmatter.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/index.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/ir.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/render-aware-chunking.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/render.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/tables.d.ts",
  "dist/plugin-sdk/packages/markdown-core/src/types.d.ts",
  "dist/plugin-sdk/packages/media-generation-core/src/capability-model-ref.d.ts",
  "dist/plugin-sdk/packages/media-generation-core/src/catalog.d.ts",
  "dist/plugin-sdk/packages/media-generation-core/src/index.d.ts",
  "dist/plugin-sdk/packages/media-generation-core/src/model-ref.d.ts",
  "dist/plugin-sdk/packages/media-generation-core/src/normalization.d.ts",
  "dist/plugin-sdk/packages/media-core/src/base64.d.ts",
  "dist/plugin-sdk/packages/media-core/src/constants.d.ts",
  "dist/plugin-sdk/packages/media-core/src/content-length.d.ts",
  "dist/plugin-sdk/packages/media-core/src/file-name.d.ts",
  "dist/plugin-sdk/packages/media-core/src/inbound-path-policy.d.ts",
  "dist/plugin-sdk/packages/media-core/src/inline-image-data-url.d.ts",
  "dist/plugin-sdk/packages/media-core/src/media-source-url.d.ts",
  "dist/plugin-sdk/packages/media-core/src/mime.d.ts",
  "dist/plugin-sdk/packages/media-core/src/read-byte-stream-with-limit.d.ts",
  ...ACP_CORE_REQUIRED_DTS_OUTPUTS,
  "dist/plugin-sdk/packages/terminal-core/src/ansi.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/decorative-emoji.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/health-style.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/index.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/links.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/note.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/osc-progress.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/palette.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/progress-line.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/prompt-select-styled-params.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/prompt-select-styled.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/prompt-style.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/restore.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/safe-text.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/stream-writer.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/table.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/terminal-link.d.ts",
  "dist/plugin-sdk/packages/terminal-core/src/theme.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/configured-model-refs.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/model-catalog-normalize.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/model-catalog-refs.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/model-catalog-types.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/provider-id.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/provider-model-id-normalization.d.ts",
  "dist/plugin-sdk/packages/model-catalog-core/src/provider-model-id-normalize.d.ts",
  "dist/plugin-sdk/packages/retry/src/index.d.ts",
  "dist/plugin-sdk/error-runtime.d.ts",
  "dist/plugin-sdk/plugin-entry.d.ts",
  "dist/plugin-sdk/provider-auth.d.ts",
  "dist/plugin-sdk/video-generation.d.ts",
];
const PACKAGE_DTS_INPUTS = ["packages/plugin-sdk/tsconfig.json", ...PLUGIN_SDK_TYPE_INPUTS];
const PACKAGE_DTS_STAMP = "packages/plugin-sdk/dist/.boundary-dts.stamp";
const ACP_CORE_REQUIRED_PACKAGE_DTS_OUTPUTS = listPackageDtsOutputsFromExports({
  packageDir: "acp-core",
  outputPrefix: "packages/plugin-sdk/dist/packages/acp-core/src",
});
const AI_REQUIRED_PACKAGE_DTS_OUTPUTS = listSourceDtsOutputs({
  sourceDir: "packages/ai/src",
  outputPrefix: "packages/plugin-sdk/dist/packages/ai/src",
});
const PACKAGE_DTS_REQUIRED_OUTPUTS = [
  ...AI_REQUIRED_PACKAGE_DTS_OUTPUTS,
  "packages/plugin-sdk/dist/packages/markdown-core/src/code-spans.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/fences.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/frontmatter.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/index.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/ir.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/render-aware-chunking.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/render.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/tables.d.ts",
  "packages/plugin-sdk/dist/packages/markdown-core/src/types.d.ts",
  "packages/plugin-sdk/dist/packages/media-generation-core/src/capability-model-ref.d.ts",
  "packages/plugin-sdk/dist/packages/media-generation-core/src/catalog.d.ts",
  "packages/plugin-sdk/dist/packages/media-generation-core/src/index.d.ts",
  "packages/plugin-sdk/dist/packages/media-generation-core/src/model-ref.d.ts",
  "packages/plugin-sdk/dist/packages/media-generation-core/src/normalization.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/base64.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/constants.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/content-length.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/file-name.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/inbound-path-policy.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/inline-image-data-url.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/media-source-url.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/mime.d.ts",
  "packages/plugin-sdk/dist/packages/media-core/src/read-byte-stream-with-limit.d.ts",
  ...ACP_CORE_REQUIRED_PACKAGE_DTS_OUTPUTS,
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/configured-model-refs.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/model-catalog-normalize.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/model-catalog-refs.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/model-catalog-types.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/provider-id.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/provider-model-id-normalization.d.ts",
  "packages/plugin-sdk/dist/packages/model-catalog-core/src/provider-model-id-normalize.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/index.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/boolean-coercion.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/number-coercion.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/record-coerce.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/string-coerce.d.ts",
  "packages/plugin-sdk/dist/packages/normalization-core/src/string-normalization.d.ts",
  "packages/plugin-sdk/dist/packages/retry/src/index.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/ansi.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/decorative-emoji.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/health-style.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/index.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/links.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/note.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/osc-progress.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/palette.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/progress-line.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/prompt-select-styled-params.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/prompt-select-styled.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/prompt-style.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/restore.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/safe-text.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/stream-writer.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/table.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/terminal-link.d.ts",
  "packages/plugin-sdk/dist/packages/terminal-core/src/theme.d.ts",
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
const MATRIX_DTS_INPUTS = [
  "extensions/matrix/test-api.ts",
  "extensions/matrix/src",
  "extensions/matrix/tsconfig.json",
];
const MATRIX_DTS_STAMP = "dist/plugin-sdk/extensions/matrix/.boundary-dts.stamp";
const MATRIX_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/matrix/test-api.d.ts"];
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
const TELEGRAM_DTS_INPUTS = ["extensions/telegram/api.ts", "extensions/telegram/tsconfig.json"];
const TELEGRAM_DTS_STAMP = "dist/plugin-sdk/extensions/telegram/.boundary-dts.stamp";
const TELEGRAM_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/telegram/api.d.ts"];
const WHATSAPP_DTS_INPUTS = [
  "extensions/whatsapp/api.ts",
  "extensions/whatsapp/src/qa-driver.runtime.ts",
  "extensions/whatsapp/tsconfig.json",
];
const WHATSAPP_DTS_STAMP = "dist/plugin-sdk/extensions/whatsapp/.boundary-dts.stamp";
const WHATSAPP_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/whatsapp/api.d.ts"];
const ENTRY_SHIMS_INPUTS = [
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/write-plugin-sdk-entry-dts.ts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-entries.mjs",
];
/**
 * Lists entry-shim artifacts written by scripts/write-plugin-sdk-entry-dts.ts.
 */
export function resolveBoundaryEntryShimRequiredOutputs(env = process.env) {
  const entries =
    env.OPENCLAW_BUILD_PRIVATE_QA === "1" ? pluginSdkEntrypoints : productionPluginSdkEntrypoints;
  return entries
    .flatMap((entry) => [
      `dist/plugin-sdk/${entry}.d.ts`,
      `packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`,
    ])
    .toSorted((a, b) => a.localeCompare(b));
}

function isRelevantTypeInput(filePath) {
  const basename = path.basename(filePath);
  if (basename.endsWith(".test.ts")) {
    return false;
  }
  return TYPE_INPUT_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Parses the artifact preparation mode from CLI arguments.
 */
export function parseMode(argv = process.argv.slice(2)) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

/**
 * Reads the root shim timeout override for long package-boundary builds.
 */
export function resolveBoundaryRootShimsTimeoutMs(env = process.env) {
  const raw = env.OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS?.trim();
  if (!raw) {
    return 300_000;
  }
  return parsePositiveInt(raw, "OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS");
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

/**
 * Compares input and output mtimes to skip fresh generated artifacts.
 */
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

/**
 * Prefixes streamed child output line-by-line without breaking partial chunks.
 */
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

export function signalNodeStep(
  child,
  signal,
  {
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  } = {},
) {
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child process group can already be gone by the time cleanup runs.
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkillPath = resolveWindowsTaskkillPath();
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return;
    }
    if (signal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return;
      }
    }
  }
  child.kill(signal);
}

function signalActiveNodeSteps(signal) {
  for (const killNodeStep of ACTIVE_NODE_STEP_KILLERS.keys()) {
    killNodeStep(signal);
  }
}

function activeNodeStepKillGraceMs() {
  return ACTIVE_NODE_STEP_KILLERS.size > 0
    ? Math.max(...ACTIVE_NODE_STEP_KILLERS.values())
    : DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS;
}

function installNodeStepParentSignalForwarders() {
  if (nodeStepParentSignalForwardersInstalled) {
    return;
  }
  nodeStepParentSignalForwardersInstalled = true;
  for (const signal of NODE_STEP_PARENT_SIGNALS) {
    process.on(signal, () => {
      const exitCode = NODE_STEP_PARENT_SIGNAL_EXIT_CODES.get(signal) ?? 1;
      if (exitingAfterParentSignal) {
        signalActiveNodeSteps("SIGKILL");
        process.exit(exitCode);
      }
      exitingAfterParentSignal = true;
      parentSignalExitCode = exitCode;
      signalActiveNodeSteps(signal);
      parentSignalExitTimer ??= setTimeout(
        () => process.exit(parentSignalExitCode),
        activeNodeStepKillGraceMs(),
      );
    });
  }
  process.on("exit", () => {
    signalActiveNodeSteps("SIGKILL");
  });
}

function resolveNodeStepTimerTimeoutMs(valueMs) {
  const value = Number(valueMs);
  if (!Number.isFinite(value)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMER_TIMEOUT_MS);
}

/**
 * Runs one artifact step with timeout, abort propagation, and prefixed output.
 */
export function runNodeStep(label, args, timeoutMs, params = {}) {
  const resolvedTimeoutMs = resolveNodeStepTimerTimeoutMs(timeoutMs);
  const abortKillGraceMs = Math.max(
    0,
    Math.floor(params.abortKillGraceMs ?? DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS),
  );
  const abortController = params.abortController;
  const spawnImpl = params.spawnImpl ?? spawn;
  installNodeStepParentSignalForwarders();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: params.env ? { ...process.env, ...params.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let canceled = false;
    let killTimer;
    let killDeadlineAt = 0;
    const stdoutWriter = createPrefixedOutputWriter(label, process.stdout);
    const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
    const useProcessGroup = process.platform !== "win32";
    const killNodeStep = (signal) => signalNodeStep(child, signal, { useProcessGroup });
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return Boolean(error && error.code === "EPERM");
      }
    };
    const waitForProcessGroupExit = async (waitMs) => {
      const deadlineAt = Date.now() + waitMs;
      while (Date.now() < deadlineAt) {
        if (!processGroupAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, 25);
        });
      }
      return !processGroupAlive();
    };
    const waitForCanceledStepTeardown = async () => {
      const remainingGraceMs = Math.max(0, killDeadlineAt - Date.now());
      if (remainingGraceMs > 0) {
        await waitForProcessGroupExit(remainingGraceMs);
      }
      if (processGroupAlive()) {
        killNodeStep("SIGKILL");
        await waitForProcessGroupExit(100);
      }
    };
    ACTIVE_NODE_STEP_KILLERS.set(killNodeStep, abortKillGraceMs);
    const abortStep = () => {
      if (settled || canceled) {
        return;
      }
      canceled = true;
      killNodeStep("SIGTERM");
      killDeadlineAt = Date.now() + abortKillGraceMs;
      killTimer = setTimeout(() => {
        killTimer = undefined;
        killNodeStep("SIGKILL");
      }, abortKillGraceMs);
      killTimer.unref?.();
    };
    function cleanup() {
      clearTimeout(timer);
      clearTimeout(killTimer);
      ACTIVE_NODE_STEP_KILLERS.delete(killNodeStep);
      abortController?.signal.removeEventListener("abort", abortStep);
    }
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killNodeStep("SIGKILL");
      cleanup();
      stdoutWriter.flush();
      stderrWriter.flush();
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} timed out after ${resolvedTimeoutMs}ms`));
    }, resolvedTimeoutMs);
    abortController?.signal.addEventListener("abort", abortStep, { once: true });

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
      settled = true;
      stdoutWriter.flush();
      stderrWriter.flush();
      if (exitingAfterParentSignal) {
        killNodeStep("SIGKILL");
        cleanup();
        return;
      }
      cleanup();
      abortSiblingSteps(abortController);
      rejectPromise(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      void (async () => {
        settled = true;
        stdoutWriter.flush();
        stderrWriter.flush();
        if (exitingAfterParentSignal) {
          killNodeStep("SIGKILL");
          cleanup();
          return;
        }
        if (canceled) {
          await waitForCanceledStepTeardown();
          cleanup();
          rejectPromise(new Error(`${label} canceled after sibling failure`));
          return;
        }
        cleanup();
        if (code === 0) {
          resolvePromise();
          return;
        }
        abortSiblingSteps(abortController);
        rejectPromise(new Error(`${label} failed with exit code ${code ?? 1}`));
      })();
    });
  });
}

/**
 * Runs independent artifact steps together and aborts siblings on first failure.
 */
export async function runNodeStepsInParallel(steps) {
  const abortController = new AbortController();
  const results = await Promise.allSettled(
    steps.map((step) =>
      runNodeStep(step.label, step.args, step.timeoutMs, {
        abortController,
        abortKillGraceMs: step.abortKillGraceMs,
        env: step.env,
      }),
    ),
  );
  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure) {
    throw firstFailure.reason;
  }
}

/**
 * Chooses serial or parallel artifact execution based on local heavy-check policy.
 */
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
      outputPaths: [
        "dist/plugin-sdk/.boundary-entry-shims.stamp",
        ...resolveBoundaryEntryShimRequiredOutputs(),
      ],
    });
    const qaChannelDtsFresh =
      isArtifactSetFresh({
        inputPaths: QA_CHANNEL_DTS_INPUTS,
        outputPaths: [QA_CHANNEL_DTS_STAMP, ...QA_CHANNEL_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(QA_CHANNEL_DTS_REQUIRED_OUTPUTS);
    const matrixDtsFresh =
      isArtifactSetFresh({
        inputPaths: MATRIX_DTS_INPUTS,
        outputPaths: [MATRIX_DTS_STAMP, ...MATRIX_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(MATRIX_DTS_REQUIRED_OUTPUTS);
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
    const telegramDtsFresh =
      isArtifactSetFresh({
        inputPaths: TELEGRAM_DTS_INPUTS,
        outputPaths: [TELEGRAM_DTS_STAMP, ...TELEGRAM_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(TELEGRAM_DTS_REQUIRED_OUTPUTS);
    const whatsappDtsFresh =
      isArtifactSetFresh({
        inputPaths: WHATSAPP_DTS_INPUTS,
        outputPaths: [WHATSAPP_DTS_STAMP, ...WHATSAPP_DTS_REQUIRED_OUTPUTS],
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(WHATSAPP_DTS_REQUIRED_OUTPUTS);

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
      if (!matrixDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: MATRIX_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/matrix/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "matrix boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/matrix/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/matrix",
            "--rootDir",
            "extensions/matrix",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/matrix/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: MATRIX_DTS_STAMP,
        });
      } else {
        process.stdout.write("[matrix boundary dts] fresh; skipping\n");
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
      if (!whatsappDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: WHATSAPP_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/whatsapp/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "whatsapp boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/whatsapp/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/whatsapp",
            "--rootDir",
            "extensions/whatsapp",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/whatsapp/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: WHATSAPP_DTS_STAMP,
        });
      } else {
        process.stdout.write("[whatsapp boundary dts] fresh; skipping\n");
      }
      if (!telegramDtsFresh) {
        removeIncrementalStateForMissingOutput({
          outputPaths: TELEGRAM_DTS_REQUIRED_OUTPUTS,
          tsBuildInfoPath: "dist/plugin-sdk/extensions/telegram/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "telegram boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/telegram/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/telegram",
            "--rootDir",
            "extensions/telegram",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/telegram/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stampPath: TELEGRAM_DTS_STAMP,
        });
      } else {
        process.stdout.write("[telegram boundary dts] fresh; skipping\n");
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
        [
          "--import",
          resolveTsxImportSpecifier(),
          resolve(repoRoot, "scripts/write-plugin-sdk-entry-dts.ts"),
        ],
        ROOT_SHIMS_TIMEOUT_MS,
        { env: { NODE_OPTIONS: ROOT_SHIMS_NODE_OPTIONS } },
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
