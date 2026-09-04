#!/usr/bin/env node
// Resolves and delegates to the repo-local or PATH crabbox binary.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { crabboxProviderChain, normalizeCrabboxWorkload } from "./crabbox-routing-policy.mts";
import {
  prepareCrabboxSourceCapsule,
  type CrabboxSourceCapsule,
} from "./crabbox-source-capsule.mts";
import { remoteSourceBootstrap } from "./crabbox-source-receiver.mts";
import {
  canonicalProviderName,
  isProviderAdvertised,
  parseProvidersFromHelp,
} from "./crabbox-wrapper-providers.mts";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
} from "./testbox-lease-freshness.mts";
import { resolvePathEnvKey, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

type CommandOption = { index: number; value: string };
type CommandInvocation = ReturnType<typeof parseCommandInvocation>;
type CommandNormalizeOptions = { canShimIgnoreEnvironment?: boolean };
type TargetContext = ReturnType<typeof effectiveTargetContext>;
type ProcessEnv = NodeJS.ProcessEnv;
type Platform = NodeJS.Platform;
type Signal = NodeJS.Signals;
type ProviderReadiness = ReturnType<typeof crabboxProviderReadiness>;
type ProviderSelection = ReturnType<typeof selectedProvider>;
type RunFacts = ReturnType<typeof analyzeRemoteCommand>;
type AwsMacosScriptRequirements = ReturnType<typeof awsMacosScriptBootstrapRequirements>;
type FullCheckout = ReturnType<typeof prepareFullCheckoutForSync>;
type KeepaliveOptions = { intervalMs?: number; onMissing?: () => void };
type DoctorCheck = { status: string; check: string; details?: Record<string, string> };
type DoctorResult = { ok: boolean; provider: string; checks: DoctorCheck[] };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRABBOX_METADATA_PROBE_TIMEOUT_MS = 5_000;
const MAX_TIMING_JSON_LINE_CHARS = 1024 * 1024;
// A cold Crabbox (first call after an upgrade, or one on a loaded machine) can
// exceed the snappy default probe timeout while it renders `run --help` or does
// first-run init. Retry the metadata probes once with this generous timeout so a
// single slow probe does not hard-fail the wrapper and block all remote validation.
const CRABBOX_METADATA_PROBE_RETRY_TIMEOUT_MS = 20_000;
const ignoreRepoBinary = process.env.OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY === "1";
const repoLocal = ignoreRepoBinary ? null : resolveCrabboxBinary(process.platform);
const pathLocal = resolvePathBinary("crabbox", process.env, process.platform);
const binary =
  repoLocal ??
  pathLocal ??
  resolveGitCommonCrabboxBinary(process.env, process.platform) ??
  "crabbox";
const args = process.argv.slice(2);

if (args[0] === "--") {
  args.shift();
}
const workloadCommand = isWorkloadRoutedCommand(args);
const workloadOption = workloadCommand ? extractWrapperValueOption(args, "--workload") : undefined;
const userArgStart = commandUserArgStart(args);

function extractWrapperValueOption(commandArgs: string[], name: string) {
  const equalsPrefix = `${name}=`;
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index] ?? "";
    if (arg === "--") {
      break;
    }
    if (arg === name) {
      const value = commandArgs[index + 1];
      if (!value || value === "--" || value.startsWith("-")) {
        commandArgs.splice(index, 1);
        return null;
      }
      commandArgs.splice(index, 2);
      return value;
    }
    if (arg.startsWith(equalsPrefix)) {
      commandArgs.splice(index, 1);
      return arg.slice(equalsPrefix.length) || null;
    }
  }
  return undefined;
}

function isWorkloadRoutedCommand(commandArgs: string[]) {
  return (
    ["run", "warmup"].includes(commandArgs[0] ?? "") ||
    (commandArgs[0] === "actions" && commandArgs[1] === "hydrate")
  );
}

function commandUserArgStart(commandArgs: string[]) {
  return commandArgs[0] === "actions" && commandArgs[1] === "hydrate" ? 2 : 1;
}

function commandCandidates(command: string, platform: Platform) {
  if (platform !== "win32") {
    return [command];
  }
  if (extname(command)) {
    return [command];
  }
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.com`, command];
}

function resolveCrabboxBinary(platform: Platform) {
  const base = resolve(repoRoot, "../crabbox/bin/crabbox");
  for (const candidate of commandCandidates(base, platform)) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function resolvePathBinary(command: string, env: ProcessEnv, platform: Platform) {
  const pathValue = env[resolvePathEnvKey(env)] ?? "";
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of commandCandidates(command, platform)) {
      const fullPath = resolve(dir, candidate);
      if (isExecutableFile(fullPath, platform)) {
        return fullPath;
      }
    }
  }
  return null;
}

function resolveGitCommonCrabboxBinary(env: ProcessEnv, platform: Platform) {
  const gitBinary = resolvePathBinary("git", env, platform) ?? "git";
  const invocation = spawnInvocation(gitBinary, ["rev-parse", "--git-common-dir"], env, platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if ((result.status ?? 1) !== 0) {
    return null;
  }
  const gitCommonDir = result.stdout.trim();
  if (!gitCommonDir) {
    return null;
  }
  const absoluteGitCommonDir = isAbsolute(gitCommonDir)
    ? gitCommonDir
    : resolve(repoRoot, gitCommonDir);
  const base = resolve(absoluteGitCommonDir, "../..", "crabbox/bin/crabbox");
  for (const candidate of commandCandidates(base, platform)) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: PathLike, platform: Platform) {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function spawnInvocation(
  command: string,
  commandArgs: string[],
  env: ProcessEnv,
  platform: Platform,
) {
  const extension = extname(command).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const nodeShim = resolveNodeCmdShim(command, platform);
    if (nodeShim) {
      return {
        command: nodeShim.node,
        args: [...nodeShim.args, ...commandArgs],
      };
    }
    return {
      command: resolveWindowsCmdExePath(env),
      args: ["/d", "/s", "/c", buildBatchCommandLine(command, commandArgs)],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: commandArgs };
}

function resolveNodeCmdShim(command: string, platform: Platform) {
  let content;
  try {
    content = readFileSync(command, "utf8");
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^"([^"]+node(?:\.exe)?)"\s+"%~dp0([^"]+)"\s+%\*$/iu.exec(line);
    if (!match) {
      continue;
    }
    const script = resolve(dirname(command), match[2] ?? "");
    if (!isExecutableFile(script, platform)) {
      continue;
    }
    return { node: match[1] ?? "node", args: [script] };
  }
  const npmCmdShim = resolveNpmNodeCmdShim(command, content, platform);
  if (npmCmdShim) {
    return npmCmdShim;
  }
  return null;
}

function resolveNpmNodeCmdShim(command: string, content: string, platform: Platform) {
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  if (
    !lines.some((line) => /^IF EXIST "%dp0%\\node\.exe" \($/iu.test(line)) ||
    !lines.some((line) => /^SET "_prog=node(?:\.exe)?"$/iu.test(line))
  ) {
    return null;
  }
  const invocation = lines.find((line) => line.includes('"%_prog%"') && line.endsWith("%*"));
  if (!invocation) {
    return null;
  }
  const match = /(?:^|&)\s*"%_prog%"\s+(.*?)"(%dp0%\\[^"]+)"\s+%\*$/iu.exec(invocation);
  if (!match || (match[1] ?? "").trim()) {
    return null;
  }
  const script = resolve(dirname(command), (match[2] ?? "").replace(/^%dp0%\\/iu, ""));
  if (!isExecutableFile(script, platform)) {
    return null;
  }
  const localNode = resolve(dirname(command), "node.exe");
  return { node: isExecutableFile(localNode, platform) ? localNode : "node", args: [script] };
}

const cmdMetaCharactersRe = /([()\][%!^"`<>&|;, *?])/g;
const jsRuntimeEntrypoints = new Set([
  "pnpm",
  "npm",
  "npx",
  "corepack",
  "node",
  "yarn",
  "bun",
  "bunx",
]);
const awsMacosCorepackEntrypoints = new Set(["pnpm", "yarn", "corepack"]);
const awsMacosBunEntrypoints = new Set(["bun", "bunx"]);
const awsMacosBunVersion = "1.4.0";
const awsMacosSwiftEntrypoints = new Set(["swift", "xcodebuild"]);
const awsMacosSwiftScriptTargets = new Set([
  "mac:package",
  "mac:restart",
  "scripts/build-and-run-mac.sh",
  "scripts/package-mac-app.sh",
  "scripts/package-mac-dist.sh",
  "scripts/restart-mac.sh",
]);
const awsMacosPackageManagerScriptTargets = new Set([
  "scripts/package-mac-app.sh",
  "scripts/package-mac-dist.sh",
  "scripts/restart-mac.sh",
]);
const minimumBlacksmithCrabboxVersion = [0, 22, 0];
const minimumSourceCapsuleCrabboxVersion = [0, 37, 0];
const minimumBrokeredDaytonaCrabboxVersion = [0, 40, 0];
const shellControlCommandPrefixes = new Set([
  "if",
  "while",
  "until",
  "then",
  "do",
  "else",
  "elif",
  "!",
]);
const shellCommandExecutionPrefixes = new Set(["exec"]);
const shellInlineCommandInterpreters = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const remoteChangedGateEnv = [
  "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
  "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
  "CI=1",
];
const shellInlineCommandOptionsWithNextValue = new Set([
  "+O",
  "+o",
  "-O",
  "-o",
  "--init-file",
  "--rcfile",
]);
const nodeOptionsWithNextValueBeforeScript = new Set([
  "--allow-fs-read",
  "--allow-fs-write",
  "--conditions",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--debug-port",
  "--diagnostic-dir",
  "--disable-proto",
  "--disable-warning",
  "--dns-result-order",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--experimental-loader",
  "--experimental-test-isolation",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--heap-prof-name",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--icu-data-dir",
  "--import",
  "--inspect-port",
  "--inspect-publish-uid",
  "--initial-old-space-size",
  "--localstorage-file",
  "--loader",
  "--max-http-header-size",
  "--max-old-space-size",
  "--max-old-space-size-percentage",
  "--max-semi-space-size",
  "--network-family-autoselection-attempt-timeout",
  "--openssl-config",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--report-filename",
  "--report-signal",
  "--require",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-rerun-failures",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
  "--title",
  "--tls-cipher-list",
  "--tls-keylog",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--trace-require-module",
  "--unhandled-rejections",
  "--use-largepages",
  "--v8-pool-size",
  "--watch-kill-signal",
  "--watch-path",
  "-C",
  "-r",
]);
const nodeOptionsWithoutScript = new Set([
  "--build-sea",
  "--build-snapshot",
  "--build-snapshot-config",
  "--check",
  "--completion-bash",
  "--eval",
  "--experimental-sea-config",
  "--help",
  "--input-type",
  "--interactive",
  "--print",
  "--prof-process",
  "--run",
  "--v8-options",
  "--version",
  "-c",
  "-e",
  "-h",
  "-i",
  "-p",
  "-v",
]);

function escapeBatchCommand(command: string) {
  return command.replace(cmdMetaCharactersRe, "^$1");
}

function escapeBatchArgument(arg: string) {
  let escaped = arg;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(cmdMetaCharactersRe, "^$1");
  return escaped.replace(cmdMetaCharactersRe, "^$1");
}

function buildBatchCommandLine(command: string, commandArgs: string[]) {
  const escapedCommand = escapeBatchCommand(command);
  const escapedArgs = commandArgs.map(escapeBatchArgument);
  return `"${[escapedCommand, ...escapedArgs].join(" ")}"`;
}

function checkedOutput(
  command: string,
  commandArgs: string[],
  timeoutMs: number | null = resolveMetadataProbeTimeoutMs(process.env),
) {
  const invocation = spawnInvocation(command, commandArgs, process.env, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(timeoutMs === null ? {} : { timeout: timeoutMs }),
    killSignal: "SIGKILL",
  });
  const timedOut = result.error?.name === "Error" && result.signal === "SIGKILL";
  return {
    status: timedOut ? 124 : (result.status ?? 1),
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    stdout: (result.stdout ?? "").trim(),
  };
}

function recoveryCommand(commandArgs: string[]) {
  return [binary, ...commandArgs].map(recoveryCommandArgument).join(" ");
}

function recoveryCommandArgument(value: string) {
  const text = value;
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(text)) {
    return text;
  }
  if (process.platform === "win32") {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// Probe Crabbox metadata (`--version` / `run --help`) with one generous retry.
// A cold Crabbox can be SIGKILLed by the snappy default timeout or emit nothing
// on the first call, then be instant and clean on the next. Retrying keeps the
// warm path fast (one ~instant probe) while stopping a single slow probe from
// tripping the sanity/provider-list guards and blocking all remote validation.
function probeCrabboxMetadata(command: string, commandArgs: string[]) {
  const first = checkedOutput(command, commandArgs);
  if (first.status === 0 && first.text.length > 0) {
    return first;
  }
  return checkedOutput(command, commandArgs, CRABBOX_METADATA_PROBE_RETRY_TIMEOUT_MS);
}

function supportsPreparedTestboxArtifacts() {
  const metadata = checkedOutput(binary, ["providers", "describe", "blacksmith-testbox", "--json"]);
  if (metadata.status !== 0) {
    return false;
  }
  try {
    const description: unknown = JSON.parse(metadata.stdout);
    if (
      !isRecord(description) ||
      description.schemaVersion !== 2 ||
      !isRecord(description.provider) ||
      description.provider.canonical !== "blacksmith-testbox" ||
      !isRecord(description.capabilities)
    ) {
      return false;
    }
    const features = description.capabilities.features;
    return (
      Array.isArray(features) &&
      features.every((feature) => typeof feature === "string") &&
      features.includes("prepared-artifact-workspace")
    );
  } catch {
    return false;
  }
}

function parseCrabboxVersion(value: string) {
  const match = value.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:-([^\s+]+))?(?:\+[^\s]+)?\b/u);
  if (!match) {
    return null;
  }
  const major = parseVersionTuplePart(match[1] ?? "");
  const minor = parseVersionTuplePart(match[2] ?? "");
  const patch = parseVersionTuplePart(match[3] ?? "");
  if (major === null || minor === null || patch === null) {
    return null;
  }
  return {
    tuple: [major, minor, patch],
    suffix: match[4] ?? "",
  };
}

