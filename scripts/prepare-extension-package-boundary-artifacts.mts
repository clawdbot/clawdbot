// Prepares declaration and entry-shim artifacts that prove plugin package
// boundary imports resolve through public package surfaces.
import {
  spawn,
  spawnSync,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path, { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveTimerTimeoutMs,
} from "../packages/normalization-core/src/number-coercion.ts";
import {
  ensureRepoToolNodeModulesLink,
  isLocalCheckEnabled,
  resolveRepoToolBinPath,
} from "./lib/local-heavy-check-runtime.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import {
  listPluginSdkDeclarationOutputs,
  pluginSdkEntrypoints,
  productionPluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const runTsgoScript = path.join(repoRoot, "scripts/run-tsgo.mjs");
const TYPE_INPUT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);
const VALID_MODES = new Set(["all", "package-boundary"]);
const ROOT_BOUNDARY_TIMEOUT_MS = resolveBoundaryRootShimsTimeoutMs(process.env);
const ROOT_SHIMS_MAX_OLD_SPACE_SIZE =
  process.env.OPENCLAW_ROOT_SHIMS_MAX_OLD_SPACE_SIZE?.trim() || "8192";
const ROOT_SHIMS_NODE_OPTIONS =
  `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${ROOT_SHIMS_MAX_OLD_SPACE_SIZE}`.trim();
const DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS = 1_000;
type NodeStepSignal = "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGTERM";
const NODE_STEP_PARENT_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] satisfies NodeStepSignal[];
const NODE_STEP_PARENT_SIGNAL_EXIT_CODES = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
type NodeStep = Pick<NodeStepParams, "abortKillGraceMs" | "env"> & {
  args: string[];
  label: string;
  timeoutMs: number;
  stamp?: ArtifactStamp;
};
type ArtifactFreshParams = {
  includeFile?: (filePath: string) => boolean;
  inputPaths: string[];
  outputPaths: string[];
  rootDir?: string;
  hashStampPath?: string;
};
type ArtifactStamp = Pick<ArtifactFreshParams, "includeFile" | "inputPaths"> & { path: string };
type NodeStepOutput = {
  on(event: "data", listener: (chunk: string) => void): unknown;
  setEncoding(encoding: "utf8"): void;
};
type NodeStepChild = {
  kill(signal: NodeStepSignal): void;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pid?: number;
  stderr: NodeStepOutput;
  stdout: NodeStepOutput;
};
type SpawnNodeStep = (
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
) => NodeStepChild;
type NodeStepParams = {
  abortController?: AbortController;
  abortKillGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnNodeStep;
};
type RunTaskkill = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => { error?: Error; status: number | null };
const ACTIVE_NODE_STEP_KILLERS = new Map<(signal: NodeStepSignal) => void, number>();
let nodeStepParentSignalForwardersInstalled = false;
let exitingAfterParentSignal = false;
let parentSignalExitCode = 1;
let parentSignalExitTimer: ReturnType<typeof setTimeout> | undefined;

/** Resolve tsx's loader through the selected checkout toolchain. */
export function resolveTsxImportSpecifier({
  resolveTool = resolveRepoToolBinPath,
  createRequireFrom = createRequire,
  ensureToolchain = ensureRepoToolNodeModulesLink,
}: {
  resolveTool?: typeof resolveRepoToolBinPath;
  createRequireFrom?: (filename: string) => { resolve(packageName: string): string };
  ensureToolchain?: typeof ensureRepoToolNodeModulesLink;
} = {}) {
  const tsxBinPath = resolveTool("tsx");
  ensureToolchain(tsxBinPath);
  return pathToFileURL(createRequireFrom(tsxBinPath).resolve("tsx")).href;
}

