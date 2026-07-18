#!/usr/bin/env node
// Runs one named live-test shard with OPENCLAW_LIVE_TEST enabled.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import {
  forwardSignalToVitestProcessGroup,
  installVitestProcessGroupCleanup,
  shouldUseDetachedVitestProcessGroup,
} from "./vitest-process-group.mjs";

const LIVE_TEST_SUFFIX = ".live.test.ts";
const OPTIONAL_LIVE_SHARD_FILE_ENVS = new Map([
  [
    "extensions/codex/src/app-server/native-subagent-monitor.live.test.ts",
    ["OPENCLAW_LIVE_CODEX_NATIVE_SUBAGENT"],
  ],
  [
    "extensions/codex/src/native-thread-coexistence.live.test.ts",
    ["OPENCLAW_LIVE_CODEX_THREAD_COEXISTENCE"],
  ],
  ["src/agents/agent-mcp-style.cache.live.test.ts", ["OPENCLAW_LIVE_CACHE_TEST"]],
  ["src/agents/cli-runner/bundle-mcp.gemini.live.test.ts", ["OPENCLAW_LIVE_CLI_MCP_GEMINI"]],
  ["src/agents/embedded-agent-runner.cache.live.test.ts", ["OPENCLAW_LIVE_CACHE_TEST"]],
  ["src/agents/live-cache-regression.live.test.ts", ["OPENCLAW_LIVE_CACHE_TEST"]],
  ["src/agents/provider-headers.live.test.ts", ["OPENCLAW_LIVE_CACHE_TEST"]],
  ["src/agents/subagent-announce.live.test.ts", ["OPENCLAW_LIVE_SUBAGENT_E2E"]],
  ["src/agents/tools/image-tool.ollama.live.test.ts", ["OPENCLAW_LIVE_OLLAMA_IMAGE"]],
  ["src/agents/tools/image-tool.providers.live.test.ts", ["OPENCLAW_LIVE_IMAGE_TOOL_TEST"]],
  ["src/skills/workshop/experience-review.live.test.ts", ["OPENCLAW_LIVE_SKILL_EXPERIENCE_REVIEW"]],
  ["src/system-agent/rescue-channel.live.test.ts", ["OPENCLAW_LIVE_SYSTEM_AGENT_RESCUE_CHANNEL"]],
  ["src/gateway/android-node.capabilities.live.test.ts", ["OPENCLAW_LIVE_ANDROID_NODE"]],
  ["src/gateway/gateway-acp-bind.live.test.ts", ["OPENCLAW_LIVE_ACP_BIND"]],
  ["src/gateway/gateway-acp-spawn-defaults.live.test.ts", ["OPENCLAW_LIVE_ACP_SPAWN_DEFAULTS"]],
  ["src/gateway/gateway-cli-backend.live.test.ts", ["OPENCLAW_LIVE_CLI_BACKEND"]],
  ["src/gateway/gateway-codex-bind.live.test.ts", ["OPENCLAW_LIVE_CODEX_BIND"]],
  ["src/gateway/gateway-codex-harness.live.test.ts", ["OPENCLAW_LIVE_CODEX_HARNESS"]],
  ["src/gateway/gateway-trajectory-export.live.test.ts", ["OPENCLAW_LIVE_CODEX_HARNESS"]],
  ["src/infra/push-apns-http2.live.test.ts", ["OPENCLAW_LIVE_APNS_REACHABILITY"]],
  ["test/image-generation.infer-cli.live.test.ts", ["OPENCLAW_LIVE_INFER_CLI_TEST"]],
]);
const SKIPPED_ASSERTION_STATUSES = new Set(["disabled", "pending", "skipped", "todo"]);
const QA_RUNTIME_LIVE_TEST = "extensions/qa-lab/src/matrix-channel-driver.lifecycle.live.test.ts";
const QA_RUNTIME_ARTIFACT = "dist/extensions/qa-lab/runtime-api.js";
const ZAI_LIVE_TEST_FILE = "src/agents/zai.live.test.ts";