function parseVersionTuplePart(value: string) {
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareVersionTuples(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function formatVersionTuple(version: readonly number[]) {
  return version.join(".");
}

function isPostReleaseDescribeSuffix(suffix: string) {
  return /^\d+-g[0-9a-f]+(?:-dirty)?$/iu.test(suffix);
}

function satisfiesMinimumCrabboxVersion(version: string, minimum: number[]) {
  const parsed = parseCrabboxVersion(version);
  if (!parsed) {
    return false;
  }
  const comparison = compareVersionTuples(parsed.tuple, minimum);
  if (comparison !== 0) {
    return comparison > 0;
  }
  return !parsed.suffix || isPostReleaseDescribeSuffix(parsed.suffix);
}

function gitOutput(commandArgs: string[], extraEnv: ProcessEnv = {}) {
  const gitBinary = resolvePathBinary("git", process.env, process.platform) ?? "git";
  const gitEnv = { ...process.env, ...extraEnv, GIT_CONFIG_GLOBAL: "/dev/null" };
  const invocation = spawnInvocation(gitBinary, commandArgs, gitEnv, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return {
    status: result.status ?? 1,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    stdout: (result.stdout ?? "").trim(),
  };
}

let resolvedCrabboxConfigCache: Record<string, unknown> | null | undefined;

function resolvedCrabboxConfig() {
  if (resolvedCrabboxConfigCache !== undefined) {
    return resolvedCrabboxConfigCache;
  }
  const result = checkedOutput(binary, ["config", "show", "--json"]);
  if (result.status !== 0) {
    resolvedCrabboxConfigCache = null;
    return resolvedCrabboxConfigCache;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout || result.text);
    resolvedCrabboxConfigCache = isRecord(parsed) ? parsed : null;
  } catch {
    resolvedCrabboxConfigCache = null;
  }
  return resolvedCrabboxConfigCache;
}

function envProvider() {
  const envProviderValue = process.env.CRABBOX_PROVIDER?.trim();
  if (envProviderValue) {
    return envProviderValue;
  }
  return "";
}

function configProvider() {
  const resolved = resolvedCrabboxConfig()?.provider;
  if (typeof resolved === "string" && resolved.trim()) {
    return resolved.trim();
  }
  try {
    const config = readFileSync(resolve(repoRoot, ".crabbox.yaml"), "utf8");
    const match = config.match(/^provider:\s*([^\s#]+)/m);
    return match?.[1] ?? "aws";
  } catch {
    return "aws";
  }
}

function effectiveTargetContext(commandArgs: string[]) {
  const config = resolvedCrabboxConfig();
  const configuredTarget = typeof config?.target === "string" ? config.target.trim() : "";
  const configuredWindowsMode =
    typeof config?.windowsMode === "string" ? config.windowsMode.trim() : "";
  return {
    target: (
      optionValue(commandArgs, "--target") ||
      process.env.CRABBOX_TARGET?.trim() ||
      process.env.CRABBOX_TARGET_OS?.trim() ||
      configuredTarget
    ).toLowerCase(),
    windowsMode: (
      optionValue(commandArgs, "--windows-mode") ||
      process.env.CRABBOX_WINDOWS_MODE?.trim() ||
      configuredWindowsMode
    ).toLowerCase(),
  };
}

let commandValueOptionsFromHelp: Set<string>;

function parseCommandValueOptionsFromHelp(text: string) {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(
      /^\s+-{1,2}([a-z0-9][a-z0-9-]*)\s+(?:string|duration|int|float|value)\b/u,
    );
    if (match) {
      names.add(match[1] ?? "");
    }
  }
  return names;
}

function commandOptionName(arg: string) {
  return arg.replace(/^-+/u, "").split("=", 1)[0] ?? "";
}

function parseCommandInvocation(helpText: string, commandArgs: string[]) {
  commandValueOptionsFromHelp ??= parseCommandValueOptionsFromHelp(helpText);
  const routedCommand = isWorkloadRoutedCommand(commandArgs);
  const optionStart = routedCommand ? commandUserArgStart(commandArgs) : 0;
  let start = -1;
  // A leaf value may itself be --; only unconsumed tokens end its option prefix.
  let optionEnd = routedCommand ? commandArgs.length : commandArgs.indexOf("--");
  optionEnd = optionEnd < 0 ? commandArgs.length : optionEnd;
  if (routedCommand) {
    for (let index = optionStart; index < commandArgs.length; index += 1) {
      const arg = commandArgs[index] ?? "";
      if (arg === "--") {
        start = index + 1;
        optionEnd = index;
        break;
      }
      if (arg === "-" || !arg.startsWith("-")) {
        start = index;
        optionEnd = index;
        break;
      }
      if (!arg.includes("=") && commandValueOptionsFromHelp.has(commandOptionName(arg))) {
        index += 1;
      }
    }
  }

  const optionEntries: Array<CommandOption & { name: string }> = [];
  const options = new Map<string, CommandOption>();
  for (let index = optionStart; index < optionEnd; index += 1) {
    const arg = commandArgs[index] ?? "";
    if (!arg.startsWith("-")) {
      continue;
    }
    const name = commandOptionName(arg);
    const assigned = arg.indexOf("=");
    const consumesValue = !routedCommand || commandValueOptionsFromHelp.has(name);
    const entry = {
      index,
      value:
        assigned >= 0
          ? arg.slice(assigned + 1)
          : consumesValue
            ? (commandArgs[index + 1] ?? "")
            : "",
    };
    optionEntries.push({ name, ...entry });
    if (!options.has(name)) {
      options.set(name, entry);
    }
    if (routedCommand && assigned < 0 && consumesValue) {
      index += 1;
    }
  }

  return {
    args: commandArgs,
    commandArgs: start >= 0 ? commandArgs.slice(start) : [],
    optionEntries,
    options,
    optionEnd,
    start,
  };
}

function commandProvider(commandArgsInput: string[]) {
  return optionValue(commandArgsInput, "--provider");
}

function selectedProvider(
  commandArgs: string[],
  advertisedProviders: string[] = [],
  versionText = "",
) {
  const targetContext = effectiveTargetContext(commandArgs);
  if (workloadOption === null) {
    return {
      provider: "",
      source: "policy",
      workload: "",
      chain: [],
      error: "--workload requires a value",
    };
  }
  const workload = requestedWorkload(commandArgs);
  if (workload === null) {
    return {
      provider: "",
      source: "policy",
      workload: workloadOption ?? process.env.OPENCLAW_CRABBOX_WORKLOAD ?? "",
      chain: [],
      error: `unsupported Crabbox workload ${JSON.stringify(workloadOption ?? process.env.OPENCLAW_CRABBOX_WORKLOAD)}`,
    };
  }
  if (workload === "windows" && targetContext.target !== "windows") {
    return {
      provider: "",
      source: "policy",
      workload,
      chain: [],
      error: "Crabbox workload=windows requires target=windows",
    };
  }
  const configured = canonicalProviderName(configProvider());
  const chain = workload
    ? crabboxProviderChain({
        workload,
        configuredProvider: configured,
        target: targetContext.target,
        advertisedProviders: advertisedProviders.map(canonicalProviderName),
      })
    : [];
  if (workload === "untrusted" && hasOption(commandArgs, "--id")) {
    return {
      provider: "",
      source: "policy",
      workload,
      chain,
      error:
        "Crabbox workload=untrusted requires a fresh lease; --id reuse is forbidden without persisted workload provenance",
    };
  }
  const explicitProvider = commandProvider(commandArgs);
  if (explicitProvider) {
    const canonicalExplicitProvider = canonicalProviderName(explicitProvider);
    if (workload && !chain.includes(canonicalExplicitProvider)) {
      return {
        provider: "",
        source: "explicit",
        workload,
        chain,
        error: `provider=${canonicalExplicitProvider} is not eligible for workload=${workload}; allowed=${chain.join(",") || "none"}`,
      };
    }
    return { provider: explicitProvider, source: "explicit", workload, chain };
  }
  const environmentProvider = envProvider();
  if (environmentProvider) {
    const canonicalEnvironmentProvider = canonicalProviderName(environmentProvider);
    if (workload && !chain.includes(canonicalEnvironmentProvider)) {
      return {
        provider: "",
        source: "environment",
        workload,
        chain,
        error: `provider=${canonicalEnvironmentProvider} is not eligible for workload=${workload}; allowed=${chain.join(",") || "none"}`,
      };
    }
    return { provider: environmentProvider, source: "environment", workload, chain };
  }
  if (workload && hasOption(commandArgs, "--id")) {
    return {
      provider: "",
      source: "policy",
      workload,
      chain: [],
      error:
        "reusing a workload-routed lease with --id requires --provider (or CRABBOX_PROVIDER) from the originating route",
    };
  }
  if (!workload && shouldPreferAzureForWindows(commandArgs, advertisedProviders)) {
    return { provider: "azure", source: "windows-default", workload: "", chain: [] };
  }
  if (!workload) {
    return { provider: configured, source: "config", workload: "", chain: [] };
  }

  const readiness = new Map<string, ProviderReadiness>();
  let selectedProviderName = "";
  for (const candidate of chain) {
    const status = crabboxProviderReadiness(candidate, versionText, targetContext);
    readiness.set(candidate, status);
    if (status.ready) {
      selectedProviderName = candidate;
      break;
    }
  }
  if (!selectedProviderName) {
    return {
      provider: "",
      source: "policy",
      workload,
      chain,
      readiness,
      error: `no ready provider for workload=${workload}`,
    };
  }
  return {
    provider: selectedProviderName,
    source: "policy",
    workload,
    chain,
    readiness,
  };
}

function requestedWorkload(commandArgs: string[]) {
  if (!isWorkloadRoutedCommand(commandArgs)) {
    return "";
  }
  const raw = workloadOption ?? process.env.OPENCLAW_CRABBOX_WORKLOAD?.trim() ?? "";
  if (!raw) {
    return "";
  }
  return normalizeCrabboxWorkload(raw);
}

function crabboxProviderReadiness(provider: string, version: string, context: TargetContext) {
  const canonicalProvider = canonicalProviderName(provider);
  if (
    canonicalProvider === "blacksmith-testbox" &&
    !satisfiesMinimumCrabboxVersion(version, minimumBlacksmithCrabboxVersion)
  ) {
    return {
      ready: false,
      reason: `requires Crabbox >= ${formatVersionTuple(minimumBlacksmithCrabboxVersion)} for Blacksmith Testbox`,
      recovery: "update Crabbox, then retry",
    };
  }
  if (
    canonicalProvider === "daytona" &&
    !satisfiesMinimumCrabboxVersion(version, minimumBrokeredDaytonaCrabboxVersion)
  ) {
    return {
      ready: false,
      reason: `requires Crabbox >= ${formatVersionTuple(minimumBrokeredDaytonaCrabboxVersion)} for brokered Daytona`,
      recovery: "update Crabbox, then retry",
    };
  }
  const doctorArgs = ["doctor", "--provider", canonicalProvider];
  if (context.target) {
    doctorArgs.push("--target", context.target);
  }
  if (context.target === "windows" && context.windowsMode) {
    doctorArgs.push("--windows-mode", context.windowsMode);
  }
  doctorArgs.push("--json");
  // Crabbox owns the provider deadlines; wait for it to serialize the final stdout document.
  const doctor = checkedOutput(binary, doctorArgs, null);
  const result = parseDoctorResult(doctor.stdout, canonicalProvider, doctor.status);
  const managed = ["aws", "azure", "daytona"].includes(canonicalProvider);
  const broker = result?.checks.find((check) => check.check === "broker");
  const brokerReady = !managed || broker?.status === "ok";
  const brokerAuthFailure =
    result?.checks.some(
      (check) => check.status === "failed" && check.details?.class === "broker_auth",
    ) === true;
  const ready = result?.ok === true && brokerReady;
  const diagnostic = compactDiagnosticText(doctor.text);
  return {
    ready,
    reason: ready
      ? "doctor-ready"
      : result
        ? `doctor exited ${doctor.status}${diagnostic ? `: ${diagnostic}` : ""}`
        : `invalid doctor JSON${diagnostic ? `: ${diagnostic}` : ""}`,
    ...(ready ? {} : { recovery: `run \`${recoveryCommand(doctorArgs)}\`` }),
    brokerReady,
    brokerAuthFailure,
  };
}

function isDoctorCheck(value: unknown): value is DoctorCheck {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    Boolean(value.status) &&
    typeof value.check === "string" &&
    Boolean(value.check) &&
    (value.details === undefined ||
      (isRecord(value.details) &&
        Object.values(value.details).every((detail) => typeof detail === "string")))
  );
}

function parseDoctorResult(value: string, provider: string, status: number): DoctorResult | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed.ok !== "boolean" ||
      parsed.provider !== provider ||
      !Array.isArray(parsed.checks) ||
      (parsed.ok ? status !== 0 : status !== 1)
    ) {
      return null;
    }
    const checks = parsed.checks;
    if (
      !checks.every(isDoctorCheck) ||
      parsed.ok !==
        checks.every((check) => !["failed", "missing"].includes(check.status.trim().toLowerCase()))
    ) {
      return null;
    }
    return parsed as DoctorResult;
  } catch {
    return null;
  }
}

function compactDiagnosticText(value: string, maxLength = 500) {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatProviderReadiness(readiness: ReadonlyMap<string, ProviderReadiness>) {
  return [...readiness.entries()]
    .map(([candidate, status]) => `${candidate}:${status.ready ? "ready" : status.reason}`)
    .join(",");
}

function providerRecoveryAdvice(readiness: ReadonlyMap<string, ProviderReadiness>) {
  return [
    ...new Set(
      [...readiness.values()]
        .map((status) => status.recovery)
        .filter((recovery) => typeof recovery === "string" && recovery.length > 0),
    ),
  ];
}

function shouldRequireBrokeredCloud(commandArgs: string[], provider: string, explicit = false) {
  const canonicalProvider = canonicalProviderName(provider);
  if (!["aws", "azure", "daytona"].includes(canonicalProvider)) {
    // Blacksmith Testbox is provider-owned and does not use the managed
    // coordinator auth required by brokered cloud capacity.
    return false;
  }
  // Route policy wins before explicit-provider and direct-debug exemptions.
  if (requestedWorkload(commandArgs)) {
    return true;
  }
  if (explicit && directCloudOverrideEnabled(provider)) {
    return false;
  }
  return (
    commandArgs[0] === "run" ||
    commandArgs[0] === "warmup" ||
    (commandArgs[0] === "actions" && commandArgs[1] === "hydrate")
  );
}

function directCloudOverrideEnabled(providerName: string) {
  return (
    canonicalProviderName(providerName) !== "aws" &&
    process.env.OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD === "1"
  );
}

function enforceBrokeredDaytonaVersion(
  commandArgs: string[],
  providerName: string,
  versionText: string,
  explicitProviderRequested: boolean | undefined,
) {
  if (
    canonicalProviderName(providerName) !== "daytona" ||
    !shouldRequireBrokeredCloud(commandArgs, providerName, explicitProviderRequested) ||
    satisfiesMinimumCrabboxVersion(versionText, minimumBrokeredDaytonaCrabboxVersion)
  ) {
    return;
  }
  console.error(
    [
      `[crabbox] provider=daytona requires Crabbox >= ${formatVersionTuple(minimumBrokeredDaytonaCrabboxVersion)} for brokered execution.`,
      `[crabbox] selected binary reported version=${versionText || "unknown"}.`,
      "[crabbox] update Crabbox before brokered Daytona execution.",
      "[crabbox] direct Daytona debugging requires an original `--provider daytona`, no `--workload`, and OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD=1.",
    ].join("\n"),
  );
  process.exit(2);
}

function enforceBrokeredCloud(
  commandArgs: string[],
  provider: string,
  explicit: boolean | undefined,
  routedReadiness?: ProviderReadiness,
) {
  if (!shouldRequireBrokeredCloud(commandArgs, provider, explicit)) {
    return;
  }
  const canonicalProvider = canonicalProviderName(provider);
  const readiness =
    routedReadiness ??
    crabboxProviderReadiness(canonicalProvider, version.text, effectiveTargetContext(commandArgs));
  if ("brokerAuthFailure" in readiness && readiness.brokerAuthFailure) {
    const instructions = [
      `[crabbox] provider=${canonicalProvider} requires managed Crabbox broker authentication for OpenClaw proof.`,
      `[crabbox] run \`${recoveryCommand(["login", "--url", "https://crabbox.openclaw.ai"])}\`, then retry.`,
    ];
    if (canonicalProvider !== "aws") {
      instructions.push(
        `[crabbox] direct ${canonicalProvider} debugging requires an original \`--provider ${canonicalProvider}\`, no \`--workload\`, and OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD=1.`,
      );
    }
    console.error(instructions.join("\n"));
    process.exit(2);
  }
  if (!("brokerReady" in readiness) || !readiness.brokerReady) {
    console.error(
      [
        `[crabbox] provider=${canonicalProvider} failed readiness for OpenClaw proof: ${readiness.reason}.`,
        ...(readiness.recovery ? [`[crabbox] recovery: ${readiness.recovery}.`] : []),
      ].join("\n"),
    );
    process.exit(2);
  }
}

function optionValue(commandArgsInput: string[], name: string) {
  return (
    parseCommandInvocation(help.text, commandArgsInput).options.get(commandOptionName(name))
      ?.value ?? ""
  );
}

function hasOption(commandArgsInput: string[], name: string) {
  return parseCommandInvocation(help.text, commandArgsInput).options.has(commandOptionName(name));
}

function commandOptionEnd(commandArgs: string[]) {
  return parseCommandInvocation(help.text, commandArgs).optionEnd;
}

function shouldPreferAzureForWindows(commandArgs: string[], advertisedProviders: string[] = []) {
  return (
    ["run", "warmup"].includes(commandArgs[0] ?? "") &&
    isWindowsRemoteTarget(commandArgs) &&
    !commandProvider(commandArgs) &&
    !envProvider() &&
    !hasOption(commandArgs, "--id") &&
    advertisedProviders.includes("azure")
  );
}

function ensureAzureWindowsProvider(
  commandArgs: string[],
  provider: string,
  advertised: string[] = [],
) {
  if (provider !== "azure" || !shouldPreferAzureForWindows(commandArgs, advertised)) {
    return commandArgs;
  }

  const optionEnd = commandOptionEnd(commandArgs);
  const normalizedArgs = [...commandArgs];
  normalizedArgs.splice(optionEnd, 0, "--provider", "azure");
  return normalizedArgs;
}

function ensurePolicyProvider(commandArgs: string[], selection: ProviderSelection) {
  if (
    selection.source !== "policy" ||
    !selection.provider ||
    commandProvider(commandArgs) ||
    envProvider()
  ) {
    return commandArgs;
  }
  const normalizedArgs = [...commandArgs];
  const optionEnd = commandOptionEnd(normalizedArgs);
  normalizedArgs.splice(optionEnd, 0, "--provider", selection.provider);
  return normalizedArgs;
}

function ensureAwsMacOnDemandMarket(commandArgs: string[], providerName: string) {
  if (
    !["run", "warmup"].includes(commandArgs[0] ?? "") ||
    providerName !== "aws" ||
    optionValue(commandArgs, "--target") !== "macos" ||
    hasOption(commandArgs, "--market") ||
    hasOption(commandArgs, "--id")
  ) {
    return commandArgs;
  }

  const optionEnd = commandOptionEnd(commandArgs);
  const normalizedArgs = [...commandArgs];
  normalizedArgs.splice(optionEnd, 0, "--market", "on-demand");
  return normalizedArgs;
}

function ensureNativeWindowsHydrateJob(commandArgs: string[]) {
  if (
    commandArgs[0] !== "actions" ||
    commandArgs[1] !== "hydrate" ||
    !isNativeWindowsRemoteTarget(commandArgs)
  ) {
    return commandArgs;
  }

  const invocation = parseCommandInvocation(help.text, commandArgs);
  const job = invocation.options.get("job");
  if (job?.value && job.value !== "hydrate") {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const replacementJob = "hydrate-windows-daemon";
  if (job) {
    const arg = normalizedArgs[job.index] ?? "";
    if (arg.includes("=")) {
      normalizedArgs[job.index] = `${arg.slice(0, arg.indexOf("=") + 1)}${replacementJob}`;
    } else {
      normalizedArgs[job.index + 1] = replacementJob;
    }
  } else {
    normalizedArgs.splice(invocation.optionEnd, 0, "--job", replacementJob);
  }
  return normalizedArgs;
}

const localPathRunOptions = new Set([
  "capture-stderr",
  "capture-stdout",
  "emit-proof",
  "env-from-profile",
  "script",
]);

function repoRelativePath(value: string) {
  if (!value || value === "-" || isAbsolute(value)) {
    return value;
  }
  return resolve(repoRoot, value);
}

function repoRelativeDownload(value: string) {
  const split = value.indexOf("=");
  if (split < 0) {
    return value;
  }
  const remote = value.slice(0, split + 1);
  const local = value.slice(split + 1);
  return `${remote}${repoRelativePath(local)}`;
}

function absolutizeLocalRunPaths(commandArgs: string[]) {
  if (commandArgs[0] !== "run") {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const invocation = parseCommandInvocation(help.text, normalizedArgs);
  for (const { index, name: optionName } of invocation.optionEntries) {
    const arg = normalizedArgs[index] ?? "";
    const absolutize = optionName === "download" ? repoRelativeDownload : repoRelativePath;
    if (localPathRunOptions.has(optionName) || optionName === "download") {
      const equals = arg.indexOf("=");
      if (equals >= 0) {
        normalizedArgs[index] = `${arg.slice(0, equals + 1)}${absolutize(arg.slice(equals + 1))}`;
      } else if (index + 1 < invocation.optionEnd) {
        normalizedArgs[index + 1] = absolutize(normalizedArgs[index + 1] ?? "");
      }
    }
  }
  return normalizedArgs;
}

function pathExists(path: PathLike) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function crabboxConfigDir() {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "crabbox");
  }
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "crabbox");
  }
  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "crabbox");
}