function listPackageDtsOutputsFromExports(packageDir: string, outputPrefix: string) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages", packageDir, "package.json"), "utf8"),
  );
  return Object.entries(packageJson.exports ?? {})
    .flatMap(([exportKey, value]) => {
      const entry =
        exportKey === "." ? "index" : exportKey.startsWith("./") ? exportKey.slice(2) : "";
      const importPath =
        value && typeof value === "object" && !Array.isArray(value) && "import" in value
          ? value.import
          : value;
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

function listSourceDtsOutputs(sourceDir: string, outputPrefix: string) {
  const outputs: string[] = [];

  function visit(relativeDir: string): void {
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

type TypeScriptBuildInfo = {
  fileNames?: unknown;
  packageJsons?: unknown;
};

function collapsePluginSdkTypeInput(relativePath: string) {
  const parts = relativePath.split("/");
  if (parts[0] === "src" && parts.length > 2) {
    return `src/${parts[1]}`;
  }
  if (parts[0] === "packages" && parts.length > 3) {
    return `packages/${parts[1]}/${parts[2]}`;
  }
  if ((parts[0] === "scripts" || parts[0] === "test") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return relativePath;
}

function derivePluginSdkTypeInputs(entries: string[], baseDir: string, rootDir: string) {
  const inputs = new Set<string>();
  for (const entry of entries) {
    const relativePath = path.relative(rootDir, resolve(baseDir, entry)).replaceAll("\\", "/");
    if (
      relativePath.startsWith("../") ||
      relativePath === ".." ||
      relativePath.startsWith("node_modules/") ||
      relativePath.includes("/node_modules/") ||
      relativePath.startsWith("dist/") ||
      relativePath.startsWith("packages/plugin-sdk/dist/")
    ) {
      continue;
    }
    inputs.add(collapsePluginSdkTypeInput(relativePath));
  }
  if (fs.existsSync(resolve(rootDir, "package.json"))) {
    inputs.add("package.json");
  }
  for (const input of inputs) {
    const packageName = input.match(/^packages\/([^/]+)\//u)?.[1];
    if (packageName && fs.existsSync(resolve(rootDir, `packages/${packageName}/package.json`))) {
      inputs.add(`packages/${packageName}/package.json`);
    }
  }
  return [...inputs].toSorted((a, b) => a.localeCompare(b));
}

/** Derives repository-owned declaration inputs from TypeScript's build record. */
export function derivePluginSdkTypeInputsFromBuildInfo(buildInfoPath: string, rootDir = repoRoot) {
  const parsed = JSON.parse(fs.readFileSync(buildInfoPath, "utf8")) as TypeScriptBuildInfo;
  const fileNames = Array.isArray(parsed.fileNames) ? parsed.fileNames : [];
  const packageJsons = Array.isArray(parsed.packageJsons) ? parsed.packageJsons : [];
  const buildInfoDir = path.dirname(buildInfoPath);
  const entries = [...fileNames, ...packageJsons];
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid TypeScript build input in ${buildInfoPath}`);
  }
  return derivePluginSdkTypeInputs(entries as string[], buildInfoDir, rootDir);
}

/** Resolves declaration inputs from build metadata or the compiler on cold cache. */
export function resolvePluginSdkTypeInputs(rootDir = repoRoot) {
  const buildInfoPath = resolve(rootDir, "dist/plugin-sdk/.tsbuildinfo");
  if (fs.existsSync(buildInfoPath)) {
    return derivePluginSdkTypeInputsFromBuildInfo(buildInfoPath, rootDir);
  }
  const tsgoPath = resolveRepoToolBinPath("tsgo");
  ensureRepoToolNodeModulesLink(tsgoPath);
  const result = spawnSync(
    tsgoPath,
    ["-p", "tsconfig.plugin-sdk.dts.json", "--listFilesOnly", "--noEmit"],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(`Failed to derive plugin SDK type inputs: ${result.stderr || result.error}`);
  }
  return derivePluginSdkTypeInputs(result.stdout.trim().split("\n"), rootDir, rootDir);
}

// Compiler configuration is not part of .tsbuildinfo's file input record.
const resolveDtsInputs = (configPath: string) => [
  "tsconfig.json",
  configPath,
  ...resolvePluginSdkTypeInputs(),
];
const ROOT_DTS_STAMP = "dist/plugin-sdk/.boundary-dts.stamp";
const ACP_CORE_REQUIRED_DTS_OUTPUTS = listPackageDtsOutputsFromExports(
  "acp-core",
  "dist/plugin-sdk/packages/acp-core/src",
);
const AI_REQUIRED_DTS_OUTPUTS = listSourceDtsOutputs(
  "packages/ai/src",
  "dist/plugin-sdk/packages/ai/src",
);
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
const PACKAGE_DTS_STAMP = "packages/plugin-sdk/dist/.boundary-dts.stamp";
const ACP_CORE_REQUIRED_PACKAGE_DTS_OUTPUTS = listPackageDtsOutputsFromExports(
  "acp-core",
  "packages/plugin-sdk/dist/packages/acp-core/src",
);
const AI_REQUIRED_PACKAGE_DTS_OUTPUTS = listSourceDtsOutputs(
  "packages/ai/src",
  "packages/plugin-sdk/dist/packages/ai/src",
);
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
const MEMORY_CORE_DTS_INPUTS = [
  "extensions/memory-core/api.ts",
  "extensions/memory-core/src",
  "extensions/memory-core/tsconfig.json",
];
const MEMORY_CORE_DTS_STAMP = "dist/plugin-sdk/extensions/memory-core/.boundary-dts.stamp";
const MEMORY_CORE_DTS_REQUIRED_OUTPUTS = ["dist/plugin-sdk/extensions/memory-core/api.d.ts"];
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
  "scripts/lib/plugin-sdk-entries.mts",
];
/**
 * Lists entry-shim artifacts written by scripts/write-plugin-sdk-entry-dts.ts.
 */
export function resolveBoundaryEntryShimRequiredOutputs(env: NodeJS.ProcessEnv = process.env) {
  const entries =
    env.OPENCLAW_BUILD_PRIVATE_QA === "1" ? pluginSdkEntrypoints : productionPluginSdkEntrypoints;
  return [
    ...listPluginSdkDeclarationOutputs(entries),
    ...entries.map((entry) => `packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`),
  ].toSorted((a, b) => a.localeCompare(b));
}

function isRelevantTypeInput(filePath: string) {
  const basename = path.basename(filePath);
  if (basename.endsWith(".test.ts")) {
    return false;
  }
  return TYPE_INPUT_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Parses the artifact preparation mode from CLI arguments.
 */
export function parseMode(argv: string[] = process.argv.slice(2)) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

/**
 * Reads the root boundary timeout override for long declaration and shim builds.
 */
export function resolveBoundaryRootShimsTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS?.trim();
  if (!raw) {
    return 300_000;
  }
  return parsePositiveInt(raw, "OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS");
}

function collectInputFiles(
  paths: string[],
  params: Pick<ArtifactFreshParams, "rootDir" | "includeFile"> = {},
) {
  const rootDir = params.rootDir ?? repoRoot;
  const includeFile = params.includeFile ?? (() => true);
  const files: string[] = [];

  function visit(entryPath: string): void {
    if (!fs.existsSync(entryPath)) {
      return;
    }
    if (fs.statSync(entryPath).isDirectory()) {
      const basename = path.basename(entryPath);
      if (basename === "dist" || basename === "node_modules") {
        return;
      }
      for (const child of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (!includeFile(entryPath)) {
      return;
    }
    files.push(entryPath);
  }

  for (const relativePath of paths) {
    visit(resolve(rootDir, relativePath));
  }

  return files;
}

function collectNewestMtime(
  paths: string[],
  params: Pick<ArtifactFreshParams, "rootDir" | "includeFile"> = {},
) {
  let newestMtimeMs = 0;
  for (const filePath of collectInputFiles(paths, params)) {
    newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(filePath).mtimeMs);
  }
  return newestMtimeMs;
}

const inputFileDigestMemo = new Map<string, string>();

// Keyed by stat identity, not path alone: entry-shim inputs include
// .tsbuildinfo files that lane builds rewrite mid-run.
function digestInputFile(filePath: string) {
  const stats = fs.statSync(filePath);
  const memoKey = `${filePath}\0${stats.size}\0${stats.mtimeMs}`;
  const memoized = inputFileDigestMemo.get(memoKey);
  if (memoized) {
    return memoized;
  }
  const digest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  inputFileDigestMemo.set(memoKey, digest);
  return digest;
}

/**
 * Digests the exact input file set the mtime scan sees, so freshness can
 * survive checkouts that re-stamp every file mtime (hosted CI runners).
 */
export function computeArtifactInputsDigest(
  params: Pick<ArtifactFreshParams, "inputPaths" | "rootDir" | "includeFile">,
) {
  const rootDir = params.rootDir ?? repoRoot;
  const digest = createHash("sha256");
  for (const filePath of collectInputFiles(params.inputPaths, params).toSorted()) {
    digest.update(path.relative(rootDir, filePath));
    digest.update("\0");
    digest.update(digestInputFile(filePath));
    digest.update("\n");
  }
  return digest.digest("hex");
}

// These affect artifact generation or plugin compilation but TypeScript does
// not record them as declaration-program file inputs.
const EXTENSION_BOUNDARY_NON_TYPE_INPUTS = [
  "tsconfig.json",
  "tsconfig.plugin-sdk.dts.json",
  "packages/plugin-sdk/package.json",
  "packages/plugin-sdk/tsconfig.json",
  "scripts/check-extension-package-tsc-boundary.mts",
  "scripts/prepare-extension-package-boundary-artifacts.mts",
  "scripts/write-plugin-sdk-entry-dts.ts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "pnpm-lock.yaml",
];

/** Computes the single content fingerprint used by every boundary artifact cache. */
export function computeExtensionBoundaryInputsFingerprint(rootDir = repoRoot) {
  const digest = createHash("sha256");
  digest.update(
    computeArtifactInputsDigest({
      rootDir,
      inputPaths: resolvePluginSdkTypeInputs(rootDir),
      includeFile: isRelevantTypeInput,
    }),
  );
  digest.update(computeArtifactInputsDigest({ rootDir, inputPaths: ["extensions"] }));
  digest.update(
    computeArtifactInputsDigest({ rootDir, inputPaths: EXTENSION_BOUNDARY_NON_TYPE_INPUTS }),
  );
  digest.update(`\nnode=${process.versions.node}\n`);
  return digest.digest("hex");
}

function collectOldestMtime(paths: string[], params: Pick<ArtifactFreshParams, "rootDir"> = {}) {
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
 * Compares input and output mtimes to skip fresh generated artifacts. When the
 * mtime fast path fails and the lane has a hash stamp, falls back to content
 * identity: a fresh checkout re-stamps every input mtime, so cache-restored
 * artifacts never look mtime-fresh on hosted CI runners even when no input
 * byte changed.
 */
export function isArtifactSetFresh(params: ArtifactFreshParams) {
  const newestInputMtimeMs = collectNewestMtime(params.inputPaths, {
    rootDir: params.rootDir,
    includeFile: params.includeFile,
  });
  const oldestOutputMtimeMs = collectOldestMtime(params.outputPaths, {
    rootDir: params.rootDir,
  });
  if (oldestOutputMtimeMs !== null && oldestOutputMtimeMs >= newestInputMtimeMs) {
    return true;
  }
  if (!params.hashStampPath || oldestOutputMtimeMs === null) {
    return false;
  }
  const rootDir = params.rootDir ?? repoRoot;
  const stampPath = resolve(rootDir, params.hashStampPath);
  let recordedDigest: string;
  try {
    recordedDigest = fs.readFileSync(stampPath, "utf8").trim();
  } catch {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(recordedDigest)) {
    return false;
  }
  if (recordedDigest !== computeArtifactInputsDigest(params)) {
    return false;
  }
  // Repair the mtime fast path so later invocations in this checkout skip
  // without re-reading every input byte. The extra millisecond is required,
  // not cosmetic: landing exactly on the newest input leaves no headroom for
  // sub-millisecond write rounding or lagging metadata on CI filesystems, and
  // an output that lands at or below its input silently keeps every later
  // invocation on the expensive full-hash path this repair exists to avoid.
  const now = new Date(Math.max(Date.now(), Math.ceil(newestInputMtimeMs)) + 1);
  for (const relativePath of params.outputPaths) {
    const outputPath = resolve(rootDir, relativePath);
    if (fs.existsSync(outputPath)) {
      fs.utimesSync(outputPath, now, now);
    }
  }
  return true;
}

function hasMissingOutput(paths: string[]) {
  return paths.some((relativePath) => !fs.existsSync(resolve(repoRoot, relativePath)));
}

// Stale inputs invalidate the whole incremental emit graph, not just missing
// outputs: reused .tsbuildinfo can skip re-emitting declarations whose own
// sources did not change even when the cached d.ts predates their current
// exports (observed on sticky-disk CI runners).
function removeStaleIncrementalState({ tsBuildInfoPath }: { tsBuildInfoPath: string }) {
  fs.rmSync(resolve(repoRoot, tsBuildInfoPath), { force: true });
}

// The stamp records the lane's input digest so cache-restored artifacts stay
// fresh across checkouts that rewrite mtimes; writing it last also gives the
// mtime fast path a floor newer than the lane's build.
function writeStampFile(stamp: ArtifactStamp) {
  const filePath = resolve(repoRoot, stamp.path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${computeArtifactInputsDigest(stamp)}\n`, "utf8");
}

/**
 * Prefixes streamed child output line-by-line without breaking partial chunks.
 */
export function createPrefixedOutputWriter(label: string, target: { write(chunk: string): void }) {
  let buffered = "";
  const prefix = `[${label}] `;

  return {
    write(chunk: string) {
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

function abortSiblingSteps(abortController: AbortController | undefined) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

export function signalNodeStep(
  child: Pick<NodeStepChild, "kill" | "pid">,
  signal: NodeStepSignal,
  {
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  }: {
    platform?: NodeJS.Platform;
    runTaskkill?: RunTaskkill;
    useProcessGroup?: boolean;
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

function signalActiveNodeSteps(signal: NodeStepSignal) {
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

/**
 * Runs one artifact step with timeout, abort propagation, and prefixed output.
 */
export function runNodeStep(
  label: string,
  args: string[],
  timeoutMs: number,
  params: NodeStepParams = {},
) {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, MAX_TIMER_TIMEOUT_MS);
  const abortKillGraceMs = Math.max(
    0,
    Math.floor(params.abortKillGraceMs ?? DEFAULT_NODE_STEP_ABORT_KILL_GRACE_MS),
  );
  const abortController = params.abortController;
  const spawnImpl: SpawnNodeStep = params.spawnImpl ?? spawn;
  installNodeStepParentSignalForwarders();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: params.env ? { ...process.env, ...params.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let canceled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killDeadlineAt = 0;
    const stdoutWriter = createPrefixedOutputWriter(label, process.stdout);
    const stderrWriter = createPrefixedOutputWriter(label, process.stderr);
    const useProcessGroup = process.platform !== "win32";
    const killNodeStep = (signal: NodeStepSignal) =>
      signalNodeStep(child, signal, { useProcessGroup });
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return Boolean(
          error && typeof error === "object" && "code" in error && error.code === "EPERM",
        );
      }
    };
    const waitForProcessGroupExit = async (waitMs: number) => {
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
    child.stdout.on("data", (chunk: string) => {
      stdoutWriter.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrWriter.write(chunk);
    });
    child.on("error", (error: Error) => {
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
    child.on("close", (code: number | null) => {
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
export async function runNodeStepsInParallel(steps: NodeStep[]) {
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
export async function runNodeSteps(steps: NodeStep[], env: NodeJS.ProcessEnv = process.env) {
  if (!isLocalCheckEnabled(env)) {
    await runNodeStepsInParallel(steps);
    return;
  }

  for (const step of steps) {
    await runNodeStep(step.label, step.args, step.timeoutMs, { env: step.env });
  }
}

async function main(argv: string[] = process.argv.slice(2)) {
  try {
    if (argv.includes("--print-input-fingerprint")) {
      process.stdout.write(`${computeExtensionBoundaryInputsFingerprint()}\n`);
      return;
    }
    const mode = parseMode(argv);
    const rootDtsInputs = resolveDtsInputs("tsconfig.plugin-sdk.dts.json");
    const packageDtsInputs = resolveDtsInputs("packages/plugin-sdk/tsconfig.json");
    const rootDtsFresh =
      isArtifactSetFresh({
        inputPaths: rootDtsInputs,
        outputPaths: [ROOT_DTS_STAMP, "dist/plugin-sdk/.tsbuildinfo", ...ROOT_DTS_REQUIRED_OUTPUTS],
        hashStampPath: ROOT_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(ROOT_DTS_REQUIRED_OUTPUTS);
    const packageDtsFresh =
      isArtifactSetFresh({
        inputPaths: packageDtsInputs,
        outputPaths: [
          PACKAGE_DTS_STAMP,
          "packages/plugin-sdk/dist/.tsbuildinfo",
          ...PACKAGE_DTS_REQUIRED_OUTPUTS,
        ],
        hashStampPath: PACKAGE_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(PACKAGE_DTS_REQUIRED_OUTPUTS);
    const entryShimsStamp: ArtifactStamp = {
      path: "dist/plugin-sdk/.boundary-entry-shims.stamp",
      inputPaths: [
        ...ENTRY_SHIMS_INPUTS,
        "dist/plugin-sdk/.tsbuildinfo",
        "packages/plugin-sdk/dist/.tsbuildinfo",
      ],
    };
    const entryShimsFresh = isArtifactSetFresh({
      inputPaths: entryShimsStamp.inputPaths,
      outputPaths: [
        entryShimsStamp.path,
        ...resolveBoundaryEntryShimRequiredOutputs({
          ...process.env,
          OPENCLAW_BUILD_PRIVATE_QA: "1",
        }),
      ],
      hashStampPath: entryShimsStamp.path,
    });
    const qaChannelDtsFresh =
      isArtifactSetFresh({
        inputPaths: QA_CHANNEL_DTS_INPUTS,
        outputPaths: [QA_CHANNEL_DTS_STAMP, ...QA_CHANNEL_DTS_REQUIRED_OUTPUTS],
        hashStampPath: QA_CHANNEL_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(QA_CHANNEL_DTS_REQUIRED_OUTPUTS);
    const memoryCoreDtsFresh =
      isArtifactSetFresh({
        inputPaths: MEMORY_CORE_DTS_INPUTS,
        outputPaths: [MEMORY_CORE_DTS_STAMP, ...MEMORY_CORE_DTS_REQUIRED_OUTPUTS],
        hashStampPath: MEMORY_CORE_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(MEMORY_CORE_DTS_REQUIRED_OUTPUTS);
    const matrixDtsFresh =
      isArtifactSetFresh({
        inputPaths: MATRIX_DTS_INPUTS,
        outputPaths: [MATRIX_DTS_STAMP, ...MATRIX_DTS_REQUIRED_OUTPUTS],
        hashStampPath: MATRIX_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(MATRIX_DTS_REQUIRED_OUTPUTS);
    const discordDtsFresh =
      isArtifactSetFresh({
        inputPaths: DISCORD_DTS_INPUTS,
        outputPaths: [DISCORD_DTS_STAMP, ...DISCORD_DTS_REQUIRED_OUTPUTS],
        hashStampPath: DISCORD_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(DISCORD_DTS_REQUIRED_OUTPUTS);
    const slackDtsFresh =
      isArtifactSetFresh({
        inputPaths: SLACK_DTS_INPUTS,
        outputPaths: [SLACK_DTS_STAMP, ...SLACK_DTS_REQUIRED_OUTPUTS],
        hashStampPath: SLACK_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(SLACK_DTS_REQUIRED_OUTPUTS);
    const telegramDtsFresh =
      isArtifactSetFresh({
        inputPaths: TELEGRAM_DTS_INPUTS,
        outputPaths: [TELEGRAM_DTS_STAMP, ...TELEGRAM_DTS_REQUIRED_OUTPUTS],
        hashStampPath: TELEGRAM_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(TELEGRAM_DTS_REQUIRED_OUTPUTS);
    const whatsappDtsFresh =
      isArtifactSetFresh({
        inputPaths: WHATSAPP_DTS_INPUTS,
        outputPaths: [WHATSAPP_DTS_STAMP, ...WHATSAPP_DTS_REQUIRED_OUTPUTS],
        hashStampPath: WHATSAPP_DTS_STAMP,
        includeFile: isRelevantTypeInput,
      }) && !hasMissingOutput(WHATSAPP_DTS_REQUIRED_OUTPUTS);

    const prerequisiteSteps = [];
    const dependentSteps = [];
    if (mode === "all") {
      if (!rootDtsFresh) {
        removeStaleIncrementalState({
          tsBuildInfoPath: "dist/plugin-sdk/.tsbuildinfo",
        });
        prerequisiteSteps.push({
          label: "plugin-sdk boundary dts",
          args: [runTsgoScript, "-p", "tsconfig.plugin-sdk.dts.json", "--declaration", "true"],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: ROOT_BOUNDARY_TIMEOUT_MS,
          stamp: {
            path: ROOT_DTS_STAMP,
            inputPaths: rootDtsInputs,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[plugin-sdk boundary dts] fresh; skipping\n");
      }
    }
    if (!packageDtsFresh) {
      removeStaleIncrementalState({
        tsBuildInfoPath: "packages/plugin-sdk/dist/.tsbuildinfo",
      });
      prerequisiteSteps.push({
        label: "plugin-sdk package boundary dts",
        args: [runTsgoScript, "-p", "packages/plugin-sdk/tsconfig.json", "--declaration", "true"],
        env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
        timeoutMs: ROOT_BOUNDARY_TIMEOUT_MS,
        stamp: {
          path: PACKAGE_DTS_STAMP,
          inputPaths: packageDtsInputs,
          includeFile: isRelevantTypeInput,
        },
      });
    } else {
      process.stdout.write("[plugin-sdk package boundary dts] fresh; skipping\n");
    }
    if (mode === "all") {
      if (!qaChannelDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: QA_CHANNEL_DTS_STAMP,
            inputPaths: QA_CHANNEL_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[qa-channel boundary dts] fresh; skipping\n");
      }
      if (!memoryCoreDtsFresh) {
        removeStaleIncrementalState({
          tsBuildInfoPath: "dist/plugin-sdk/extensions/memory-core/.tsbuildinfo",
        });
        dependentSteps.push({
          label: "memory-core boundary dts",
          args: [
            runTsgoScript,
            "-p",
            "extensions/memory-core/tsconfig.json",
            "--declaration",
            "true",
            "--emitDeclarationOnly",
            "true",
            "--noEmit",
            "false",
            "--outDir",
            "dist/plugin-sdk/extensions/memory-core",
            "--rootDir",
            "extensions/memory-core",
            "--tsBuildInfoFile",
            "dist/plugin-sdk/extensions/memory-core/.tsbuildinfo",
          ],
          env: { OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1" },
          timeoutMs: 300_000,
          stamp: {
            path: MEMORY_CORE_DTS_STAMP,
            inputPaths: MEMORY_CORE_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[memory-core boundary dts] fresh; skipping\n");
      }
      if (!matrixDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: MATRIX_DTS_STAMP,
            inputPaths: MATRIX_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[matrix boundary dts] fresh; skipping\n");
      }
      if (!discordDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: DISCORD_DTS_STAMP,
            inputPaths: DISCORD_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[discord boundary dts] fresh; skipping\n");
      }
      if (!slackDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: SLACK_DTS_STAMP,
            inputPaths: SLACK_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[slack boundary dts] fresh; skipping\n");
      }
      if (!whatsappDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: WHATSAPP_DTS_STAMP,
            inputPaths: WHATSAPP_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[whatsapp boundary dts] fresh; skipping\n");
      }
      if (!telegramDtsFresh) {
        removeStaleIncrementalState({
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
          stamp: {
            path: TELEGRAM_DTS_STAMP,
            inputPaths: TELEGRAM_DTS_INPUTS,
            includeFile: isRelevantTypeInput,
          },
        });
      } else {
        process.stdout.write("[telegram boundary dts] fresh; skipping\n");
      }
    }

    if (prerequisiteSteps.length > 0) {
      await runNodeSteps(prerequisiteSteps);
      for (const step of prerequisiteSteps) {
        if (step.stamp) {
          writeStampFile(step.stamp);
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
        ROOT_BOUNDARY_TIMEOUT_MS,
        {
          env: {
            NODE_OPTIONS: ROOT_SHIMS_NODE_OPTIONS,
            OPENCLAW_BUILD_PRIVATE_QA: "1",
          },
        },
      );
      // Overwrite the child's timestamp stamp with the input digest after the
      // prerequisite tsbuildinfo files have settled.
      writeStampFile(entryShimsStamp);
    } else if (mode === "all") {
      process.stdout.write("[plugin-sdk boundary root shims] fresh; skipping\n");
    }

    if (dependentSteps.length > 0) {
      await runNodeSteps(dependentSteps);
      for (const step of dependentSteps) {
        if (step.stamp) {
          writeStampFile(step.stamp);
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