/** Live-test shards included in release validation. */
export const RELEASE_LIVE_TEST_SHARDS = Object.freeze([
  "native-live-src-agents",
  "native-live-src-agents-zai-coding",
  "native-live-src-gateway-core",
  "native-live-src-gateway-profiles",
  "native-live-src-gateway-backends",
  "native-live-src-infra",
  "native-live-test",
  "native-live-extensions-a-k",
  "native-live-extensions-l-n",
  "native-live-extensions-moonshot",
  "native-live-extensions-openai",
  "native-live-extensions-o-z-other",
  "native-live-extensions-xai",
  "native-live-extensions-media-audio",
  "native-live-extensions-media-music-google",
  "native-live-extensions-media-music-minimax",
  "native-live-extensions-media-video",
]);

/** All live-test shards, including broader local-only shard aliases. */
export const LIVE_TEST_SHARDS = Object.freeze([
  ...RELEASE_LIVE_TEST_SHARDS,
  "native-live-extensions-o-z",
  "native-live-extensions-media",
  "native-live-extensions-media-music",
]);

function walkFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "vendor" ||
          entry.name === "fixtures"
        ) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

/**
 * Lists all live test files from git/find fallback paths.
 */
export function collectAllLiveTestFiles(repoRoot = process.cwd()) {
  const externalFiles = listExternalLiveTestFiles(repoRoot);
  if (externalFiles) {
    return externalFiles;
  }
  return ["src", "test", "extensions"]
    .flatMap((dir) => walkFiles(path.join(repoRoot, dir)))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(LIVE_TEST_SUFFIX))
    .toSorted((a, b) => a.localeCompare(b));
}

function listExternalLiveTestFiles(repoRoot) {
  return listGitLiveTestFiles(repoRoot) ?? listFindLiveTestFiles(repoRoot);
}

function listGitLiveTestFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files", "--", "src", "test", "extensions"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.endsWith(LIVE_TEST_SUFFIX))
    .toSorted((a, b) => a.localeCompare(b));
}