function userDisplayPath(path: string) {
  const home = homedir();
  const rel = relative(home, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return `~/${rel}`;
  }
  return path;
}

function blacksmithTestboxPrivateKeyPath(id: string) {
  return resolve(crabboxConfigDir(), "testboxes", id, "id_ed25519");
}

// Crabbox claims bind raw Testbox ids to one repo before remote execution.
// Check the same sidecar so a dependency exit bug cannot make refusal green.
function blacksmithTestboxClaimPath(id: string) {
  return resolve(blacksmithTestboxClaimsDir(), `${id}.json`);
}

function blacksmithTestboxClaimsDir() {
  const configuredStateRoot = process.env.XDG_STATE_HOME?.trim();
  const stateDir = configuredStateRoot
    ? resolve(configuredStateRoot, "crabbox")
    : resolve(crabboxConfigDir(), "state");
  return resolve(stateDir, "claims");
}

function blacksmithTestboxClaimRepoRoot(id: string) {
  const claimPath = blacksmithTestboxClaimPath(id);
  if (!pathExists(claimPath)) {
    return "";
  }
  const claim = JSON.parse(readFileSync(claimPath, "utf8"));
  return typeof claim.repoRoot === "string" ? claim.repoRoot : "";
}

function enforceCrabboxOwnedBlacksmithLease(commandArgs: string[]) {
  if (commandArgs[0] !== "run") {
    return;
  }
  const id = optionValue(commandArgs, "--id");
  if (!id) {
    return;
  }
  if (!id.startsWith("tbx_")) {
    return;
  }

  const keyPath = blacksmithTestboxPrivateKeyPath(id);
  if (!pathExists(keyPath)) {
    console.error(
      [
        `[crabbox] provider=blacksmith-testbox --id ${id} has no Crabbox SSH key at ${userDisplayPath(keyPath)}.`,
        "[crabbox] create reusable Testboxes through Crabbox before reusing them: node scripts/crabbox-wrapper.mjs warmup --provider blacksmith-testbox --idle-timeout 90m",
        "[crabbox] direct `blacksmith testbox warmup` leases can be used with `blacksmith testbox run`, but Crabbox cannot sync or run them by id.",
      ].join("\n"),
    );
    process.exit(2);
  }

  const claimRepoRoot = blacksmithTestboxClaimRepoRoot(id);
  if (claimRepoRoot && claimRepoRoot !== repoRoot && !hasOption(commandArgs, "--reclaim")) {
    console.error(
      `[crabbox] lease ${id} is claimed by repo ${claimRepoRoot}; use --reclaim to claim it for ${repoRoot}`,
    );
    process.exit(2);
  }
}

function restoreTemporaryBlacksmithTestboxClaimPath(claimPath: string) {
  const original = readFileSync(claimPath, "utf8");
  const claim = JSON.parse(original);
  if (!claim || typeof claim !== "object" || claim.repoRoot !== childCwd) {
    return;
  }
  claim.repoRoot = repoRoot;
  const temporaryPath = `${claimPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(claim)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (readFileSync(claimPath, "utf8") !== original) {
      return;
    }
    renameSync(temporaryPath, claimPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function restoreTemporaryBlacksmithTestboxClaim(commandArgs: string[], capturedLeaseId: string) {
  if (childCwd === repoRoot) {
    return;
  }

  const explicitLeaseId = commandArgs[0] === "run" ? optionValue(commandArgs, "--id") : "";
  const exactLeaseId = explicitLeaseId || capturedLeaseId;
  const canCreateRetainedLease =
    commandArgs[0] === "warmup" ||
    (commandArgs[0] === "run" &&
      (hasOption(commandArgs, "--keep") || hasOption(commandArgs, "--keep-on-failure")));
  let claimPaths: string[] = [];
  if (exactLeaseId) {
    claimPaths = [blacksmithTestboxClaimPath(exactLeaseId)];
  } else if (canCreateRetainedLease) {
    try {
      const claimsDir = blacksmithTestboxClaimsDir();
      if (pathExists(claimsDir)) {
        claimPaths = readdirSync(claimsDir)
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => resolve(claimsDir, entry));
      }
    } catch (error) {
      console.error(
        `[crabbox] warning: failed to inspect temporary Testbox claims: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  } else {
    return;
  }

  for (const claimPath of claimPaths) {
    if (!pathExists(claimPath)) {
      continue;
    }
    try {
      restoreTemporaryBlacksmithTestboxClaimPath(claimPath);
    } catch (error) {
      console.error(
        `[crabbox] warning: failed to restore temporary Testbox claim: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function observeBlacksmithTimingJSONLine(line: string) {
  const value = line.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) {
    return;
  }
  try {
    const report = JSON.parse(value);
    if (
      canonicalProviderName(report?.provider) === "blacksmith-testbox" &&
      typeof report.leaseId === "string" &&
      report.leaseId.startsWith("tbx_")
    ) {
      capturedBlacksmithLeaseId = report.leaseId;
    }
  } catch {
    // Human stderr may contain brace-delimited non-JSON lines.
  }
}

function preserveTemporaryCrabboxArtifacts() {
  if (childCwd === repoRoot) {
    return;
  }
  const sourceRoot = resolve(childCwd, ".crabbox");
  const directories = ["runs", "captures"].filter((name) => {
    const source = resolve(sourceRoot, name);
    return statSync(source, { throwIfNoEntry: false }) && readdirSync(source).length > 0;
  });
  if (directories.length === 0) {
    return;
  }

  // Native artifacts reuse lease names. Keep each invocation together without
  // overwriting earlier evidence, and copy only outputs, never other Crabbox state.
  const retainedRoot = resolve(repoRoot, ".crabbox", "wrapper-artifacts");
  mkdirSync(retainedRoot, { recursive: true });
  const destination = mkdtempSync(resolve(retainedRoot, "run-"));
  for (const name of directories) {
    cpSync(resolve(sourceRoot, name), resolve(destination, name), { recursive: true });
  }
  console.error(
    `[crabbox] preserved temporary artifacts: ${sourceRoot} -> ${relative(repoRoot, destination)}`,
  );
}

function shellQuote(value: string) {
  const text = value;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function shellJoin(commandArgs: string[]) {
  return commandArgs.map(shellQuote).join(" ");
}

function powershellQuote(value: string) {
  const text = value;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

function powershellJoin(commandArgs: string[]) {
  return commandArgs.map(powershellQuote).join(" ");
}

function isLocalContainerProvider(providerName: string) {
  return ["local-container", "docker", "container", "local-docker"].includes(providerName);
}

function replaceRunPayload(invocation: CommandInvocation, payload: string[]) {
  const normalizedArgs = [...invocation.args];
  normalizedArgs.splice(invocation.start, normalizedArgs.length - invocation.start, ...payload);
  return normalizedArgs;
}

function renderRunShellCommand(invocation: CommandInvocation, join = shellJoin) {
  return invocation.options.has("shell") && invocation.commandArgs.length === 1
    ? invocation.commandArgs[0]
    : join(invocation.commandArgs);
}

function replaceRunCommandWithShell(initialInvocation: CommandInvocation, shellCommand: string) {
  let invocation = initialInvocation;
  if (!invocation.options.has("shell")) {
    const normalizedArgs = [...invocation.args];
    normalizedArgs.splice(invocation.optionEnd, 0, "--shell");
    invocation = parseCommandInvocation(help.text, normalizedArgs);
  }
  return replaceRunPayload(invocation, [shellCommand]);
}

function normalizedCommandWords(commandArgs: string[]) {
  const words = commandArgs.length === 1 ? (commandArgs[0] ?? "").split(/\s+/u) : [...commandArgs];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
    words.shift();
  }
  return words.map((word) => word.replace(/^['"]|['";|&()]+$/g, ""));
}

function commandRuntimeEntrypoint(commandArgs: string[]): string {
  if (commandArgs.length === 1) {
    for (const candidateWords of shellCommandWordCandidates(commandArgs[0] ?? "")) {
      const shellRuntime = commandWordsRuntimeEntrypoint(candidateWords);
      if (shellRuntime) {
        return shellRuntime;
      }
    }
    return "";
  }
  const words = normalizedCommandWords(commandArgs);
  const directRuntime = commandWordsRuntimeEntrypoint(words);
  if (directRuntime) {
    return directRuntime;
  }
  return "";
}

function commandWordsRuntimeEntrypoint(wordsInput: string[]): string {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  if (jsRuntimeEntrypoints.has(first)) {
    return first;
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return "";
  }
  for (const candidateWords of shellCommandWordCandidates(inlineCommand)) {
    const shellRuntime = commandWordsRuntimeEntrypoint(candidateWords);
    if (shellRuntime) {
      return shellRuntime;
    }
  }
  return "";
}

function commandWordsShellEntrypoint(wordsInput: string[]): string {
  const words = normalizeExecutableWords(wordsInput);
  const first = shellWordBasename(words[0]);
  return shellInlineCommandInterpreters.has(first) ? first : "";
}

function commandNeedsAwsMacosPackageManager(
  commandArgs: string[],
  options: CommandNormalizeOptions = {},
) {
  if (isChangedGateCommand(commandArgs)) {
    return true;
  }
  if (commandNeedsEntrypoint(commandArgs, awsMacosCorepackEntrypoints, options)) {
    return true;
  }
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0] ?? "").some((words) =>
      commandWordsNeedAwsMacosPackageManager(words, options),
    );
  }
  return commandWordsNeedAwsMacosPackageManager(normalizedCommandWords(commandArgs), options);
}

function commandNeedsAwsMacosBun(commandArgs: string[]) {
  return commandNeedsEntrypoint(commandArgs, awsMacosBunEntrypoints);
}

function commandNeedsAwsMacosSwiftToolchain(commandArgs: string[]) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0] ?? "").some(
      commandWordsNeedAwsMacosSwiftToolchain,
    );
  }
  return commandWordsNeedAwsMacosSwiftToolchain(normalizedCommandWords(commandArgs));
}

function commandWordsNeedAwsMacosSwiftToolchain(wordsInput: string[]): boolean {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  if (isSupportedSystemEnvCommand(first)) {
    const targetWords = [...words];
    if (stripEnvCommandOptions(targetWords, { canShimIgnoreEnvironment: true })) {
      return commandWordsNeedAwsMacosSwiftToolchain(targetWords);
    }
  }
  if (awsMacosSwiftEntrypoints.has(first)) {
    return true;
  }

  if (first === "pnpm") {
    const scriptName = words[1] === "run" ? words[2] : words[1];
    if (awsMacosSwiftScriptTargets.has(scriptName ?? "")) {
      return true;
    }
  }

  if (isAwsMacosSwiftScriptTarget(words[0])) {
    return true;
  }

  if (commandWordsRunAwsMacosSwiftScript(words)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return false;
  }
  return shellCommandWordCandidates(inlineCommand).some(commandWordsNeedAwsMacosSwiftToolchain);
}

function commandWordsNeedAwsMacosPackageManager(
  wordsInput: string[],
  options: CommandNormalizeOptions = {},
): boolean {
  let words = wordsInput;
  const originalFirst = shellWordBasename(normalizedCommandWords(wordsInput)[0]);
  const canShimIgnoreEnvironment = options.canShimIgnoreEnvironment !== false;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  if (isSupportedSystemEnvCommand(first)) {
    const targetWords = [...words];
    if (
      stripEnvCommandOptions(targetWords, {
        canShimIgnoreEnvironment:
          canShimIgnoreEnvironment && isSupportedSystemEnvCommand(originalFirst),
      })
    ) {
      return commandWordsNeedAwsMacosPackageManager(targetWords, options);
    }
  }

  if (isAwsMacosPackageManagerScriptTarget(words[0])) {
    return true;
  }

  if (commandWordsRunAwsMacosPackageManagerScript(words)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return false;
  }
  return shellCommandWordCandidates(inlineCommand).some((candidateWords) =>
    commandWordsNeedAwsMacosPackageManager(candidateWords, options),
  );
}

function isAwsMacosSwiftScriptTarget(word: string | undefined) {
  if (!word) {
    return false;
  }
  const normalized = word.replace(/^\.\//u, "");
  return (
    awsMacosSwiftScriptTargets.has(normalized) ||
    awsMacosSwiftScriptTargets.has(normalized.split("/").pop() ?? "")
  );
}

function isAwsMacosPackageManagerScriptTarget(word: string | undefined) {
  if (!word) {
    return false;
  }
  const normalized = word.replace(/^\.\//u, "");
  return (
    awsMacosPackageManagerScriptTargets.has(normalized) ||
    awsMacosPackageManagerScriptTargets.has(normalized.split("/").pop() ?? "")
  );
}

function commandWordsRunScriptTarget(words: string[], isScriptTarget: (word: string) => boolean) {
  const first = (words[0] ?? "").split("/").pop() ?? "";
  if (!shellInlineCommandInterpreters.has(first)) {
    return false;
  }

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word) {
      return false;
    }
    if (word === "--") {
      continue;
    }
    if (word === "-c" || /^-[^-]*c/u.test(word)) {
      return false;
    }
    if (shellInlineCommandOptionConsumesNextValue(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-") || word.startsWith("+")) {
      continue;
    }
    return isScriptTarget(word);
  }
  return false;
}

function commandWordsRunAwsMacosSwiftScript(words: string[]) {
  return commandWordsRunScriptTarget(words, isAwsMacosSwiftScriptTarget);
}

function commandWordsRunAwsMacosPackageManagerScript(words: string[]) {
  return commandWordsRunScriptTarget(words, isAwsMacosPackageManagerScriptTarget);
}

function commandNeedsEntrypoint(
  commandArgs: string[],
  entrypoints: Set<string>,
  options: CommandNormalizeOptions = {},
) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0] ?? "").some((words) =>
      commandWordsNeedEntrypoint(words, entrypoints, options),
    );
  }
  return commandWordsNeedEntrypoint(normalizedCommandWords(commandArgs), entrypoints, options);
}

function commandWordsNeedEntrypoint(
  wordsInput: string[],
  entrypoints: Set<string>,
  options: CommandNormalizeOptions = {},
): boolean {
  let words = wordsInput;
  words = normalizeExecutableWords(words, options);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  if (entrypoints.has(first)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return false;
  }
  return shellCommandWordCandidates(inlineCommand).some((candidateWords) =>
    commandWordsNeedEntrypoint(candidateWords, entrypoints, options),
  );
}

function isChangedGateCommand(commandArgs: string[]) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0] ?? "").some((words) =>
      isChangedGateCommandWords(words),
    );
  }
  const words = normalizedCommandWords(commandArgs);
  return isChangedGateCommandWords(words, {
    canShimIgnoreEnvironment: shellWordBasename(commandArgs[0]) === "env",
  });
}

function changedGateBases(commandArgs: string[]) {
  const candidates =
    commandArgs.length === 1
      ? shellCommandWordCandidates(commandArgs[0] ?? "")
      : [normalizedCommandWords(commandArgs)];
  const bases: string[] = [];
  for (const words of candidates) {
    bases.push(
      ...changedGateBasesFromWords(words, {
        canShimIgnoreEnvironment: shellWordBasename(commandArgs[0]) === "env",
      }),
    );
  }
  return bases;
}

function changedGateBasesFromWords(
  wordsInput: string[],
  options: CommandNormalizeOptions = {},
): string[] {
  const words = normalizeExecutableWords(wordsInput, options);
  if (isChangedGateWords(words)) {
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index] ?? "";
      if (word === "--base") {
        return [words[index + 1] || "origin/main"];
      }
      if (word.startsWith("--base=")) {
        return [word.slice("--base=".length) || "origin/main"];
      }
    }
    return ["origin/main"];
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return [];
  }
  const bases: string[] = [];
  for (const candidateWords of shellCommandWordCandidates(inlineCommand)) {
    bases.push(...changedGateBasesFromWords(candidateWords));
  }
  return bases;
}

function isChangedGateCommandWords(
  wordsInput: string[],
  options: CommandNormalizeOptions = {},
): boolean {
  let words = wordsInput;
  words = normalizeExecutableWords(words, options);
  if (isChangedGateWords(words)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  return inlineCommand
    ? shellCommandWordCandidates(inlineCommand).some((candidateWords) =>
        isChangedGateCommandWords(candidateWords),
      )
    : false;
}

function isChangedGateWords(wordsInput: string[]) {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  if (words[0] === "corepack") {
    words.shift();
  }
  return (
    (words[0] === "pnpm" && words[1] === "check:changed") ||
    (words[0] === "pnpm" && words[1] === "run" && words[2] === "check:changed") ||
    nodeScriptWord(words)?.endsWith("scripts/check-changed.mjs")
  );
}

function nodeScriptWord(words: string[]) {
  if (shellWordBasename(words[0]) !== "node") {
    return "";
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word) {
      return "";
    }
    if (word === "--") {
      return words[index + 1] ?? "";
    }
    if (nodeOptionsWithoutScript.has(word) || nodeOptionsWithoutScriptPrefix(word)) {
      return "";
    }
    const valueMode = nodeOptionValueModeBeforeScript(word);
    if (valueMode === "next") {
      index += 1;
      continue;
    }
    if (valueMode === "inline") {
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      continue;
    }
    return word;
  }
  return "";
}

function nodeOptionsWithoutScriptPrefix(word: string) {
  return word.startsWith("--eval=") || word.startsWith("--print=");
}

function nodeOptionValueModeBeforeScript(word: string) {
  if (nodeOptionsWithNextValueBeforeScript.has(word)) {
    return "next";
  }
  const equalsIndex = word.indexOf("=");
  if (equalsIndex > 0 && nodeOptionsWithNextValueBeforeScript.has(word.slice(0, equalsIndex))) {
    return "inline";
  }
  return "";
}

function shellInlineCommand(words: string[]) {
  const command = shellWordBasename(words[0]);
  if (!shellInlineCommandInterpreters.has(command)) {
    return "";
  }

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") {
      return "";
    }
    if (!word.startsWith("-") && !word.startsWith("+")) {
      return "";
    }
    if (word === "-c" || /^-[^-]*c/u.test(word)) {
      return words[index + 1] ?? "";
    }
    if (shellInlineCommandOptionConsumesNextValue(word)) {
      index += 1;
    }
  }
  return "";
}

function shellInlineCommandOptionConsumesNextValue(word: string) {
  return shellInlineCommandOptionsWithNextValue.has(word) || /^[+-][^-+]*[oO]$/u.test(word);
}

function shellCommandWordCandidates(command: string): string[][] {
  return shellCommandSegments(stripHeredocBodies(command.replace(/\\\r?\n/gu, " ")));
}

function pushShellCandidate(candidates: string[][], segment: string) {
  const words = normalizedShellSegmentWords(segment);
  if (words.length > 0) {
    candidates.push(words);
  }
}

function normalizedShellSegmentWords(segment: string) {
  const trimmed = segment.trim().replace(/^[({]\s*/u, "");
  if (!trimmed || trimmed.startsWith("#")) {
    return [];
  }
  const words = normalizedCommandWords(splitShellWords(trimmed));
  while (shellControlCommandPrefixes.has(words[0] ?? "")) {
    words.shift();
  }
  const normalizedWords = normalizedCommandWords(words);
  return normalizedCommandWords(stripShellExecutionPrefixes(normalizedWords));
}

function normalizeExecutableWords(words: string[], options: CommandNormalizeOptions = {}) {
  return normalizedCommandWords(stripShellExecutionPrefixes(words, options));
}

function stripShellExecutionPrefixes(wordsInput: string[], options: CommandNormalizeOptions = {}) {
  let words = wordsInput;
  words = [...words];
  let canShimIgnoreEnvironment = Boolean(options.canShimIgnoreEnvironment);
  for (;;) {
    const first = shellWordBasename(words[0]);
    if (shellCommandExecutionPrefixes.has(first)) {
      words.shift();
      continue;
    }
    if (first === "command") {
      words.shift();
      if (!stripCommandBuiltinOptions(words)) {
        return words;
      }
      continue;
    }
    if (first === "env") {
      if (
        !stripEnvCommandOptions(words, {
          canShimIgnoreEnvironment,
        })
      ) {
        return words;
      }
      canShimIgnoreEnvironment = false;
      continue;
    }
    if (first === "time") {
      words.shift();
      stripTimeOptions(words);
      continue;
    }
    if (first === "timeout") {
      stripTimeoutOptions(words);
      continue;
    }
    return words;
  }
}

function stripEnvCommandOptions(
  words: string[],
  { canShimIgnoreEnvironment = true }: CommandNormalizeOptions = {},
) {
  const originalWords = [...words];
  const envCommand = words.shift() ?? "";
  const canShimThisEnv = canShimIgnoreEnvironment && isSupportedSystemEnvCommand(envCommand);
  let ignoresEnvironment = false;
  for (;;) {
    const word = words[0] ?? "";
    if (!word) {
      words.splice(0, words.length, ...originalWords);
      return false;
    }
    if (word === "--") {
      words.shift();
      return true;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      words.shift();
      continue;
    }
    if (word === "-S" || word === "--split-string") {
      if (ignoresEnvironment) {
        words.splice(0, words.length, ...originalWords);
        return false;
      }
      words.shift();
      const split = splitShellWords(words.shift() ?? "");
      words.unshift(...split);
      return words.length > 0;
    }
    if (word.startsWith("-S") && word !== "-S") {
      if (ignoresEnvironment) {
        words.splice(0, words.length, ...originalWords);
        return false;
      }
      words.shift();
      words.unshift(...splitShellWords(word.slice(2)));
      return words.length > 0;
    }
    if (word.startsWith("--split-string=")) {
      if (ignoresEnvironment) {
        words.splice(0, words.length, ...originalWords);
        return false;
      }
      words.shift();
      words.unshift(...splitShellWords(word.slice("--split-string=".length)));
      return words.length > 0;
    }
    if (word === "-i" || word === "--ignore-environment") {
      if (!canShimThisEnv) {
        words.splice(0, words.length, ...originalWords);
        return false;
      }
      ignoresEnvironment = true;
      words.shift();
      continue;
    }
    if (word === "-u" || word === "--unset" || word === "-C" || word === "--chdir") {
      words.shift();
      if (words[0]) {
        words.shift();
      }
      continue;
    }
    if (word.startsWith("--unset=") || word.startsWith("--chdir=")) {
      words.shift();
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      if (word.includes("i")) {
        if (!canShimThisEnv) {
          words.splice(0, words.length, ...originalWords);
          return false;
        }
        ignoresEnvironment = true;
      }
      words.shift();
      continue;
    }
    if (ignoresEnvironment && !canShimThisEnv) {
      words.splice(0, words.length, ...originalWords);
      return false;
    }
    return true;
  }
}

function isSupportedSystemEnvCommand(command: string) {
  return command === "env" || command === "/usr/bin/env";
}

function shellWordBasename(word: string | undefined) {
  return (word ?? "").split("/").pop() ?? "";
}

function stripCommandBuiltinOptions(words: string[]) {
  for (;;) {
    if (words[0] === "--") {
      words.shift();
      return true;
    }
    if (words[0] === "-p") {
      words.shift();
      continue;
    }
    return words[0] !== "-v" && words[0] !== "-V";
  }
}

function stripTimeOptions(words: string[]) {
  while ((words[0] ?? "").startsWith("-")) {
    if (words[0] === "--") {
      words.shift();
      return;
    }
    words.shift();
  }
}

function stripTimeoutOptions(words: string[]) {
  words.shift();
  for (;;) {
    const word = words[0] ?? "";
    if (!word) {
      return;
    }
    if (word === "--") {
      words.shift();
      break;
    }
    if (word === "-k" || word === "--kill-after" || word === "-s" || word === "--signal") {
      words.shift();
      if (words[0]) {
        words.shift();
      }
      continue;
    }
    if (word.startsWith("--kill-after=") || word.startsWith("--signal=")) {
      words.shift();
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      words.shift();
      continue;
    }
    break;
  }
  if (words[0]) {
    words.shift();
  }
}

function splitShellWords(value: string) {
  const words = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += char;
  }
  if (word) {
    words.push(word);
  }
  return words;
}

function stripHeredocBodies(command: string) {
  const lines = command.split("\n");
  const kept = [];
  const pendingDelimiters = [];
  for (const line of lines) {
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[0];
      if (!current) {
        continue;
      }
      const candidate = current.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === current.delimiter) {
        pendingDelimiters.shift();
      } else if (current.expand) {
        kept.push(...extractCommandSubstitutionBodies(line));
      }
      continue;
    }
    kept.push(line);
    pendingDelimiters.push(...lineHeredocDelimiters(line));
  }
  return kept.join("\n");
}

function lineHeredocDelimiters(line: string) {
  const delimiters = [];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "<" || next !== "<" || line[index + 2] === "<") {
      continue;
    }
    let delimiterStart = index + 2;
    const stripTabs = line[delimiterStart] === "-";
    if (stripTabs) {
      delimiterStart += 1;
    }
    while (/\s/u.test(line[delimiterStart] ?? "")) {
      delimiterStart += 1;
    }
    const parsed = readHeredocDelimiter(line, delimiterStart);
    if (parsed.delimiter) {
      delimiters.push({ delimiter: parsed.delimiter, stripTabs, expand: !parsed.quoted });
      index = parsed.endIndex;
    }
  }
  return delimiters;
}

function readHeredocDelimiter(line: string, startIndex: number) {
  let delimiterResult = "";
  let quote = "";
  let escaped = false;
  let quoted = false;
  let index = startIndex;
  for (; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (escaped) {
      delimiterResult += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      quoted = true;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        delimiterResult += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = true;
      quote = char;
      continue;
    }
    if (/\s/u.test(char) || /[;&|()<>]/u.test(char)) {
      break;
    }
    delimiterResult += char;
  }
  return { delimiter: delimiterResult, endIndex: Math.max(startIndex, index), quoted };
}

function extractCommandSubstitutionBodies(line: string) {
  const substitutions = [];
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "$" && next === "(" && line[index + 2] !== "(") {
      const substitution = readCommandSubstitution(line, index + 2);
      substitutions.push(substitution.content);
      index = substitution.endIndex;
    }
  }
  return substitutions;
}

function shellCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let segment = "";
  let quote = "";
  let escaped = false;
  let inCase = false;
  let readingCasePattern = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] ?? "";
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      segment += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && char === "$" && next === "(" && command[index + 2] !== "(") {
        const substitution = readCommandSubstitution(command, index + 2);
        segments.push(...shellCommandWordCandidates(substitution.content));
        index = substitution.endIndex;
        segment += "$()";
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      segment += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === "#" && (segment.trim() === "" || /\s$/u.test(segment))) {
      index = skipUntilNewline(command, index);
      pushShellCandidate(segments, segment);
      segment = "";
      continue;
    }
    if (char === "$" && next === "(" && command[index + 2] !== "(") {
      const substitution = readCommandSubstitution(command, index + 2);
      segments.push(...shellCommandWordCandidates(substitution.content));
      index = substitution.endIndex;
      segment += "$()";
      continue;
    }
    if (segment.trim() === "" && startsShellReservedWord(command, index, "case")) {
      pushShellCandidate(segments, segment);
      segment = "";
      inCase = true;
      readingCasePattern = true;
      index += "case".length - 1;
      continue;
    }
    if (inCase && segment.trim() === "" && startsShellReservedWord(command, index, "esac")) {
      pushShellCandidate(segments, segment);
      segment = "";
      inCase = false;
      readingCasePattern = false;
      index += "esac".length - 1;
      continue;
    }
    if (inCase && readingCasePattern) {
      if (char === ")") {
        segment = "";
        readingCasePattern = false;
        continue;
      }
      segment += char;
      continue;
    }
    if (inCase && char === ";" && next === ";") {
      pushShellCandidate(segments, segment);
      segment = "";
      readingCasePattern = true;
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";" || char === ")") {
      pushShellCandidate(segments, segment);
      segment = "";
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushShellCandidate(segments, segment);
      segment = "";
      index += 1;
      continue;
    }
    if (char === "&" && next !== ">" && command[index - 1] !== ">") {
      pushShellCandidate(segments, segment);
      segment = "";
      continue;
    }
    if (char === "|") {
      pushShellCandidate(segments, segment);
      segment = "";
      if (next === "&") {
        index += 1;
      }
      continue;
    }
    segment += char;
  }
  pushShellCandidate(segments, segment);
  return segments;
}

function readCommandSubstitution(command: string, startIndex: number) {
  let depth = 1;
  let quote = "";
  let escaped = false;
  let inCase = false;
  let readingCasePattern = false;
  let content = "";
  for (let index = startIndex; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] ?? "";
    if (escaped) {
      content += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      content += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      content += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      content += char;
      continue;
    }
    if (!inCase && startsShellToken(command, index, "case")) {
      inCase = true;
      readingCasePattern = true;
    } else if (inCase && startsShellToken(command, index, "esac")) {
      inCase = false;
      readingCasePattern = false;
    }
    if (char === "$" && next === "(") {
      depth += 1;
      content += "$(";
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      content += char;
      continue;
    }
    if (inCase && char === ";" && next === ";") {
      readingCasePattern = true;
      content += ";;";
      index += 1;
      continue;
    }
    if (inCase && readingCasePattern && depth === 1 && char === ")") {
      readingCasePattern = false;
      content += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { content, endIndex: index };
      }
    }
    content += char;
  }
  return { content, endIndex: command.length - 1 };
}

function startsShellReservedWord(command: string, index: number, word: string) {
  if (!command.startsWith(word, index)) {
    return false;
  }
  const after = command[index + word.length] ?? "";
  return !after || /\s|[;&|()<>]/u.test(after);
}

function startsShellToken(command: string, index: number, word: string) {
  if (!command.startsWith(word, index)) {
    return false;
  }
  const before = command[index - 1] ?? "";
  const after = command[index + word.length] ?? "";
  return (!before || /\s|[;&|()<>]/u.test(before)) && (!after || /\s|[;&|()<>]/u.test(after));
}

function skipUntilNewline(command: string | string[], index: number) {
  const newlineIndex = command.indexOf("\n", index);
  return newlineIndex < 0 ? command.length - 1 : newlineIndex;
}

function changedGateBaseForCommand(commandArgs: string[]) {
  const requestedBases = [...new Set(changedGateBases(commandArgs))];
  if (requestedBases.length > 1) {
    throw new Error(
      `remote changed-gate sync requires one base; received: ${requestedBases.join(", ")}`,
    );
  }
  const explicitBase = requestedBases[0] ?? "origin/main";
  const remoteAlias = remoteAliasForChangedGateBase(explicitBase);
  if (explicitBase !== "origin/main" && !remoteAlias) {
    throw new Error(
      `remote changed-gate sync requires an exact origin/<branch> base; received: ${explicitBase}`,
    );
  }
  // Only exact remote-tracking refs can be recreated under their original name
  // after the remote raw-sync checkout initializes fresh Git metadata.
  const requestedBase = explicitBase;
  const base = gitOutput(["merge-base", requestedBase, "HEAD"]);
  if (base.status === 0 && base.stdout) {
    return {
      remoteAlias,
      resolvedBase: base.stdout,
    };
  }
  if (requestedBase !== "origin/main") {
    throw new Error(`could not resolve explicit changed-gate base: ${requestedBase}`);
  }
  return { remoteAlias: "", resolvedBase: "origin/main" };
}

function remoteAliasForChangedGateBase(base: string) {
  if (base === "origin/main" || !base.startsWith("origin/")) {
    return "";
  }
  const alias = `refs/remotes/${base}`;
  return gitOutput(["check-ref-format", alias]).status === 0 ? alias : "";
}

function injectRemoteChangedGateEnvironment(invocation: CommandInvocation, facts: RunFacts) {
  if (invocation.args[0] !== "run" || isNativeWindowsRemoteTarget(invocation.args)) {
    return invocation.args;
  }

  if (invocation.start < 0 || !facts.changedGate) {
    return invocation.args;
  }

  const markedRemoteCommand =
    invocation.options.has("shell") && invocation.commandArgs.length === 1
      ? [markShellChangedGateAsRemoteChild(invocation.commandArgs[0] ?? "")]
      : markDirectChangedGateAsRemoteChild(invocation.commandArgs);
  return replaceRunPayload(invocation, markedRemoteCommand);
}

function markShellChangedGateAsRemoteChild(command: string) {
  return `export ${remoteChangedGateEnv.join(" ")}; ${command}`;
}

function markDirectChangedGateAsRemoteChild(commandArgs: string[]) {
  const missingEnv = remoteChangedGateEnv.filter((assignment) => !commandArgs.includes(assignment));
  if (missingEnv.length === 0) {
    return commandArgs;
  }

  const markedCommandArgs = [...commandArgs];
  if (shellWordBasename(markedCommandArgs[0]) !== "env") {
    return ["env", ...missingEnv, ...markedCommandArgs];
  }

  markedCommandArgs.splice(envAssignmentInsertIndex(markedCommandArgs), 0, ...missingEnv);
  return markedCommandArgs;
}

function envAssignmentInsertIndex(words: string[]) {
  let index = 1;
  for (;;) {
    const word = words[index] ?? "";
    if (!word) {
      return 1;
    }
    if (word === "--") {
      return index + 1;
    }
    if (word === "-S" || word === "--split-string" || (word.startsWith("-S") && word !== "-S")) {
      return index;
    }
    if (word === "-u" || word === "--unset" || word === "-C" || word === "--chdir") {
      index += 2;
      continue;
    }
    if (word.startsWith("--unset=") || word.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      index += 1;
      continue;
    }
    return index;
  }
}

function isWindowsRemoteTarget(commandArgs: string[]) {
  // Mirror Crabbox's arg/env/config resolution so indirect Windows targets never receive POSIX shell.
  return effectiveTargetContext(commandArgs).target === "windows";
}

function isNativeWindowsRemoteTarget(commandArgs: string[]) {
  const targetContext = effectiveTargetContext(commandArgs);
  return targetContext.target === "windows" && targetContext.windowsMode !== "wsl2";
}

function isAwsMacosRemoteTarget(commandArgs: string[], providerName: string) {
  return (
    commandArgs[0] === "run" &&
    providerName === "aws" &&
    optionValue(commandArgs, "--target") === "macos"
  );
}

function isBrokeredWsl2RemoteTarget(commandArgs: string[], providerName: string) {
  const canonicalProvider = canonicalProviderName(providerName);
  return (
    commandArgs[0] === "run" &&
    (canonicalProvider === "aws" || canonicalProvider === "azure") &&
    isWindowsRemoteTarget(commandArgs) &&
    effectiveTargetContext(commandArgs).windowsMode === "wsl2"
  );
}

function isHydratedNativeWindowsProvider(providerName: string) {
  return providerName === "aws" || providerName === "azure";
}

function remoteWindowsHydratedNodeModulesBootstrap() {
  return [
    "$openclawModulesDir = if ($env:CRABBOX_PNPM_MODULES_DIR) { $env:CRABBOX_PNPM_MODULES_DIR } else { $env:PNPM_CONFIG_MODULES_DIR }",
    "if ($openclawModulesDir) {",
    'if (-not (Test-Path $openclawModulesDir)) { throw "hydrated pnpm modules directory does not exist: $openclawModulesDir" }',
    '$openclawWorkspaceModules = Join-Path (Get-Location).Path "node_modules"',
    '$openclawSelfModules = Join-Path $openclawModulesDir "node_modules"',
    'if (-not (Test-Path $openclawSelfModules)) { cmd /c mklink /J "$openclawSelfModules" "$openclawModulesDir" | Out-Host; if ($LASTEXITCODE -ne 0) { throw "failed to link hydrated pnpm node_modules" } }',
    'if (-not (Test-Path $openclawWorkspaceModules)) { cmd /c mklink /J "$openclawWorkspaceModules" "$openclawModulesDir" | Out-Host; if ($LASTEXITCODE -ne 0) { throw "failed to link workspace node_modules" } }',
    "}",
  ].join("; ");
}

function remotePosixHydratedNodeModulesBootstrap() {
  // Knip and other non-pnpm tools walk node_modules, while hydrated boxes keep it external.
  // Without this link, dead-code scans silently lose consumer edges and report false positives.
  return 'openclaw_modules_dir="${CRABBOX_PNPM_MODULES_DIR:-${PNPM_CONFIG_MODULES_DIR:-}}"; if [ -n "$openclaw_modules_dir" ] && [ -d "$openclaw_modules_dir" ] && [ ! -e node_modules ]; then ln -s "$openclaw_modules_dir" node_modules; fi;';
}

function injectRemoteWindowsHydratedNodeModulesBootstrap(
  invocation: CommandInvocation,
  facts: RunFacts,
  providerName: string,
) {
  if (
    invocation.args[0] !== "run" ||
    !isHydratedNativeWindowsProvider(providerName) ||
    !isNativeWindowsRemoteTarget(invocation.args) ||
    !invocation.options.has("id") ||
    !facts.runtimeEntrypoint
  ) {
    return invocation.args;
  }

  if (invocation.start < 0) {
    return invocation.args;
  }

  return replaceRunCommandWithShell(
    invocation,
    `${remoteWindowsHydratedNodeModulesBootstrap()}; ${renderRunShellCommand(invocation, powershellJoin)}`,
  );
}

function injectRemotePosixHydratedNodeModulesBootstrap(invocation: CommandInvocation) {
  if (
    invocation.args[0] !== "run" ||
    isWindowsRemoteTarget(invocation.args) ||
    invocation.options.has("script") ||
    invocation.options.has("script-stdin") ||
    invocation.start < 0
  ) {
    return invocation.args;
  }

  return replaceRunCommandWithShell(
    invocation,
    `${remotePosixHydratedNodeModulesBootstrap()} ${renderRunShellCommand(invocation)}`,
  );
}

function remotePosixJsEnvBootstrap() {
  return [
    "openclaw_crabbox_env() {",
    "openclaw_env_args=();",
    "openclaw_env_ignore=0;",
    "openclaw_env_path_seen=0;",
    'while [ "$#" -gt 0 ]; do',
    'case "$1" in',
    '-i|--ignore-environment) openclaw_env_ignore=1; openclaw_env_args+=("$1"); shift ;;',
    '-S|--split-string|-S*|--split-string=*) command env "${openclaw_env_args[@]}" "$@"; return ;;',
    '-[!-]*i*) openclaw_env_ignore=1; openclaw_env_args+=("$1"); shift ;;',
    '-u|--unset|-C|--chdir) openclaw_env_args+=("$1"); shift; if [ "$#" -gt 0 ]; then openclaw_env_args+=("$1"); shift; fi ;;',
    '--unset=*|--chdir=*) openclaw_env_args+=("$1"); shift ;;',
    'PATH=*) if [ "$openclaw_env_ignore" = "1" ]; then openclaw_env_args+=("PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}:${1#PATH=}"); else openclaw_env_args+=("$1"); fi; openclaw_env_path_seen=1; shift ;;',
    '[A-Za-z_]*=*) openclaw_env_args+=("$1"); shift ;;',
    '--) openclaw_env_args+=("--"); shift; break ;;',
    "*) break ;;",
    "esac;",
    "done;",
    'if [ "$openclaw_env_ignore" = "1" ] && [ "$openclaw_env_path_seen" = "0" ]; then openclaw_env_args+=("PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}"); fi;',
    'command env "${openclaw_env_args[@]}" "$@";',
    "};",
  ];
}

function remoteAwsMacosJsBootstrap({
  packageManager = false,
  bun = false,
  sourceBootstrap = "",
} = {}) {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_MACOS_NODE_VERSION?.trim() || "24.19.0";
  const bootstrap = [
    "openclaw_crabbox_bootstrap_macos_js() {",
    'tool_root="${OPENCLAW_CRABBOX_MACOS_TOOLCHAIN_DIR:-$HOME/.openclaw-crabbox-toolchain}";',
    `node_version=${shellQuote(nodeVersion)};`,
    'arch="$(uname -m)";',
    'case "$arch" in arm64) node_arch=arm64 ;; x86_64) node_arch=x64 ;; *) echo "unsupported macOS arch: $arch" >&2; return 2 ;; esac;',
    'macos_locale="${OPENCLAW_CRABBOX_MACOS_LOCALE:-en_US.UTF-8}";',
    'case "${LANG:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LANG="$macos_locale" ;; esac;',
    'case "${LC_ALL:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LC_ALL="$macos_locale" ;; esac;',
    'case "${LC_CTYPE:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LC_CTYPE="$macos_locale" ;; esac;',
    'if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR" 2>/dev/null || export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then echo "usable TMPDIR not found: $TMPDIR" >&2; return 1; fi;',
    'node_dir="$tool_root/node-v${node_version}-darwin-${node_arch}";',
    'ready_marker="$node_dir/.openclaw-crabbox-node-ready";',
    'export PATH="$node_dir/bin:$PATH";',
    'if [ ! -x "$node_dir/bin/node" ] || [ ! -f "$ready_marker" ]; then',
    'mkdir -p "$tool_root" || { status=$?; return "$status"; };',
    'install_lock="$tool_root/.node-${node_version}-${node_arch}.lock";',
    "lock_acquired=0;",
    "lock_deadline=$((SECONDS + 300));",
    "while true; do",
    'if mkdir "$install_lock" 2>/dev/null; then lock_acquired=1; printf "%s\\n" "$$" >"$install_lock/pid" || { status=$?; rm -rf "$install_lock"; return "$status"; }; break; fi;',
    'if [ -x "$node_dir/bin/node" ] && [ -f "$ready_marker" ]; then break; fi;',
    'if [ "$SECONDS" -ge "$lock_deadline" ]; then',
    'lock_pid="$(cat "$install_lock/pid" 2>/dev/null || true)";',
    'if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then echo "timed out waiting for active macOS Node toolchain install lock: $install_lock pid=$lock_pid" >&2; return 1; fi;',
    'echo "reclaiming stale macOS Node toolchain install lock: $install_lock" >&2;',
    'rm -rf "$install_lock" || return 1;',
    "lock_deadline=$((SECONDS + 300));",
    "fi;",
    "sleep 1;",
    "done;",
    'release_install_lock() { if [ "$lock_acquired" = "1" ]; then rm -rf "$install_lock" 2>/dev/null || true; fi; };',
    'if [ ! -x "$node_dir/bin/node" ] || [ ! -f "$ready_marker" ]; then',
    'tmp_dir="$(mktemp -d)" || { release_install_lock; return 1; };',
    'pkg="node-v${node_version}-darwin-${node_arch}.tar.gz";',
    'base_url="https://nodejs.org/dist/v${node_version}";',
    'curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 -o "$tmp_dir/$pkg" "$base_url/$pkg" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 -o "$tmp_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    '(cd "$tmp_dir" && grep " $pkg$" SHASUMS256.txt | shasum -a 256 -c -) || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$node_dir" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'tar -xzf "$tmp_dir/$pkg" -C "$tool_root" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'touch "$ready_marker" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$tmp_dir";',
    "fi;",
    "release_install_lock;",
    "fi;",
    "node --version >&2 || return 1;",
    ...remotePosixJsEnvBootstrap(),
    ...(sourceBootstrap ? [`${sourceBootstrap} || return $?;`] : []),
  ];
  if (packageManager) {
    bootstrap.push(
      'export COREPACK_HOME="${COREPACK_HOME:-$tool_root/corepack}";',
      'export PNPM_HOME="${PNPM_HOME:-$tool_root/pnpm-home}";',
      'mkdir -p "$COREPACK_HOME" "$PNPM_HOME" || return 1;',
      'export PATH="$PNPM_HOME:$PATH";',
      'corepack enable --install-directory "$PNPM_HOME" || return 1;',
      "pnpm --version >&2;",
    );
  }
  // Raw AWS macOS boxes skip setup-node-env, so Bun needs its own user-local pin.
  if (bun) {
    bootstrap.push(
      `bun_version=${shellQuote(awsMacosBunVersion)};`,
      'bun_root="$tool_root/bun-v${bun_version}";',
      'bun_ready_marker="$bun_root/.openclaw-crabbox-bun-ready";',
      'export PATH="$bun_root/bin:$PATH";',
      'if [ ! -x "$bun_root/bin/bun" ] || [ ! -f "$bun_ready_marker" ]; then',
      'mkdir -p "$tool_root" || { status=$?; return "$status"; };',
      'bun_install_lock="$tool_root/.bun-${bun_version}.lock";',
      "bun_lock_acquired=0;",
      "bun_lock_deadline=$((SECONDS + 300));",
      "while true; do",
      'if mkdir "$bun_install_lock" 2>/dev/null; then bun_lock_acquired=1; printf "%s\\n" "$$" >"$bun_install_lock/pid" || { status=$?; rm -rf "$bun_install_lock"; return "$status"; }; break; fi;',
      'if [ -x "$bun_root/bin/bun" ] && [ -f "$bun_ready_marker" ]; then break; fi;',
      'if [ "$SECONDS" -ge "$bun_lock_deadline" ]; then',
      'bun_lock_pid="$(cat "$bun_install_lock/pid" 2>/dev/null || true)";',
      'if [ -n "$bun_lock_pid" ] && kill -0 "$bun_lock_pid" 2>/dev/null; then echo "timed out waiting for active macOS Bun install lock: $bun_install_lock pid=$bun_lock_pid" >&2; return 1; fi;',
      'echo "reclaiming stale macOS Bun install lock: $bun_install_lock" >&2;',
      'rm -rf "$bun_install_lock" || return 1;',
      "bun_lock_deadline=$((SECONDS + 300));",
      "fi;",
      "sleep 1;",
      "done;",
      'release_bun_install_lock() { if [ "$bun_lock_acquired" = "1" ]; then rm -rf "$bun_install_lock" 2>/dev/null || true; fi; };',
      'if [ ! -x "$bun_root/bin/bun" ] || [ ! -f "$bun_ready_marker" ]; then',
      'rm -rf "$bun_root" || { status=$?; release_bun_install_lock; return "$status"; };',
      'mkdir -p "$bun_root" || { status=$?; release_bun_install_lock; return "$status"; };',
      'npm install --global --prefix "$bun_root" --fetch-timeout=120000 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 "bun@${bun_version}" || { status=$?; release_bun_install_lock; return "$status"; };',
      'touch "$bun_ready_marker" || { status=$?; release_bun_install_lock; return "$status"; };',
      "fi;",
      "release_bun_install_lock;",
      "fi;",
      "bun --version >&2 || return 1;",
    );
  }
  bootstrap.push('export OPENCLAW_CRABBOX_BOOTSTRAP_PATH="$PATH";');
  bootstrap.push("};", "openclaw_crabbox_bootstrap_macos_js");
  return bootstrap.join(" ");
}

function remoteWsl2JsBootstrap({ packageManager = false, sourceBootstrap = "" } = {}) {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_WSL2_NODE_VERSION?.trim() || "24.19.0";
  const bootstrap = [
    "openclaw_crabbox_bootstrap_wsl2_js() {",
    'tool_root="${OPENCLAW_CRABBOX_WSL2_TOOLCHAIN_DIR:-$HOME/.openclaw-crabbox-toolchain}";',
    `node_version=${shellQuote(nodeVersion)};`,
    'arch="$(uname -m)";',
    'case "$arch" in arm64|aarch64) node_arch=arm64 ;; x86_64|amd64) node_arch=x64 ;; *) echo "unsupported WSL2 arch: $arch" >&2; return 2 ;; esac;',
    'if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR" 2>/dev/null || export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then echo "usable TMPDIR not found: $TMPDIR" >&2; return 1; fi;',
    'node_dir="$tool_root/node-v${node_version}-linux-${node_arch}";',
    'ready_marker="$node_dir/.openclaw-crabbox-node-ready";',
    'export PATH="$node_dir/bin:$PATH";',
    'if [ ! -x "$node_dir/bin/node" ] || [ ! -f "$ready_marker" ]; then',
    'mkdir -p "$tool_root" || { status=$?; return "$status"; };',
    'install_lock="$tool_root/.node-${node_version}-${node_arch}.lock";',
    "lock_acquired=0;",
    "lock_deadline=$((SECONDS + 300));",
    "while true; do",
    'if mkdir "$install_lock" 2>/dev/null; then lock_acquired=1; printf "%s\\n" "$$" >"$install_lock/pid" || { status=$?; rm -rf "$install_lock"; return "$status"; }; break; fi;',
    'if [ -x "$node_dir/bin/node" ] && [ -f "$ready_marker" ]; then break; fi;',
    'if [ "$SECONDS" -ge "$lock_deadline" ]; then',
    'lock_pid="$(cat "$install_lock/pid" 2>/dev/null || true)";',
    'if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then echo "timed out waiting for active WSL2 Node toolchain install lock: $install_lock pid=$lock_pid" >&2; return 1; fi;',
    'echo "reclaiming stale WSL2 Node toolchain install lock: $install_lock" >&2;',
    'rm -rf "$install_lock" || return 1;',
    "lock_deadline=$((SECONDS + 300));",
    "fi;",
    "sleep 1;",
    "done;",
    'release_install_lock() { if [ "$lock_acquired" = "1" ]; then rm -rf "$install_lock" 2>/dev/null || true; fi; };',
    'if [ ! -x "$node_dir/bin/node" ] || [ ! -f "$ready_marker" ]; then',
    'tmp_dir="$(mktemp -d)" || { release_install_lock; return 1; };',
    'pkg="node-v${node_version}-linux-${node_arch}.tar.gz";',
    'base_url="https://nodejs.org/dist/v${node_version}";',
    'curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 -o "$tmp_dir/$pkg" "$base_url/$pkg" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 -o "$tmp_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    '(cd "$tmp_dir" && grep " $pkg$" SHASUMS256.txt | sha256sum -c -) || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$node_dir" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'tar -xzf "$tmp_dir/$pkg" -C "$tool_root" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'touch "$ready_marker" || { status=$?; release_install_lock; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$tmp_dir";',
    "fi;",
    "release_install_lock;",
    "fi;",
    "node --version >&2 || return 1;",
    ...remotePosixJsEnvBootstrap(),
    ...(sourceBootstrap ? [`${sourceBootstrap} || return $?;`] : []),
  ];
  if (packageManager) {
    bootstrap.push(
      'export COREPACK_HOME="${COREPACK_HOME:-$tool_root/corepack}";',
      'export PNPM_HOME="${PNPM_HOME:-$tool_root/pnpm-home}";',
      'mkdir -p "$COREPACK_HOME" "$PNPM_HOME" || return 1;',
      'export PATH="$PNPM_HOME:$PATH";',
      'corepack enable --install-directory "$PNPM_HOME" || return 1;',
      "pnpm --version >&2;",
      "if [ -f pnpm-lock.yaml ] && [ ! -f node_modules/.modules.yaml ]; then pnpm install --frozen-lockfile || return 1; fi;",
    );
  }
  bootstrap.push('export OPENCLAW_CRABBOX_BOOTSTRAP_PATH="$PATH";');
  bootstrap.push("};", "openclaw_crabbox_bootstrap_wsl2_js");
  return bootstrap.join(" ");
}

function scopedAwsMacosEnvCommand(commandArgs: string[]) {
  if (commandArgs.length <= 1 || !isSupportedSystemEnvCommand(commandArgs[0] ?? "")) {
    return null;
  }

  const targetWords = [...commandArgs];
  if (!stripEnvCommandOptions(targetWords, { canShimIgnoreEnvironment: true })) {
    return null;
  }

  const targetEntrypoint = shellWordBasename(targetWords[0]);
  const needsPackageManager =
    awsMacosCorepackEntrypoints.has(targetEntrypoint) ||
    commandWordsNeedAwsMacosPackageManager(targetWords);
  const needsRuntime = jsRuntimeEntrypoints.has(targetEntrypoint);
  const needsBun = awsMacosBunEntrypoints.has(targetEntrypoint);
  if (!needsRuntime && !needsPackageManager && !needsBun) {
    return null;
  }

  return {
    runtimeEntrypoint: needsRuntime ? targetEntrypoint : "",
    packageManager: needsPackageManager,
    bun: needsBun,
    shellCommand: `openclaw_crabbox_env ${shellJoin(commandArgs.slice(1))}`,
  };
}

function scopedAwsMacosShellEnvCommand(command: string) {
  const candidates = shellCommandWordCandidates(command);
  if (candidates.length < 1) {
    return null;
  }

  const eligibleSegments = new Set<string>();
  const scoped = {
    runtimeEntrypoint: "",
    packageManager: false,
    bun: false,
  };
  for (const words of candidates) {
    const candidateScoped = scopedAwsMacosEnvCommand(words);
    if (!candidateScoped) {
      continue;
    }
    eligibleSegments.add(shellWordsKey(words));
    scoped.runtimeEntrypoint ||= candidateScoped.runtimeEntrypoint;
    scoped.packageManager ||= candidateScoped.packageManager;
    scoped.bun ||= candidateScoped.bun;
  }
  if (eligibleSegments.size < 1) {
    return null;
  }

  const shellCommand = shellCommandWithEnvShim(command, eligibleSegments);
  return shellCommand ? { ...scoped, shellCommand } : null;
}

function shellWordsKey(words: string[]) {
  return JSON.stringify(words);
}

function shellCommandWithEnvShim(command: string, eligibleSegments: Set<string>) {
  let changed = false;
  let rewritten = "";
  let copiedUntil = 0;
  for (const segment of shellCommandSegmentsWithBounds(command)) {
    const envToken = leadingShellEnvCommandToken(command, segment.start);
    if (!envToken || envToken.start >= segment.end) {
      continue;
    }
    const words = normalizedShellSegmentWords(command.slice(segment.start, segment.end));
    if (!eligibleSegments.has(shellWordsKey(words))) {
      continue;
    }
    rewritten += command.slice(copiedUntil, envToken.start);
    rewritten += "openclaw_crabbox_env";
    copiedUntil = envToken.end;
    changed = true;
  }
  return changed ? `${rewritten}${command.slice(copiedUntil)}` : "";
}

function shellCommandSegmentsWithBounds(command: string) {
  const segments = [];
  const ignoredRanges = shellHeredocBodyRanges(command);
  let ignoredRangeIndex = 0;
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const ignoredRange = ignoredRanges[ignoredRangeIndex];
    if (ignoredRange && index >= ignoredRange.start) {
      if (start < ignoredRange.start) {
        segments.push({ start, end: ignoredRange.start });
      }
      index = ignoredRange.end - 1;
      start = ignoredRange.end;
      ignoredRangeIndex += 1;
      continue;
    }
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "\n" && char !== ";" && char !== ")" && char !== "&" && char !== "|") {
      continue;
    }
    if (
      char === "&" &&
      (command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">")
    ) {
      continue;
    }

    segments.push({ start, end: index });
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      index += 1;
    }
    start = index + 1;
  }
  segments.push({ start, end: command.length });
  return segments;
}

function shellHeredocBodyRanges(command: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const pendingDelimiters: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let lineStart = 0;
  for (;;) {
    const newlineIndex = command.indexOf("\n", lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex : command.length;
    const nextLineStart = newlineIndex >= 0 ? newlineIndex + 1 : command.length;
    const line = command.slice(lineStart, lineEnd);

    if (pendingDelimiters.length > 0) {
      ranges.push({ start: lineStart, end: nextLineStart });
      const current = pendingDelimiters[0];
      if (!current) {
        continue;
      }
      const candidate = current.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === current.delimiter) {
        pendingDelimiters.shift();
      }
    } else {
      pendingDelimiters.push(...lineHeredocDelimiters(line));
    }

    if (newlineIndex < 0) {
      return ranges;
    }
    lineStart = nextLineStart;
  }
}

function leadingShellEnvCommandToken(command: string, start = 0) {
  let index = start;
  for (;;) {
    while (/\s/u.test(command[index] ?? "")) {
      index += 1;
    }
    if (command[index] === "(" || command[index] === "{") {
      index += 1;
      continue;
    }
    const token = readLeadingShellWord(command, index);
    if (!token) {
      return null;
    }
    if (shellControlCommandPrefixes.has(token.word)) {
      index = token.end;
      continue;
    }
    if (token.word === "time") {
      index = skipLeadingTimeCommand(command, token.end);
      continue;
    }
    if (isSupportedSystemEnvCommand(token.word)) {
      return { start: index, end: token.end };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.word)) {
      return null;
    }
    index = token.end;
  }
}

function skipLeadingTimeCommand(command: string, start: number) {
  let index = start;
  for (;;) {
    while (/\s/u.test(command[index] ?? "")) {
      index += 1;
    }
    const token = readLeadingShellWord(command, index);
    if (!token) {
      return index;
    }
    if (token.word === "--" || token.word.startsWith("-")) {
      index = token.end;
      continue;
    }
    return index;
  }
}

function readLeadingShellWord(command: string, start: number) {
  let word = "";
  let quote = "";
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char) || /[;&|()<>]/u.test(char)) {
      return word ? { word, end: index } : null;
    }
    word += char;
  }
  return word ? { word, end: command.length } : null;
}

function analyzeRemoteCommand(invocation: CommandInvocation) {
  const runArgs = invocation.commandArgs;
  const directScopedEnvCommand = invocation.options.has("shell")
    ? null
    : scopedAwsMacosEnvCommand(runArgs);
  const shellScopedEnvCommand =
    invocation.options.has("shell") && runArgs.length === 1
      ? scopedAwsMacosShellEnvCommand(runArgs[0] ?? "")
      : null;
  const scopedEnvCommand = directScopedEnvCommand ?? shellScopedEnvCommand;
  const packageManagerFallbackNeeded = scopedEnvCommand
    ? commandNeedsAwsMacosPackageManager(runArgs)
    : commandNeedsAwsMacosPackageManager(runArgs, { canShimIgnoreEnvironment: false });
  const packageManagerNeeded = scopedEnvCommand?.packageManager || packageManagerFallbackNeeded;
  const runtimeEntrypoint =
    scopedEnvCommand?.runtimeEntrypoint || commandRuntimeEntrypoint(runArgs);

  return {
    bun: scopedEnvCommand?.bun || commandNeedsAwsMacosBun(runArgs),
    changedGate: isChangedGateCommand(runArgs),
    commandArgs: runArgs,
    packageManager: packageManagerNeeded,
    runtimeEntrypoint,
    scopedEnvCommand,
    swift: commandNeedsAwsMacosSwiftToolchain(runArgs),
  };
}

function prepareRemoteWsl2JsBootstrapScript(
  run: CommandInvocation,
  facts: RunFacts,
  provider: string,
  sourceBootstrap: string,
) {
  const runtimeEntrypoint = awsMacosBunEntrypoints.has(facts.runtimeEntrypoint)
    ? ""
    : facts.runtimeEntrypoint;
  if (
    !isBrokeredWsl2RemoteTarget(run.args, provider) ||
    (!runtimeEntrypoint && !facts.packageManager)
  ) {
    return { args: run.args, cleanup: () => {}, prepared: false };
  }

  if (run.start < 0) {
    return { args: run.args, cleanup: () => {}, prepared: false };
  }

  const scriptRoot = mkdtempSync(resolve(tmpdir(), "openclaw-crabbox-wsl2-script-"));
  const scriptPath = resolve(scriptRoot, "script.sh");
  const originalShellCommand = facts.scopedEnvCommand?.shellCommand ?? renderRunShellCommand(run);
  const script = `${remoteWsl2JsBootstrap({
    packageManager: facts.packageManager,
    sourceBootstrap,
  })} || exit $?\n{ ${originalShellCommand}\n}\n`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o700);

  const normalizedArgs = run.args.slice(0, run.optionEnd);
  if (!run.options.has("no-hydrate")) {
    normalizedArgs.push("--no-hydrate");
  }
  normalizedArgs.push("--script", scriptPath);

  return {
    args: normalizedArgs,
    cleanup: () => rmSync(scriptRoot, { recursive: true, force: true }),
    prepared: true,
  };
}

function injectRemoteAwsMacosJsBootstrap(
  run: CommandInvocation,
  facts: RunFacts,
  provider: string,
  sourceBootstrap: string,
) {
  if (
    !isAwsMacosRemoteTarget(run.args, provider) ||
    (!facts.runtimeEntrypoint && !facts.packageManager && !facts.bun && !sourceBootstrap)
  ) {
    return run.args;
  }

  if (run.start < 0) {
    return run.args;
  }

  const originalShellCommand = facts.scopedEnvCommand?.shellCommand ?? renderRunShellCommand(run);
  const shellCommand = `${remoteAwsMacosJsBootstrap({
    packageManager: facts.packageManager,
    bun: facts.bun,
    sourceBootstrap,
  })} && { ${originalShellCommand}\n}`;
  return replaceRunCommandWithShell(run, shellCommand);
}

function remoteAwsMacosSwiftBootstrap() {
  return [
    "openclaw_crabbox_require_macos_swift_63() {",
    'openclaw_xcode="";',
    'for openclaw_candidate in /Applications/Xcode_26*.app /Applications/Xcode-26*.app /Applications/Xcode_2[7-9]*.app /Applications/Xcode-2[7-9]*.app; do if [ -d "$openclaw_candidate" ]; then openclaw_xcode="$openclaw_candidate"; fi; done;',
    'if [ -n "$openclaw_xcode" ]; then openclaw_developer="$openclaw_xcode/Contents/Developer"; if [ ! -d "$openclaw_developer" ]; then openclaw_developer="$openclaw_xcode"; fi; sudo xcode-select -s "$openclaw_developer" || return 1; fi;',
    'openclaw_swift_version="$(swift --version 2>&1)" || { status=$?; printf "%s\\n" "$openclaw_swift_version" >&2; return "$status"; };',
    'printf "%s\\n" "$openclaw_swift_version" >&2;',
    'openclaw_swift_major_minor="$(printf "%s\\n" "$openclaw_swift_version" | sed -nE "s/.*Apple Swift version ([0-9]+)\\.([0-9]+).*/\\1 \\2/p" | head -n 1)";',
    'if [ -z "$openclaw_swift_major_minor" ]; then echo "[crabbox] OpenClaw macOS app proof requires Swift tools 6.3+; unable to parse swift --version." >&2; return 2; fi;',
    "set -- $openclaw_swift_major_minor;",
    'if [ "$1" -lt 6 ] || { [ "$1" -eq 6 ] && [ "$2" -lt 3 ]; }; then',
    'echo "[crabbox] OpenClaw macOS app proof requires Swift tools 6.3+ (Xcode 26.4+)." >&2;',
    'echo "[crabbox] current Swift is $1.$2; select/install Xcode 26.4 or newer." >&2;',
    "return 2;",
    "fi;",
    'openclaw_xcodebuild_version="$(xcodebuild -version 2>&1)" || { printf "%s\\n" "$openclaw_xcodebuild_version" >&2; echo "[crabbox] OpenClaw macOS app proof requires Xcode 26.4+; active developer directory does not provide usable xcodebuild." >&2; return 2; };',
    'printf "%s\\n" "$openclaw_xcodebuild_version" >&2;',
    'openclaw_xcode_major_minor="$(printf "%s\\n" "$openclaw_xcodebuild_version" | sed -nE "s/^Xcode ([0-9]+)\\.([0-9]+).*/\\1 \\2/p" | head -n 1)";',
    'if [ -z "$openclaw_xcode_major_minor" ]; then echo "[crabbox] OpenClaw macOS app proof requires Xcode 26.4+; unable to parse xcodebuild -version." >&2; return 2; fi;',
    "set -- $openclaw_xcode_major_minor;",
    'if [ "$1" -lt 26 ] || { [ "$1" -eq 26 ] && [ "$2" -lt 4 ]; }; then echo "[crabbox] OpenClaw macOS app proof requires Xcode 26.4+; current xcodebuild is $1.$2." >&2; return 2; fi;',
    "};",
    "openclaw_crabbox_require_macos_swift_63",
  ].join(" ");
}

function injectRemoteAwsMacosSwiftBootstrap(
  invocation: CommandInvocation,
  facts: RunFacts,
  providerName: string,
  force = false,
) {
  if (!isAwsMacosRemoteTarget(invocation.args, providerName) || (!force && !facts.swift)) {
    return invocation.args;
  }

  if (invocation.start < 0) {
    return invocation.args;
  }

  return replaceRunCommandWithShell(
    invocation,
    `${remoteAwsMacosSwiftBootstrap()} && { ${renderRunShellCommand(invocation)}\n}`,
  );
}

function replaceRunFlagWithScript(commandArgs: string[], flagName: string, scriptPath: string) {
  const invocation = parseCommandInvocation(help.text, commandArgs);
  const normalizedName = commandOptionName(flagName);
  const normalizedArgs = [...commandArgs];
  for (const { index, name } of invocation.optionEntries) {
    if (name === normalizedName) {
      normalizedArgs.splice(index, 1, "--script", scriptPath);
      return normalizedArgs;
    }
  }
  return normalizedArgs;
}

function prepareAwsMacosScriptStdinBootstrap(commandArgs: string[], providerName: string) {
  if (
    !isAwsMacosRemoteTarget(commandArgs, providerName) ||
    !parseCommandInvocation(help.text, commandArgs).options.has("script-stdin")
  ) {
    return { args: commandArgs, cleanup: () => {}, prepared: false };
  }

  const scriptRoot = mkdtempSync(resolve(tmpdir(), "openclaw-crabbox-macos-script-"));
  const scriptPath = resolve(scriptRoot, "script.sh");
  const script = readFileSync(0, "utf8");
  writeFileSync(scriptPath, createAwsMacosScriptStdinWrapper(script), "utf8");
  chmodSync(scriptPath, 0o700);
  return {
    args: replaceRunFlagWithScript(commandArgs, "--script-stdin", scriptPath),
    cleanup: () => rmSync(scriptRoot, { recursive: true, force: true }),
    prepared: true,
  };
}

function createAwsMacosScriptStdinWrapper(script: string) {
  const requirements = awsMacosScriptBootstrapRequirements(script);
  return wrapRemoteScript(script, remoteAwsMacosScriptBootstrap(requirements));
}

function wrapRemoteScript(script: string, bootstrap: string) {
  if (!script.startsWith("#!")) {
    return `${bootstrap} || exit $?\n${script}`;
  }
  const delimiterValue = uniqueHereDocDelimiter(script);
  return [
    `${bootstrap} || exit $?`,
    'tmp_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-crabbox-script.XXXXXX")" || exit $?',
    'cleanup_openclaw_crabbox_script() { rm -f "$tmp_script"; }',
    "trap cleanup_openclaw_crabbox_script EXIT",
    `cat >"$tmp_script" <<'${delimiterValue}'`,
    script.endsWith("\n") ? script.slice(0, -1) : script,
    delimiterValue,
    'chmod 700 "$tmp_script" || exit $?',
    '"$tmp_script" "$@"',
    "",
  ].join("\n");
}

function remoteAwsMacosScriptBootstrap(requirements: AwsMacosScriptRequirements) {
  const bootstraps = [remoteAwsMacosJsBootstrap(requirements)];
  if (requirements.swift) {
    bootstraps.push(remoteAwsMacosSwiftBootstrap());
  }
  return bootstraps.join(" && ");
}

function awsMacosScriptBootstrapRequirements(script: string) {
  const requirements = { packageManager: false, bun: false, swift: false };
  const firstLine = script.match(/^[^\r\n]*/u)?.[0] ?? "";
  if (firstLine.startsWith("#!")) {
    const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
    requirements.packageManager = commandWordsNeedEntrypoint(words, awsMacosCorepackEntrypoints);
    requirements.bun = commandWordsNeedEntrypoint(words, awsMacosBunEntrypoints);
    requirements.swift = commandWordsNeedAwsMacosSwiftToolchain(words);
    if (commandWordsShellEntrypoint(words)) {
      const body = script.slice(firstLine.length).replace(/^\r?\n/u, "");
      requirements.packageManager ||= commandNeedsAwsMacosPackageManager([body]);
      requirements.bun ||= commandNeedsAwsMacosBun([body]);
      requirements.swift ||= commandNeedsAwsMacosSwiftToolchain([body]);
    }
    return requirements;
  }
  requirements.packageManager = commandNeedsAwsMacosPackageManager([script]);
  requirements.bun = commandNeedsAwsMacosBun([script]);
  requirements.swift = commandNeedsAwsMacosSwiftToolchain([script]);
  return requirements;
}

function uniqueHereDocDelimiter(script: string) {
  let index = 0;
  for (;;) {
    const delimiterLocal = `OPENCLAW_CRABBOX_SCRIPT_${index}`;
    if (!new RegExp(`^${delimiterLocal}$`, "mu").test(script)) {
      return delimiterLocal;
    }
    index += 1;
  }
}

function isSparseCheckout() {
  const config = gitOutput(["config", "--bool", "core.sparseCheckout"]);
  if (config.status === 0 && config.stdout === "true") {
    return true;
  }
  const patterns = gitOutput(["sparse-checkout", "list"]);
  return patterns.status === 0 && patterns.stdout.length > 0;
}

function isWorktreeClean() {
  const status = gitOutput(["status", "--porcelain=v1"]);
  return status.status === 0 && status.stdout === "";
}

function needsSourceCapsule(commandArgs: string[], providerName: string) {
  return (
    commandArgs[0] === "run" &&
    !hasOption(commandArgs, "--no-sync") &&
    !isNativeWindowsRemoteTarget(commandArgs) &&
    (canonicalProviderName(providerName) === "blacksmith-testbox" ||
      analyzeRemoteCommand(parseCommandInvocation(help.text, commandArgs)).changedGate)
  );
}

function shouldUseFullCheckoutForRemoteSync(commandArgs: string[], providerName: string) {
  if (commandArgs[0] !== "run") {
    return false;
  }
  if (hasOption(commandArgs, "--no-sync")) {
    return false;
  }

  if (needsSourceCapsule(commandArgs, providerName)) {
    return true;
  }
  const changedGate = isChangedGateCommand(
    parseCommandInvocation(help.text, commandArgs).commandArgs,
  );
  return isWorktreeClean() && (isSparseCheckout() || changedGate);
}

function defaultFullCheckoutSyncRoot() {
  const home = homedir();
  if (home) {
    return resolve(home, ".cache", "openclaw", "crabbox-sync");
  }
  return resolve(tmpdir(), "openclaw-crabbox-sync");
}

function fullCheckoutSyncRoot() {
  const configured = process.env.OPENCLAW_CRABBOX_SYNC_TMPDIR?.trim();
  const root = configured ? resolve(configured) : defaultFullCheckoutSyncRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number, unit: string) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative integer ${unit}, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `${name} must be a safe non-negative integer ${unit}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

function formatByteCount(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function assertFullCheckoutSyncDisk(root: string) {
  const requiredBytes = parseNonNegativeIntegerEnv(
    "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES",
    1024 * 1024 * 1024,
    "byte count",
  );
  if (requiredBytes === 0) {
    return;
  }
  const stats = statfsSync(root);
  const freeBytes = stats.bavail * stats.bsize;
  if (freeBytes >= requiredBytes) {
    return;
  }
  throw new Error(
    [
      "insufficient free disk for Crabbox sparse-sync full checkout",
      `root=${root}`,
      `free=${formatByteCount(freeBytes)}`,
      `required=${formatByteCount(requiredBytes)}`,
      "set OPENCLAW_CRABBOX_SYNC_TMPDIR to a roomier filesystem or lower OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES if you know this checkout fits",
    ].join("; "),
  );
}

function prepareFullCheckoutForSync() {
  const syncRoot = fullCheckoutSyncRoot();
  assertFullCheckoutSyncDisk(syncRoot);
  const dir = mkdtempSync(resolve(syncRoot, "openclaw-crabbox-sync-"));
  let active = false;

  function create() {
    const add = gitOutput(["worktree", "add", "--detach", dir, "HEAD"]);
    if (add.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`git worktree add failed: ${add.text}`);
    }
    active = true;

    const disableSparse = gitOutput(["-C", dir, "sparse-checkout", "disable"]);
    if (disableSparse.status !== 0) {
      cleanupFullCheckout(dir, active);
      active = false;
      throw new Error(`git sparse-checkout disable failed: ${disableSparse.text}`);
    }
  }

  create();

  return {
    dir,
    restoreIfMissing() {
      try {
        if (statSync(dir).isDirectory()) {
          return false;
        }
      } catch {
        // Recreate below.
      }

      console.error(`[crabbox] temporary full checkout disappeared; recreating ${dir}`);
      if (active) {
        const remove = gitOutput(["worktree", "remove", "--force", dir]);
        if (remove.status !== 0) {
          console.error(`[crabbox] warning: git worktree remove failed for ${dir}: ${remove.text}`);
        }
        active = false;
      }
      rmSync(dir, { recursive: true, force: true });
      create();
      return true;
    },
    exists() {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    cleanup() {
      cleanupFullCheckout(dir, active);
      active = false;
    },
  };
}

function startFullCheckoutKeepalive(checkout: FullCheckout, options: KeepaliveOptions = {}) {
  let missingReported = false;
  const intervalMs = options.intervalMs ?? fullCheckoutKeepaliveIntervalMs();
  const refresh = () => {
    try {
      if (!checkout.exists()) {
        if (options.onMissing) {
          if (!missingReported) {
            missingReported = true;
            console.error(
              `[crabbox] temporary full checkout disappeared while Crabbox was running; terminating because the child cwd cannot be repaired: ${checkout.dir}`,
            );
            options.onMissing();
          }
          return;
        }
        checkout.restoreIfMissing();
      }
      const now = new Date();
      utimesSync(checkout.dir, now, now);
    } catch (error) {
      console.error(
        `[crabbox] warning: failed to refresh temporary full checkout ${checkout.dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  refresh();
  if (intervalMs <= 0) {
    return () => {};
  }

  const interval = setInterval(refresh, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

function fullCheckoutKeepaliveIntervalMs() {
  return parseNonNegativeIntegerEnv(
    "OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS",
    5000,
    "millisecond interval",
  );
}

function cleanupFullCheckout(dir: string, active: boolean) {
  if (active) {
    const remove = gitOutput(["worktree", "remove", "--force", dir]);
    if (remove.status === 0) {
      return;
    }
    console.error(`[crabbox] warning: git worktree remove failed for ${dir}: ${remove.text}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function assertFullCheckoutAvailableBeforeExit(dir: string) {
  try {
    if (statSync(dir).isDirectory()) {
      return true;
    }
  } catch {
    // Report below.
  }

  console.error(
    `[crabbox] temporary full checkout vanished before Crabbox finished syncing: ${dir}`,
  );
  return false;
}

function injectFullCheckoutLeaseReclaim(commandArgs: string[]) {
  if (
    commandArgs[0] !== "run" ||
    !hasOption(commandArgs, "--id") ||
    hasOption(commandArgs, "--reclaim")
  ) {
    return commandArgs;
  }
  const normalizedArgs = [...commandArgs];
  normalizedArgs.splice(commandOptionEnd(normalizedArgs), 0, "--reclaim");
  return normalizedArgs;
}

function injectRemoteTestboxCi(commandArgs: string[], providerName: string) {
  if (commandArgs[0] !== "run" || canonicalProviderName(providerName) !== "blacksmith-testbox") {
    return commandArgs;
  }
  const invocation = parseCommandInvocation(help.text, commandArgs);
  if (invocation.start < 0) {
    return commandArgs;
  }
  return replaceRunCommandWithShell(
    invocation,
    `export CI=true; ${renderRunShellCommand(invocation)}`,
  );
}

function applyRunTransforms(
  initialInvocation: CommandInvocation,
  initialFacts: RunFacts,
  options: {
    changedGateAlias: string;
    capsule: CrabboxSourceCapsule | null;
    childCwd: string;
    provider: string;
  },
) {
  const testboxWorkspace = canonicalProviderName(options.provider) === "blacksmith-testbox";
  const sourceBootstrap = options.capsule
    ? remoteSourceBootstrap(options.capsule, options.changedGateAlias, testboxWorkspace)
    : "";
  const markedArgs = injectRemoteChangedGateEnvironment(initialInvocation, initialFacts);
  const localArgs =
    options.childCwd === repoRoot ? markedArgs : absolutizeLocalRunPaths(markedArgs);
  let invocation = parseCommandInvocation(help.text, localArgs);
  const facts = analyzeRemoteCommand(invocation);

  const wsl2ScriptBootstrap = prepareRemoteWsl2JsBootstrapScript(
    invocation,
    facts,
    options.provider,
    sourceBootstrap,
  );
  let transformedArgs = wsl2ScriptBootstrap.args;
  let sourceScriptCleanup = () => {};
  try {
    if (sourceBootstrap && !wsl2ScriptBootstrap.prepared) {
      invocation = parseCommandInvocation(help.text, transformedArgs);
      if (invocation.options.has("script") || invocation.options.has("script-stdin")) {
        const scriptOption = invocation.options.get("script");
        const script = readFileSync(
          scriptOption ? resolve(repoRoot, scriptOption.value) : 0,
          "utf8",
        );
        const scriptRoot = mkdtempSync(resolve(tmpdir(), "openclaw-crabbox-source-script-"));
        const scriptPath = resolve(scriptRoot, "script.sh");
        sourceScriptCleanup = () => rmSync(scriptRoot, { recursive: true, force: true });
        writeFileSync(
          scriptPath,
          wrapRemoteScript(script, `${sourceBootstrap} || exit $?\nexport CI=true`),
        );
        chmodSync(scriptPath, 0o700);
        const entry = invocation.optionEntries.find(
          ({ name }) => name === "script" || name === "script-stdin",
        )!;
        transformedArgs = [...transformedArgs];
        transformedArgs.splice(
          entry.index,
          entry.name === "script" && !transformedArgs[entry.index]?.includes("=") ? 2 : 1,
          "--script",
          scriptPath,
        );
      } else if (
        invocation.start >= 0 &&
        !isAwsMacosRemoteTarget(transformedArgs, options.provider)
      ) {
        transformedArgs = replaceRunCommandWithShell(
          invocation,
          `${sourceBootstrap} || exit $?; ${renderRunShellCommand(invocation)}`,
        );
      }
    }
    invocation = parseCommandInvocation(help.text, transformedArgs);
    transformedArgs = injectRemoteAwsMacosJsBootstrap(
      invocation,
      facts,
      options.provider,
      sourceBootstrap,
    );
    invocation = parseCommandInvocation(help.text, transformedArgs);
    transformedArgs = injectRemoteAwsMacosSwiftBootstrap(
      invocation,
      facts,
      options.provider,
      facts.swift,
    );
    invocation = parseCommandInvocation(help.text, transformedArgs);
    transformedArgs = injectRemoteWindowsHydratedNodeModulesBootstrap(
      invocation,
      facts,
      options.provider,
    );
    invocation = parseCommandInvocation(help.text, transformedArgs);
    transformedArgs = injectRemotePosixHydratedNodeModulesBootstrap(invocation);
    return {
      args: injectRemoteTestboxCi(transformedArgs, options.provider),
      wsl2ScriptBootstrap: {
        ...wsl2ScriptBootstrap,
        cleanup() {
          wsl2ScriptBootstrap.cleanup();
          sourceScriptCleanup();
        },
      },
    };
  } catch (error) {
    wsl2ScriptBootstrap.cleanup();
    sourceScriptCleanup();
    throw error;
  }
}

const version = probeCrabboxMetadata(binary, ["--version"]);
const helpCommand = workloadCommand ? args.slice(0, userArgStart) : ["run"];
const help = probeCrabboxMetadata(binary, [...helpCommand, "--help"]);
const providers = parseProvidersFromHelp(help.text);
commandValueOptionsFromHelp = parseCommandValueOptionsFromHelp(help.text);
const displayBinary = binary === "crabbox" ? "crabbox" : relative(repoRoot, binary);

if (
  version.status !== 0 ||
  version.text.length === 0 ||
  help.status !== 0 ||
  commandValueOptionsFromHelp.size === 0
) {
  console.error(
    `[crabbox] bin=${displayBinary} version=${version.text || "unknown"} providers=${providers.join(",") || "unknown"}`,
  );
  console.error("[crabbox] selected binary failed basic --version/--help sanity checks");
  process.exit(2);
}

// Classify help before removing the wrapper separator or preparing execution.
// Only the leaf's option prefix counts; payloads and flag values stay gated.
// Upstream's `help <command> ...` alias appends --help, so extra payload is not safe.
const helpFlags = new Set(["--help", "-h"]);
const invocationOptions = workloadCommand ? parseCommandInvocation(help.text, args).options : null;
if (
  helpFlags.has(args[0] ?? "") ||
  helpFlags.has(args[userArgStart] ?? "") ||
  (args[0] === "help" && args.length <= commandUserArgStart(args.slice(1)) + 1) ||
  (["run", "warmup"].includes(args[0] ?? "") && args[1] === "help") ||
  invocationOptions?.has("help") ||
  invocationOptions?.has("h")
) {
  const invocation = spawnInvocation(binary, args, process.env, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    console.error(`[crabbox] ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

if (args[userArgStart] === "--") {
  args.splice(userArgStart, 1);
}

const providerSelection = selectedProvider(args, providers, version.text);
if (providerSelection.error) {
  console.error(`[crabbox] ${providerSelection.error}`);
  if (providerSelection.readiness) {
    console.error(
      `[crabbox] provider readiness ${formatProviderReadiness(providerSelection.readiness)}`,
    );
    for (const recovery of providerRecoveryAdvice(providerSelection.readiness)) {
      console.error(`[crabbox] recovery: ${recovery}`);
    }
  }
  process.exit(2);
}
const provider = providerSelection.provider;
const canonicalProvider = canonicalProviderName(provider);
const commandProviderValue = commandProvider(args);
let normalizedArgs = ensureAwsMacOnDemandMarket(
  ensurePolicyProvider(
    ensureNativeWindowsHydrateJob(ensureAzureWindowsProvider(args, provider, providers)),
    providerSelection,
  ),
  provider,
);

console.error(
  `[crabbox] bin=${displayBinary} version=${version.text || "unknown"} provider=${provider || "unknown"} providers=${providers.join(",") || "unknown"}`,
);
if (providerSelection.source === "policy") {
  console.error(
    `[crabbox] route workload=${providerSelection.workload} selected=${provider} chain=${providerSelection.chain.join(",")} readiness=${formatProviderReadiness(providerSelection.readiness ?? new Map())}`,
  );
}

if (provider && !isProviderAdvertised(provider, providers)) {
  if (providers.length === 0) {
    console.error(
      "[crabbox] could not parse provider list from --help; refusing to run with --provider without validation",
    );
    process.exit(2);
  }
  console.error(
    `[crabbox] selected binary does not advertise provider ${provider}; update Crabbox or choose a supported provider`,
  );
  process.exit(2);
}

if (
  needsSourceCapsule(normalizedArgs, provider) &&
  !satisfiesMinimumCrabboxVersion(version.text, minimumSourceCapsuleCrabboxVersion)
) {
  console.error(
    `[crabbox] source capsule requires Crabbox >= ${formatVersionTuple(minimumSourceCapsuleCrabboxVersion)} for sync-plan --json; update Crabbox and rerun.`,
  );
  console.error(`[crabbox] selected binary reported version=${version.text || "unknown"}.`);
  process.exit(2);
}

if (canonicalProvider === "blacksmith-testbox") {
  // Testbox owns sync; reject before lease or checkout side effects.
  if (normalizedArgs[0] === "run" && hasOption(normalizedArgs, "--no-sync")) {
    console.error(
      "[crabbox] provider=blacksmith-testbox does not support --no-sync. Omit the flag only when source synchronization is intended.",
    );
    process.exit(2);
  }

  if (isWindowsRemoteTarget(normalizedArgs)) {
    console.error(
      [
        "[crabbox] provider=blacksmith-testbox supports Linux Testbox proof only; it cannot run Windows or WSL2 targets.",
        "[crabbox] use provider=azure or provider=aws for brokered Crabbox Windows/WSL2 proof, provider=parallels for local Windows, or dispatch .github/workflows/windows-testbox-probe.yml for Blacksmith Windows runner probes.",
      ].join("\n"),
    );
    process.exit(2);
  }

  if (!satisfiesMinimumCrabboxVersion(version.text, minimumBlacksmithCrabboxVersion)) {
    console.error(
      [
        `[crabbox] provider=blacksmith-testbox requires Crabbox >= ${formatVersionTuple(minimumBlacksmithCrabboxVersion)} for current Testbox sync, queue, and cleanup behavior.`,
        `[crabbox] selected binary reported version=${version.text || "unknown"}.`,
        "[crabbox] if using ../crabbox, rebuild it: version=$(git -C ../crabbox describe --tags --always --dirty | sed 's/^v//') && go build -C ../crabbox -trimpath -ldflags \"-s -w -X github.com/openclaw/crabbox/internal/cli.version=${version}\" -o bin/crabbox ./cmd/crabbox",
      ].join("\n"),
    );
    process.exit(2);
  }
  const artifactRun =
    normalizedArgs[0] === "run" &&
    (hasOption(normalizedArgs, "--artifact-glob") ||
      hasOption(normalizedArgs, "--require-artifact"));
  if (artifactRun && !supportsPreparedTestboxArtifacts()) {
    console.error(
      "[crabbox] Testbox artifact collection requires Crabbox's prepared-artifact-workspace capability. Update Crabbox and retry; refusing to collect from the disposable sync checkout.",
    );
    process.exit(2);
  }
}

const explicitProviderRequested = Boolean(commandProviderValue);
enforceBrokeredDaytonaVersion(normalizedArgs, provider, version.text, explicitProviderRequested);
enforceBrokeredCloud(
  normalizedArgs,
  provider,
  explicitProviderRequested,
  providerSelection.readiness?.get(canonicalProvider),
);

if (canonicalProvider === "blacksmith-testbox") {
  const envProviderLocal = process.env.CRABBOX_PROVIDER?.trim();
  const source = commandProviderValue
    ? "explicit"
    : envProviderLocal
      ? "from CRABBOX_PROVIDER"
      : "from config";
  const fallback = commandProviderValue
    ? "rerun without --provider to use .crabbox.yaml"
    : envProviderLocal
      ? "unset CRABBOX_PROVIDER to use .crabbox.yaml"
      : "pass another --provider to override it";
  console.error(
    `[crabbox] provider=blacksmith-testbox ${source}; if Testbox is queued or down, ${fallback}`,
  );
  console.error(
    "[crabbox] delegated Testbox proof uses the wrapper exitCode and timing JSON; the linked Actions run can show cancelled during external lease cleanup",
  );
  enforceCrabboxOwnedBlacksmithLease(normalizedArgs);
}

let testboxLeaseFreshness;
try {
  testboxLeaseFreshness = prepareTestboxLeaseFreshness({
    args: normalizedArgs,
    env: { ...process.env, CI: process.env.CI || "true" },
    provider: canonicalProvider,
    repoRoot,
  });
} catch (error) {
  console.error(`[crabbox] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let childCwd = repoRoot;
let cleanupChildCwd = () => {};
let fullCheckout = null;
let stopFullCheckoutKeepalive = () => {};
let cleanupDone = false;
let sourceCapsule: CrabboxSourceCapsule | null = null;
let remoteChangedGateAlias = "";
let capturedBlacksmithLeaseId = "";
const scriptBootstrap = prepareAwsMacosScriptStdinBootstrap(normalizedArgs, provider);
normalizedArgs = scriptBootstrap.args;
const scriptStdinPrepared = scriptBootstrap.prepared;
let wsl2ScriptBootstrap = { args: normalizedArgs, cleanup: () => {}, prepared: false };
try {
  if (shouldUseFullCheckoutForRemoteSync(normalizedArgs, provider)) {
    const invocation = parseCommandInvocation(help.text, normalizedArgs);
    const facts = analyzeRemoteCommand(invocation);
    const changedGate = facts.changedGate ? changedGateBaseForCommand(facts.commandArgs) : null;
    const changedGateBase = changedGate?.resolvedBase ?? "";
    const needsCapsule = needsSourceCapsule(normalizedArgs, provider);
    if (needsCapsule) {
      const syncRoot = fullCheckoutSyncRoot();
      assertFullCheckoutSyncDisk(syncRoot);
      sourceCapsule = prepareCrabboxSourceCapsule({
        repoRoot,
        syncRoot,
        binary,
        base: changedGateBase || changedGateBaseForCommand([]).resolvedBase,
      });
    }
    const capsule = sourceCapsule;
    const checkout = capsule
      ? {
          dir: capsule.directory,
          cleanup: capsule.cleanup,
          exists: () => pathExists(capsule.directory),
          restoreIfMissing() {
            if (!pathExists(capsule.directory)) {
              throw new Error("frozen source checkout disappeared; rerun from the local candidate");
            }
            return false;
          },
        }
      : prepareFullCheckoutForSync();
    fullCheckout = checkout;
    normalizedArgs = injectFullCheckoutLeaseReclaim(normalizedArgs);
    // Crabbox claims Git's physical top-level. Match it so macOS /var aliases
    // restore to the invoking repository instead of the disposable checkout.
    childCwd = realpathSync(checkout.dir);
    cleanupChildCwd = () => checkout.cleanup();
    remoteChangedGateAlias = changedGate?.remoteAlias ?? "";
    console.error(
      `[crabbox] isolated checkout sync; syncing from temporary full checkout ${checkout.dir}`,
    );
    if (facts.changedGate && capsule) {
      console.error(
        `[crabbox] remote changed gate detected; overlaying the local worktree as changes from ${capsule.baseSha}`,
      );
    }
  }
} catch (error) {
  scriptBootstrap.cleanup();
  sourceCapsule?.cleanup();
  throw error;
}

function cleanupOnce() {
  if (cleanupDone) {
    return;
  }
  cleanupDone = true;
  stopFullCheckoutKeepalive();
  wsl2ScriptBootstrap.cleanup();
  scriptBootstrap.cleanup();
  if (canonicalProvider === "blacksmith-testbox") {
    // Crabbox stamps claims with its cwd. Delegated runs use a throwaway sync checkout,
    // so restore the real repo or every later reuse needs --reclaim.
    restoreTemporaryBlacksmithTestboxClaim(normalizedArgs, capturedBlacksmithLeaseId);
  }
  try {
    preserveTemporaryCrabboxArtifacts();
  } catch (error) {
    console.error(
      `[crabbox] artifact preservation failed; temporary checkout retained at ${childCwd}`,
    );
    throw error;
  }
  cleanupChildCwd();
}

const invocation = parseCommandInvocation(help.text, normalizedArgs);
const commandFacts = analyzeRemoteCommand(invocation);
const runtimeEntrypoint = commandFacts.runtimeEntrypoint;
if (
  normalizedArgs[0] === "run" &&
  provider === "aws" &&
  (runtimeEntrypoint || scriptStdinPrepared)
) {
  if (isAwsMacosRemoteTarget(normalizedArgs, provider)) {
    console.error(
      `[crabbox] provider=aws macOS raw boxes may lack Node/Corepack/pnpm/Bun for ${runtimeEntrypoint || "--script-stdin"}; bootstrapping pinned user-local JavaScript tooling before the command`,
    );
  } else {
    const id = optionValue(normalizedArgs, "--id");
    const hydrate = id
      ? `pnpm crabbox:hydrate -- --id ${id}`
      : "pnpm crabbox:warmup, then pnpm crabbox:hydrate -- --id <id>";
    console.error(
      `[crabbox] warning: provider=aws raw boxes may lack Node/Corepack/pnpm/Bun for ${runtimeEntrypoint}; hydrate first (${hydrate}) or pass --provider blacksmith-testbox for OpenClaw CI-like proof; not switching providers automatically`,
    );
  }
}
if (normalizedArgs[0] === "run" && isBrokeredWsl2RemoteTarget(normalizedArgs, provider)) {
  const wsl2RuntimeEntrypoint = awsMacosBunEntrypoints.has(runtimeEntrypoint)
    ? ""
    : runtimeEntrypoint;
  if (wsl2RuntimeEntrypoint || commandFacts.packageManager) {
    console.error(
      `[crabbox] provider=${provider} WSL2 raw boxes may lack Node/Corepack/pnpm for ${wsl2RuntimeEntrypoint || "package-manager"}; using no-hydrate pinned user-local JavaScript tooling before the command`,
    );
  }
}

const childEnv = { ...process.env };
if (sourceCapsule?.configPath) {
  childEnv.CRABBOX_CONFIG = sourceCapsule.configPath;
}
if (canonicalProvider === "blacksmith-testbox" && !childEnv.CI) {
  childEnv.CI = "true";
}
if (
  isLocalContainerProvider(provider) &&
  !childEnv.CRABBOX_LOCAL_CONTAINER_DOCKER_SOCKET &&
  !hasOption(normalizedArgs, "--local-container-docker-socket")
) {
  childEnv.CRABBOX_LOCAL_CONTAINER_DOCKER_SOCKET = "1";
  console.error(
    "[crabbox] provider=docker enabling host Docker socket pass-through for OpenClaw Docker tests",
  );
}
if (
  isLocalContainerProvider(provider) &&
  process.platform === "linux" &&
  !childEnv.CRABBOX_LOCAL_CONTAINER_WORK_ROOT &&
  !hasOption(normalizedArgs, "--local-container-work-root")
) {
  childEnv.CRABBOX_LOCAL_CONTAINER_WORK_ROOT = "/tmp/openclaw-crabbox-docker-work";
  console.error(
    "[crabbox] provider=docker using short host-visible work root for OpenClaw Docker tests",
  );
}

try {
  const transformed = applyRunTransforms(invocation, commandFacts, {
    changedGateAlias: remoteChangedGateAlias,
    capsule: sourceCapsule,
    childCwd,
    provider,
  });
  wsl2ScriptBootstrap = transformed.wsl2ScriptBootstrap;
  normalizedArgs = transformed.args;
} catch (error) {
  cleanupOnce();
  throw error;
}
const childArgs = normalizedArgs;
let fullCheckoutKeepaliveIntervalMsValue = 0;
if (fullCheckout) {
  try {
    fullCheckoutKeepaliveIntervalMsValue = fullCheckoutKeepaliveIntervalMs();
  } catch (error) {
    cleanupOnce();
    throw error;
  }
}
const childInvocation = spawnInvocation(binary, childArgs, childEnv, process.platform);
const captureBlacksmithTimingJSON =
  canonicalProvider === "blacksmith-testbox" && hasOption(normalizedArgs, "--timing-json");
// Fast-fail hint context: run --id reuse dies in under a second when the
// lease hit its idle timeout, with only a bare nonzero exit from the binary.
const reusedRunLeaseId = normalizedArgs[0] === "run" ? optionValue(normalizedArgs, "--id") : "";
const childStartedAtMs = Date.now();
const FAST_FAIL_HINT_WINDOW_MS = 15_000;
const child = spawn(childInvocation.command, childInvocation.args, {
  cwd: childCwd,
  stdio: ["inherit", "inherit", captureBlacksmithTimingJSON ? "pipe" : "inherit"],
  detached: process.platform !== "win32",
  env: childEnv,
  windowsVerbatimArguments: childInvocation.windowsVerbatimArguments,
});
const childStderr = child.stderr;
if (childStderr) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discardingOversizedLine = false;
  const observeText = (text: string) => {
    let remaining = text;
    while (remaining) {
      const newline = remaining.indexOf("\n");
      const fragment = newline >= 0 ? remaining.slice(0, newline) : remaining;
      if (!discardingOversizedLine) {
        pending += fragment;
        if (pending.length > MAX_TIMING_JSON_LINE_CHARS) {
          pending = "";
          discardingOversizedLine = true;
        }
      }
      if (newline < 0) {
        return;
      }
      if (!discardingOversizedLine) {
        observeBlacksmithTimingJSONLine(pending);
      }
      pending = "";
      discardingOversizedLine = false;
      remaining = remaining.slice(newline + 1);
    }
  };
  childStderr.on("data", (chunk: Buffer) => {
    const canContinue = process.stderr.write(chunk);
    observeText(decoder.write(chunk));
    if (!canContinue) {
      childStderr.pause();
      process.stderr.once("drain", () => childStderr.resume());
    }
  });
  childStderr.on("end", () => {
    observeText(decoder.end());
    if (pending && !discardingOversizedLine) {
      observeBlacksmithTimingJSONLine(pending);
    }
  });
}
const childKillGraceMs = resolveChildKillGraceMs(process.env);
let childForceKillTimer: ReturnType<typeof setTimeout> | undefined;
let childTreeShutdownStarted = false;
if (fullCheckout) {
  try {
    stopFullCheckoutKeepalive = startFullCheckoutKeepalive(fullCheckout, {
      intervalMs: fullCheckoutKeepaliveIntervalMsValue,
      onMissing: () => {
        void exitAfterChildTreeTermination(child, "SIGTERM", 1);
      },
    });
  } catch (error) {
    signalChildProcessTree(child, "SIGTERM");
    cleanupOnce();
    throw error;
  }
}

const signalExitCodes = new Map<Signal, number>([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
for (const signal of signalExitCodes.keys()) {
  process.on(signal, () => {
    void exitAfterChildTreeTermination(child, signal, signalExitCodes.get(signal) ?? 1);
  });
}
process.once("exit", cleanupOnce);

child.on("exit", (code, signal) => {
  clearChildForceKillTimer();
  if (childTreeShutdownStarted) {
    return;
  }
  let exitCode = code;
  let fullCheckoutAvailable = true;
  if (fullCheckout) {
    fullCheckoutAvailable = assertFullCheckoutAvailableBeforeExit(fullCheckout.dir);
  }
  if (!signal && code === 0) {
    try {
      recordTestboxLeaseFreshness(testboxLeaseFreshness);
    } catch (error) {
      console.error(
        `[crabbox] failed to record Testbox lease freshness: ${error instanceof Error ? error.message : String(error)}`,
      );
      exitCode = 2;
    }
  }
  cleanupOnce();
  if (signal) {
    process.exit(signalExitCodes.get(signal) ?? 1);
    return;
  }
  const finalExitCode = fullCheckoutAvailable ? (exitCode ?? 1) : 1;
  if (
    finalExitCode !== 0 &&
    reusedRunLeaseId &&
    Date.now() - childStartedAtMs < FAST_FAIL_HINT_WINDOW_MS
  ) {
    console.error(
      `[crabbox] run --id ${reusedRunLeaseId} failed fast; reusable leases expire after their idle timeout and rejected flags also exit immediately. Check the first error line above, verify the lease with \`node scripts/crabbox-wrapper.mjs list\`, or warm a fresh one with \`node scripts/crabbox-wrapper.mjs warmup\`.`,
    );
  }
  process.exit(finalExitCode);
});

child.on("error", (error) => {
  clearChildForceKillTimer();
  if (childTreeShutdownStarted) {
    return;
  }
  if (fullCheckout) {
    assertFullCheckoutAvailableBeforeExit(fullCheckout.dir);
  }
  cleanupOnce();
  console.error(`[crabbox] failed to execute ${displayBinary}: ${error.message}`);
  process.exit(2);
});

async function exitAfterChildTreeTermination(
  childProcess: ChildProcess,
  signal: Signal,
  exitCode: number,
) {
  if (childTreeShutdownStarted) {
    signalChildProcessTree(childProcess, "SIGKILL");
    return;
  }
  childTreeShutdownStarted = true;
  signalChildProcessTree(childProcess, signal);
  await waitForChildTreeExit(childProcess, childKillGraceMs);
  if (childProcessTreeIsAlive(childProcess)) {
    signalChildProcessTree(childProcess, "SIGKILL");
  }
  await waitForChildTreeExit(childProcess, childKillGraceMs);
  cleanupOnce();
  process.exit(exitCode);
}

function signalChildProcessTree(childProcess: ChildProcess, signal: Signal) {
  if (
    process.platform === "win32" &&
    (childProcess.exitCode !== null || childProcess.signalCode !== null)
  ) {
    return;
  }
  try {
    if (process.platform !== "win32" && typeof childProcess.pid === "number") {
      process.kill(-childProcess.pid, signal);
    } else {
      childProcess.kill(signal);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      try {
        childProcess.kill(signal);
      } catch {}
    }
  }
  if (signal !== "SIGKILL" && !childForceKillTimer) {
    childForceKillTimer = setTimeout(() => {
      childForceKillTimer = undefined;
      signalChildProcessTree(childProcess, "SIGKILL");
    }, childKillGraceMs);
    childForceKillTimer.unref?.();
  }
}

function clearChildForceKillTimer() {
  if (childForceKillTimer) {
    clearTimeout(childForceKillTimer);
    childForceKillTimer = undefined;
  }
}

function childProcessTreeIsAlive(childProcess: ChildProcess) {
  if (process.platform === "win32" || typeof childProcess.pid !== "number") {
    return childProcess.exitCode === null && childProcess.signalCode === null;
  }
  try {
    process.kill(-childProcess.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForChildTreeExit(childProcess: ChildProcess, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!childProcessTreeIsAlive(childProcess)) {
      clearChildForceKillTimer();
      return true;
    }
    await new Promise((done) => {
      setTimeout(done, 50);
    });
  }
  return !childProcessTreeIsAlive(childProcess);
}

function resolveChildKillGraceMs(env: ProcessEnv) {
  if (!env.VITEST || !env.OPENCLAW_TEST_CRABBOX_CHILD_KILL_GRACE_MS) {
    return 5_000;
  }
  const value = Number.parseInt(env.OPENCLAW_TEST_CRABBOX_CHILD_KILL_GRACE_MS, 10);
  return Number.isFinite(value) && value >= 0 ? value : 5_000;
}

function resolveMetadataProbeTimeoutMs(env: ProcessEnv) {
  if (!env.VITEST || !env.OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS) {
    return CRABBOX_METADATA_PROBE_TIMEOUT_MS;
  }
  const value = Number.parseInt(env.OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : CRABBOX_METADATA_PROBE_TIMEOUT_MS;
}