function listFindLiveTestFiles(repoRoot) {
  const roots = ["src", "test", "extensions"].map((dir) => path.join(repoRoot, dir));
  const result = spawnSync(
    "find",
    [
      ...roots,
      "(",
      "-name",
      "node_modules",
      "-o",
      "-name",
      "dist",
      "-o",
      "-name",
      "vendor",
      "-o",
      "-name",
      "fixtures",
      ")",
      "-prune",
      "-o",
      "-type",
      "f",
      "-name",
      `*${LIVE_TEST_SUFFIX}`,
      "-print",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.length > 0)
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .toSorted((a, b) => a.localeCompare(b));
}

function extensionKey(file) {
  const relative = file.slice("extensions/".length);
  return relative.split("/", 1)[0]?.toLowerCase() ?? "";
}

function isExtensionInRange(file, start, end) {
  if (!file.startsWith("extensions/")) {
    return false;
  }
  const key = extensionKey(file);
  if (!key) {
    return false;
  }
  const first = key[0];
  return first >= start && first <= end;
}

function isGatewayBackendLiveTest(file) {
  return (
    file === "src/gateway/gateway-acp-bind.live.test.ts" ||
    file === "src/gateway/gateway-cli-backend.live.test.ts" ||
    file === "src/gateway/gateway-codex-bind.live.test.ts" ||
    file === "src/gateway/gateway-codex-harness.live.test.ts"
  );
}

function isGatewayProfilesLiveTest(file) {
  return file === "src/gateway/gateway-models.profiles.live.test.ts";
}

function isExtensionMediaLiveTest(file) {
  return (
    file === "extensions/music-generation-providers.live.test.ts" ||
    file === "extensions/minimax/minimax.live.test.ts" ||
    file === "extensions/openai/openai-tts.live.test.ts" ||
    file === "extensions/video-generation-providers.live.test.ts" ||
    file === "extensions/volcengine/tts.live.test.ts" ||
    file === "extensions/vydra/vydra.live.test.ts"
  );
}

function isExtensionMediaMusicLiveTest(file) {
  return file === "extensions/music-generation-providers.live.test.ts";
}

function isExtensionMediaVideoLiveTest(file) {
  return file === "extensions/video-generation-providers.live.test.ts";
}

function isExtensionMediaAudioLiveTest(file) {
  return (
    isExtensionMediaLiveTest(file) &&
    !isExtensionMediaMusicLiveTest(file) &&
    !isExtensionMediaVideoLiveTest(file)
  );
}

function isXaiLiveTest(file) {
  return file.startsWith("extensions/xai/");
}

function isMoonshotLiveTest(file) {
  return file.startsWith("extensions/moonshot/");
}

/**
 * Selects the live test files belonging to one shard name.
 */
export function selectLiveShardFiles(shard, files = collectAllLiveTestFiles()) {
  switch (shard) {
    case "native-live-src-agents":
      return files.filter(
        (file) =>
          file !== ZAI_LIVE_TEST_FILE &&
          (file.startsWith("src/agents/") ||
            file.startsWith("src/llm/") ||
            file.startsWith("src/skills/")),
      );
    case "native-live-src-agents-zai-coding":
      return files.filter((file) => file === ZAI_LIVE_TEST_FILE);
    case "native-live-src-gateway":
      return files.filter(
        (file) => file.startsWith("src/gateway/") || file.startsWith("src/system-agent/"),
      );
    case "native-live-src-gateway-core":
      return files.filter(
        (file) =>
          (file.startsWith("src/gateway/") || file.startsWith("src/system-agent/")) &&
          !isGatewayBackendLiveTest(file) &&
          !isGatewayProfilesLiveTest(file),
      );
    case "native-live-src-gateway-profiles":
      return files.filter(isGatewayProfilesLiveTest);
    case "native-live-src-gateway-backends":
      return files.filter(isGatewayBackendLiveTest);
    case "native-live-src-infra":
      return files.filter((file) => file.startsWith("src/infra/"));
    case "native-live-test":
      return files.filter((file) => file.startsWith("test/"));
    case "native-live-extensions-a-k":
      return files.filter((file) => isExtensionInRange(file, "a", "k"));
    case "native-live-extensions-l-n":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "l", "n") &&
          !file.startsWith("extensions/openai/") &&
          !isMoonshotLiveTest(file) &&
          !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-moonshot":
      return files.filter(isMoonshotLiveTest);
    case "native-live-extensions-openai":
      return files.filter(
        (file) => file.startsWith("extensions/openai/") && !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-o-z":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "o", "z") &&
          !file.startsWith("extensions/openai/") &&
          !isExtensionMediaLiveTest(file),
      );
    case "native-live-extensions-o-z-other":
      return files.filter(
        (file) =>
          isExtensionInRange(file, "o", "z") &&
          !file.startsWith("extensions/openai/") &&
          !isExtensionMediaLiveTest(file) &&
          !isXaiLiveTest(file),
      );
    case "native-live-extensions-xai":
      return files.filter(isXaiLiveTest);
    case "native-live-extensions-media":
      return files.filter(isExtensionMediaLiveTest);
    case "native-live-extensions-media-audio":
      return files.filter(isExtensionMediaAudioLiveTest);
    case "native-live-extensions-media-music":
    case "native-live-extensions-media-music-google":
    case "native-live-extensions-media-music-minimax":
      return files.filter(isExtensionMediaMusicLiveTest);
    case "native-live-extensions-media-video":
      return files.filter(isExtensionMediaVideoLiveTest);
    default:
      throw new Error(
        `Unknown live test shard '${shard}'. Expected one of: ${LIVE_TEST_SHARDS.join(", ")}`,
      );
  }
}

function usage(stream = process.stderr) {
  stream.write(
    `Usage: node scripts/test-live-shard.mjs <${LIVE_TEST_SHARDS.join("|")}> [--list]\n`,
  );
}

/**
 * Parses live-shard CLI args into shard name and Vitest passthrough args.
 */
export function parseLiveShardArgs(args) {
  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const passthroughArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  let shard = "";
  let listOnly = false;
  for (const arg of optionArgs) {
    if (arg === "--list") {
      listOnly = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (shard) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    shard = arg;
  }
  return { shard, listOnly, passthroughArgs };
}

/**
 * Builds pnpm/vitest args for selected live test files.
 */
export function buildLiveShardPnpmArgs(files, passthroughArgs) {
  return ["test:live", "--", ...files, ...passthroughArgs];
}

/**
 * Resolves build profiles required by selected live tests.
 */
export function resolveLiveShardPreparation(files) {
  return files.includes(QA_RUNTIME_LIVE_TEST)
    ? {
        env: { OPENCLAW_BUILD_PRIVATE_QA: "1" },
        profile: "qaRuntime",
        requiredArtifact: QA_RUNTIME_ARTIFACT,
      }
    : null;
}

/**
 * Builds the Vitest JSON report path used to prove that a live shard ran tests.
 */
export function buildLiveShardReportPath(shard, env = process.env) {
  const reportDir = env.OPENCLAW_LIVE_SHARD_REPORT_DIR || ".artifacts/live-shards";
  return path.join(reportDir, `${shard}.vitest.json`);
}

/**
 * Adds reporters needed for both operator logs and machine-readable evidence.
 */
export function addLiveShardReportArgs(passthroughArgs, reportPath) {
  return [
    ...passthroughArgs,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ];
}

function readNonNegativeInt(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Vitest report ${label} must be a non-negative integer.`);
  }
  return value;
}

function normalizeReportFilePath(value, repoRoot = process.cwd()) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const repoRelative = path.isAbsolute(text) ? path.relative(repoRoot, path.resolve(text)) : text;
  if (path.isAbsolute(repoRelative) || repoRelative.startsWith("..") || repoRelative === "") {
    return text.split(path.sep).join("/");
  }
  return repoRelative.split(path.sep).join("/");
}

function collectReportedLiveTestFiles(payload, repoRoot = process.cwd()) {
  if (!Array.isArray(payload?.testResults)) {
    return null;
  }
  return new Set(
    payload.testResults
      .map((result) => normalizeReportFilePath(result?.name, repoRoot))
      .filter((name) => name.length > 0),
  );
}

function readOptionalNonNegativeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isTruthyEnvValue(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isDisabledOptInAssertion(assertion) {
  if (assertion?.status !== "passed") {
    return false;
  }
  const fields = [
    assertion.fullName,
    assertion.title,
    ...(Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : []),
  ];
  const text = fields
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("disabled") && text.includes("opt-in");
}

function buildFilePassEvidence(result) {
  const evidence = {
    disabledOptInPassed: 0,
    passed: 0,
    statuses: [],
  };
  if (Array.isArray(result?.assertionResults)) {
    for (const assertion of result.assertionResults) {
      const status = typeof assertion?.status === "string" ? assertion.status : "";
      if (status) {
        evidence.statuses.push(status);
      }
      if (status === "passed") {
        evidence.passed += 1;
        if (isDisabledOptInAssertion(assertion)) {
          evidence.disabledOptInPassed += 1;
        }
      }
    }
    return evidence;
  }
  evidence.passed =
    readOptionalNonNegativeInt(result?.numPassingTests) ??
    readOptionalNonNegativeInt(result?.numPassedTests) ??
    0;
  return evidence;
}

function mergeFilePassEvidence(left, right) {
  return {
    disabledOptInPassed: left.disabledOptInPassed + right.disabledOptInPassed,
    passed: left.passed + right.passed,
    statuses: [...left.statuses, ...right.statuses],
  };
}

function collectReportedLiveTestFileEvidence(payload, repoRoot = process.cwd()) {
  if (!Array.isArray(payload?.testResults)) {
    return null;
  }
  const evidenceByFile = new Map();
  for (const result of payload.testResults) {
    const name = normalizeReportFilePath(result?.name, repoRoot);
    if (!name) {
      continue;
    }
    const evidence = buildFilePassEvidence(result);
    const existing = evidenceByFile.get(name);
    evidenceByFile.set(name, existing ? mergeFilePassEvidence(existing, evidence) : evidence);
  }
  return evidenceByFile;
}

function isDisabledOptionalLiveShardFile(file, evidence, env = process.env) {
  const requiredEnvNames = OPTIONAL_LIVE_SHARD_FILE_ENVS.get(file);
  if (!requiredEnvNames || requiredEnvNames.some((name) => isTruthyEnvValue(env[name]))) {
    return false;
  }
  const nonSentinelStatuses = evidence?.statuses.filter((status) => status !== "passed") ?? [];
  return (
    evidence?.statuses.length > 0 &&
    evidence.passed === evidence.disabledOptInPassed &&
    nonSentinelStatuses.every((status) => SKIPPED_ASSERTION_STATUSES.has(status))
  );
}

function countEnabledLivePasses(file, evidence, env = process.env) {
  if (
    OPTIONAL_LIVE_SHARD_FILE_ENVS.has(file) &&
    isDisabledOptionalLiveShardFile(file, evidence, env)
  ) {
    return 0;
  }
  return Math.max(0, (evidence?.passed ?? 0) - (evidence?.disabledOptInPassed ?? 0));
}

/**
 * Removes a previous JSON report before a shard run so stale success cannot be reused.
 */
export function removeLiveShardReportFile(reportPath) {
  fs.rmSync(reportPath, { force: true });
}

/**
 * Validates a Vitest JSON payload for live-shard proof.
 */
export function validateLiveShardReportPayload(
  payload,
  expectedFiles = [],
  repoRoot = process.cwd(),
  env = process.env,
) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "Vitest report is not an object." };
  }
  let passed;
  let total;
  try {
    passed = readNonNegativeInt(payload.numPassedTests, "numPassedTests");
    total = readNonNegativeInt(payload.numTotalTests, "numTotalTests");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (passed > total) {
    return { ok: false, reason: "Vitest report numPassedTests exceeds numTotalTests." };
  }
  if (passed < 1) {
    return { ok: false, reason: "Vitest report has no passing live tests." };
  }
  if (expectedFiles.length > 0) {
    const reportedFiles = collectReportedLiveTestFiles(payload, repoRoot);
    const fileEvidence = collectReportedLiveTestFileEvidence(payload, repoRoot);
    if (!reportedFiles || !fileEvidence) {
      return { ok: false, reason: "Vitest report is missing testResults file evidence." };
    }
    const missingFiles = expectedFiles
      .map((file) => normalizeReportFilePath(file, repoRoot))
      .filter((file) => !reportedFiles.has(file));
    if (missingFiles.length > 0) {
      return {
        ok: false,
        reason: `Vitest report missing selected live test file evidence: ${missingFiles.join(", ")}`,
      };
    }
    const enabledPassFiles = expectedFiles
      .map((file) => normalizeReportFilePath(file, repoRoot))
      .filter((file) => countEnabledLivePasses(file, fileEvidence.get(file), env) > 0);
    if (enabledPassFiles.length === 0) {
      return {
        ok: false,
        reason: "Vitest report has no enabled selected live test files with passing assertions.",
      };
    }
    const noPassFiles = expectedFiles
      .map((file) => normalizeReportFilePath(file, repoRoot))
      .filter((file) => {
        const evidence = fileEvidence.get(file);
        return (
          countEnabledLivePasses(file, evidence, env) < 1 &&
          !isDisabledOptionalLiveShardFile(file, evidence, env)
        );
      });
    if (noPassFiles.length > 0) {
      return {
        ok: false,
        reason: `Vitest report selected live test files had no passing assertions: ${noPassFiles.join(", ")}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reads and validates the live-shard Vitest JSON report.
 */
function validateLiveShardReport(reportPath, expectedFiles = []) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Unable to read Vitest report ${reportPath}: ${message}` };
  }
  return validateLiveShardReportPayload(payload, expectedFiles);
}

/**
 * Builds spawn options for the live-shard Vitest child.
 */
export function buildLiveShardSpawnParams(env = process.env, platform = process.platform) {
  return {
    detached: shouldUseDetachedVitestProcessGroup(platform),
    env,
    stdio: "inherit",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawArgs = process.argv.slice(2);
  const separatorIndex = rawArgs.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? rawArgs.slice(0, separatorIndex) : rawArgs;
  if (optionArgs.includes("--help") || optionArgs.includes("-h")) {
    usage(process.stdout);
    process.exit(0);
  }

  let parsedArgs;
  try {
    parsedArgs = parseLiveShardArgs(rawArgs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
  const { shard, listOnly, passthroughArgs } = parsedArgs;
  if (!shard) {
    usage();
    process.exit(2);
  }

  let files;
  try {
    files = selectLiveShardFiles(shard);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`Live test shard '${shard}' selected no files.`);
    process.exit(2);
  }

  if (listOnly) {
    for (const file of files) {
      console.log(file);
    }
    process.exit(0);
  }

  // Some live tests exercise built private surfaces. Prepare their owning profile so
  // shard routing cannot select a test whose required runtime artifact is absent.
  const preparation = resolveLiveShardPreparation(files);
  if (preparation) {
    console.log(
      `[test:live:shard] preparing ${preparation.profile} for ${preparation.requiredArtifact}`,
    );
    const result = spawnSync(process.execPath, ["scripts/build-all.mjs", preparation.profile], {
      env: { ...process.env, ...preparation.env },
      stdio: "inherit",
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.signal) {
      process.kill(process.pid, result.signal);
      process.exit(1);
    }
    if ((result.status ?? 1) !== 0) {
      process.exit(result.status ?? 1);
    }
    if (!fs.existsSync(preparation.requiredArtifact)) {
      console.error(
        `[test:live:shard] ${preparation.profile} did not produce ${preparation.requiredArtifact}`,
      );
      process.exit(1);
    }
  }

  console.log(`[test:live:shard] ${shard}: ${files.length} file(s)`);
  const reportPath = buildLiveShardReportPath(shard, process.env);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  removeLiveShardReportFile(reportPath);
  const child = spawnPnpmRunner({
    pnpmArgs: buildLiveShardPnpmArgs(files, addLiveShardReportArgs(passthroughArgs, reportPath)),
    ...buildLiveShardSpawnParams(process.env),
  });
  let forwardedSignal = null;
  const teardown = installVitestProcessGroupCleanup({
    child,
    forceSignal: "SIGKILL",
    forceSignalDelayMs: 100,
    onSignal: (signal) => {
      forwardedSignal ??= signal;
    },
  });
  child.on("exit", (code, signal) => {
    teardown();
    if (forwardedSignal) {
      forwardSignalToVitestProcessGroup({
        child,
        kill: process.kill.bind(process),
        signal: "SIGKILL",
      });
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if ((code ?? 1) === 0) {
      const validation = validateLiveShardReport(reportPath, files);
      if (!validation.ok) {
        process.stderr.write(`[test:live:shard] ${validation.reason}\n`);
        process.exit(1);
      }
    }
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    teardown();
    console.error(error);
    process.exit(1);
  });
}
