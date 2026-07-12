#!/usr/bin/env node
// Resolves and delegates to the repo-local or PATH crabbox binary.
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalProviderName,
  isProviderAdvertised,
  parseProvidersFromHelp,
} from "./crabbox-wrapper-providers.mjs";
import {
  prepareTestboxLeaseFreshness,
  recordTestboxLeaseFreshness,
} from "./testbox-lease-freshness.mjs";
import { resolvePathEnvKey, resolveWindowsCmdExePath } from "./windows-cmd-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRABBOX_METADATA_PROBE_TIMEOUT_MS = 5_000;
// A cold Crabbox (first call after an upgrade, or one on a loaded machine) can
// exceed the snappy default probe timeout while it renders `run --help` or does
// first-run init. Retry the metadata probes once with this generous timeout so a
// single slow probe does not hard-fail the wrapper and block all remote validation.
const CRABBOX_METADATA_PROBE_RETRY_TIMEOUT_MS = 20_000;
const ignoreRepoBinary = process.env.OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY === "1";
const repoLocal = ignoreRepoBinary ? null : resolveCrabboxBinary(process.env, process.platform);
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
const userArgStart = args[0] === "actions" && args[1] === "hydrate" ? 2 : 1;
if (args[userArgStart] === "--") {
  args.splice(userArgStart, 1);
}

function commandCandidates(command, platform) {
  if (platform !== "win32") {
    return [command];
  }
  if (extname(command)) {
    return [command];
  }
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.com`, command];
}

function resolveCrabboxBinary(env, platform) {
  const base = resolve(repoRoot, "../crabbox/bin/crabbox");
  for (const candidate of commandCandidates(base, platform)) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function resolvePathBinary(command, env, platform) {
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

function resolveGitCommonCrabboxBinary(env, platform) {
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

function isExecutableFile(path, platform) {
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

function spawnInvocation(command, commandArgs, env, platform) {
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

function resolveNodeCmdShim(command, platform) {
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
    const script = resolve(dirname(command), match[2]);
    if (!isExecutableFile(script, platform)) {
      continue;
    }
    return { node: match[1], args: [script] };
  }
  const npmCmdShim = resolveNpmNodeCmdShim(command, content, platform);
  if (npmCmdShim) {
    return npmCmdShim;
  }
  return null;
}

function resolveNpmNodeCmdShim(command, content, platform) {
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
  if (!match || match[1].trim()) {
    return null;
  }
  const script = resolve(dirname(command), match[2].replace(/^%dp0%\\/iu, ""));
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
const awsMacosBunVersion = "1.3.14";
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

function escapeBatchCommand(command) {
  return `${command}`.replace(cmdMetaCharactersRe, "^$1");
}

function escapeBatchArgument(arg) {
  let escaped = `${arg}`;
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(cmdMetaCharactersRe, "^$1");
  return escaped.replace(cmdMetaCharactersRe, "^$1");
}

function buildBatchCommandLine(command, commandArgs) {
  const escapedCommand = escapeBatchCommand(command);
  const escapedArgs = commandArgs.map(escapeBatchArgument);
  return `"${[escapedCommand, ...escapedArgs].join(" ")}"`;
}

function checkedOutput(
  command,
  commandArgs,
  timeoutMs = resolveMetadataProbeTimeoutMs(process.env),
) {
  const invocation = spawnInvocation(command, commandArgs, process.env, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = result.error?.name === "Error" && result.signal === "SIGKILL";
  return {
    status: timedOut ? 124 : (result.status ?? 1),
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    stdout: (result.stdout ?? "").trim(),
  };
}

// Probe Crabbox metadata (`--version` / `run --help`) with one generous retry.
// A cold Crabbox can be SIGKILLed by the snappy default timeout or emit nothing
// on the first call, then be instant and clean on the next. Retrying keeps the
// warm path fast (one ~instant probe) while stopping a single slow probe from
// tripping the sanity/provider-list guards and blocking all remote validation.
function probeCrabboxMetadata(command, commandArgs) {
  const first = checkedOutput(command, commandArgs);
  if (first.status === 0 && first.text.length > 0) {
    return first;
  }
  return checkedOutput(command, commandArgs, CRABBOX_METADATA_PROBE_RETRY_TIMEOUT_MS);
}

function parseCrabboxVersion(value) {
  const match = `${value}`.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:-([^\s+]+))?(?:\+[^\s]+)?\b/u);
  if (!match) {
    return null;
  }
  const tuple = match.slice(1, 4).map(parseVersionTuplePart);
  if (tuple.some((part) => part === null)) {
    return null;
  }
  return {
    tuple,
    suffix: match[4] ?? "",
  };
}

function parseVersionTuplePart(value) {
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareVersionTuples(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function formatVersionTuple(version) {
  return version.join(".");
}

function isPostReleaseDescribeSuffix(suffix) {
  return /^\d+-g[0-9a-f]+(?:-dirty)?$/iu.test(suffix);
}

function satisfiesMinimumCrabboxVersion(version, minimum) {
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

function gitOutput(commandArgs) {
  const gitBinary = resolvePathBinary("git", process.env, process.platform) ?? "git";
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
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

function envProvider() {
  const envProviderValue = process.env.CRABBOX_PROVIDER?.trim();
  if (envProviderValue) {
    return envProviderValue;
  }
  return "";
}

function configProvider() {
  try {
    const config = readFileSync(resolve(repoRoot, ".crabbox.yaml"), "utf8");
    const match = config.match(/^provider:\s*([^\s#]+)/m);
    return match?.[1] ?? "aws";
  } catch {
    return "aws";
  }
}

function configuredProvider() {
  return envProvider() || configProvider();
}

const runValueOptions = new Set([
  "allow-env",
  "artifact-glob",
  "azure-location",
  "azure-os-disk",
  "azure-resource-group",
  "azure-subnet",
  "azure-vnet",
  "blacksmith-job",
  "blacksmith-org",
  "blacksmith-ref",
  "blacksmith-workflow",
  "capture-stderr",
  "capture-stdout",
  "class",
  "cloudflare-url",
  "cloudflare-workdir",
  "daytona-api-url",
  "daytona-snapshot",
  "daytona-ssh-access-minutes",
  "daytona-ssh-gateway-host",
  "daytona-target",
  "daytona-user",
  "daytona-work-root",
  "download",
  "env-from-profile",
  "env-helper",
  "e2b-api-url",
  "e2b-domain",
  "e2b-template",
  "e2b-user",
  "e2b-workdir",
  "fresh-pr",
  "id",
  "idle-timeout",
  "islo-base-url",
  "islo-disk-gb",
  "islo-gateway-profile",
  "islo-image",
  "islo-memory-mb",
  "islo-snapshot-name",
  "islo-vcpus",
  "islo-workdir",
  "junit",
  "label",
  "market",
  "modal-app",
  "modal-image",
  "modal-python",
  "modal-workdir",
  "namespace-auto-stop-idle-timeout",
  "namespace-image",
  "namespace-repository",
  "namespace-site",
  "namespace-size",
  "namespace-volume-size-gb",
  "namespace-work-root",
  "network",
  "preflight-tools",
  "profile",
  "proof-template",
  "provider",
  "proxmox-api-url",
  "proxmox-bridge",
  "proxmox-node",
  "proxmox-pool",
  "proxmox-storage",
  "proxmox-template-id",
  "proxmox-user",
  "proxmox-work-root",
  "script",
  "scenario",
  "semaphore-host",
  "semaphore-idle-timeout",
  "semaphore-machine",
  "semaphore-os-image",
  "semaphore-project",
  "sprites-api-url",
  "sprites-work-root",
  "static-host",
  "static-port",
  "static-user",
  "static-work-root",
  "stop-after",
  "tailscale-auth-key-env",
  "tailscale-exit-node",
  "tailscale-hostname-template",
  "tailscale-tags",
  "target",
  "tensorlake-api-url",
  "tensorlake-cli",
  "tensorlake-cpus",
  "tensorlake-disk-mb",
  "tensorlake-image",
  "tensorlake-memory-mb",
  "tensorlake-namespace",
  "tensorlake-organization-id",
  "tensorlake-project-id",
  "tensorlake-snapshot",
  "tensorlake-timeout-secs",
  "tensorlake-workdir",
  "ttl",
  "type",
  "emit-proof",
  "preset",
  "preset-var",
  "windows-mode",
]);

let runValueOptionsFromHelp;

function parseRunValueOptionsFromHelp(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(
      /^\s+-{1,2}([a-z0-9][a-z0-9-]*)\s+(?:string|duration|int|float|value)\b/u,
    );
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function currentRunValueOptions() {
  if (!runValueOptionsFromHelp) {
    runValueOptionsFromHelp = new Set([
      ...runValueOptions,
      ...parseRunValueOptionsFromHelp(help.text),
    ]);
  }
  return runValueOptionsFromHelp;
}

function runOptionName(arg) {
  return arg.replace(/^-+/u, "").split("=", 1)[0];
}

function runCommandBounds(commandArgs) {
  if (commandArgs[0] !== "run") {
    return { start: -1, optionEnd: commandArgs.length };
  }
  for (let index = 1; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--") {
      return { start: index + 1, optionEnd: index };
    }
    if (!arg.startsWith("-")) {
      return { start: index, optionEnd: index };
    }
    if (!arg.includes("=") && currentRunValueOptions().has(runOptionName(arg))) {
      index += 1;
    }
  }
  return { start: -1, optionEnd: commandArgs.length };
}

function crabboxOptionArgs(commandArgs) {
  const bounds = runCommandBounds(commandArgs);
  if (commandArgs[0] === "run") {
    return commandArgs.slice(0, bounds.optionEnd);
  }
  const delimiterCandidate = commandArgs.indexOf("--");
  return delimiterCandidate >= 0 ? commandArgs.slice(0, delimiterCandidate) : commandArgs;
}

function commandProvider(commandArgsInput) {
  let commandArgs = commandArgsInput;
  commandArgs = crabboxOptionArgs(commandArgs);
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--provider" || arg === "-provider") {
      return commandArgs[index + 1] ?? "";
    }
    if (arg.startsWith("--provider=") || arg.startsWith("-provider=")) {
      return arg.slice(arg.indexOf("=") + 1);
    }
  }
  return "";
}

function selectedProvider(commandArgs, advertisedProviders = []) {
  const explicitProvider = commandProvider(commandArgs);
  if (explicitProvider) {
    return explicitProvider;
  }
  if (shouldPreferAzureForWindows(commandArgs, advertisedProviders)) {
    return "azure";
  }
  return configuredProvider();
}

function shouldRequireBrokeredAws(commandArgs, providerName) {
  if (process.env.OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS === "1") {
    return false;
  }
  const canonicalProvider = canonicalProviderName(providerName);
  if (canonicalProvider !== "aws") {
    return false;
  }
  if (commandArgs[0] === "run" || commandArgs[0] === "warmup") {
    return true;
  }
  return commandArgs[0] === "actions" && commandArgs[1] === "hydrate";
}

function brokerAuthConfigured() {
  const config = checkedOutput(binary, ["config", "show", "--json"]);
  if (config.status !== 0) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(config.stdout || config.text);
  } catch {
    return false;
  }
  if (!parsed?.coordinator || parsed?.brokerAuth !== "configured") {
    return false;
  }
  return checkedOutput(binary, ["whoami"]).status === 0;
}

function enforceBrokeredAws(commandArgs, providerName) {
  if (!shouldRequireBrokeredAws(commandArgs, providerName) || brokerAuthConfigured()) {
    return;
  }
  console.error(
    [
      "[crabbox] provider=aws requires a configured Crabbox broker for OpenClaw proof.",
      "[crabbox] run `crabbox login --url https://crabbox.openclaw.ai --provider aws`, then retry.",
      "[crabbox] for intentional direct AWS provider debugging, set OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS=1.",
    ].join("\n"),
  );
  process.exit(2);
}

function optionValue(commandArgsInput, name) {
  let commandArgs = commandArgsInput;
  commandArgs = crabboxOptionArgs(commandArgs);
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === name || arg === name.replace(/^--/u, "-")) {
      return commandArgs[index + 1] ?? "";
    }
    if (arg.startsWith(`${name}=`) || arg.startsWith(`${name.replace(/^--/u, "-")}=`)) {
      return arg.slice(arg.indexOf("=") + 1);
    }
  }
  return "";
}

function hasOption(commandArgsInput, name) {
  let commandArgs = commandArgsInput;
  commandArgs = crabboxOptionArgs(commandArgs);
  const shortName = name.replace(/^--/u, "-");
  for (const arg of commandArgs) {
    if (
      arg === name ||
      arg === shortName ||
      arg.startsWith(`${name}=`) ||
      arg.startsWith(`${shortName}=`)
    ) {
      return true;
    }
  }
  return false;
}

function commandOptionEnd(commandArgs) {
  if (commandArgs[0] === "run") {
    return runCommandBounds(commandArgs).optionEnd;
  }
  const delimiterEntry = commandArgs.indexOf("--");
  return delimiterEntry >= 0 ? delimiterEntry : commandArgs.length;
}

function shouldPreferAzureForWindows(commandArgs, advertisedProviders = []) {
  return (
    ["run", "warmup"].includes(commandArgs[0]) &&
    isWindowsRemoteTarget(commandArgs) &&
    !commandProvider(commandArgs) &&
    !envProvider() &&
    !hasOption(commandArgs, "--id") &&
    advertisedProviders.includes("azure")
  );
}

function ensureAzureWindowsProvider(commandArgs, providerName, advertisedProviders = []) {
  if (providerName !== "azure" || !shouldPreferAzureForWindows(commandArgs, advertisedProviders)) {
    return commandArgs;
  }

  const optionEnd = commandOptionEnd(commandArgs);
  const normalizedArgs = [...commandArgs];
  normalizedArgs.splice(optionEnd, 0, "--provider", "azure");
  return normalizedArgs;
}

function ensureAwsMacOnDemandMarket(commandArgs, providerName) {
  if (
    !["run", "warmup"].includes(commandArgs[0]) ||
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

function ensureNativeWindowsHydrateJob(commandArgs) {
  if (
    commandArgs[0] !== "actions" ||
    commandArgs[1] !== "hydrate" ||
    !isNativeWindowsRemoteTarget(commandArgs)
  ) {
    return commandArgs;
  }

  const currentJob = optionValue(commandArgs, "--job");
  if (currentJob && currentJob !== "hydrate") {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const replacementJob = "hydrate-windows-daemon";
  const optionEnd = commandOptionEnd(normalizedArgs);
  for (let index = 0; index < optionEnd; index += 1) {
    const arg = normalizedArgs[index];
    if (arg === "--job" || arg === "-job") {
      normalizedArgs[index + 1] = replacementJob;
      return normalizedArgs;
    }
    if (arg.startsWith("--job=") || arg.startsWith("-job=")) {
      normalizedArgs[index] = `${arg.slice(0, arg.indexOf("=") + 1)}${replacementJob}`;
      return normalizedArgs;
    }
  }

  normalizedArgs.splice(optionEnd, 0, "--job", replacementJob);
  return normalizedArgs;
}

const localPathRunOptions = new Set([
  "capture-stderr",
  "capture-stdout",
  "emit-proof",
  "env-from-profile",
  "script",
]);

function repoRelativePath(value) {
  if (!value || value === "-" || isAbsolute(value)) {
    return value;
  }
  return resolve(repoRoot, value);
}

function repoRelativeDownload(value) {
  const split = value.indexOf("=");
  if (split < 0) {
    return value;
  }
  const remote = value.slice(0, split + 1);
  const local = value.slice(split + 1);
  return `${remote}${repoRelativePath(local)}`;
}

function absolutizeLocalRunPaths(commandArgs) {
  if (commandArgs[0] !== "run") {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const { optionEnd } = runCommandBounds(normalizedArgs);
  for (let index = 1; index < optionEnd; index += 1) {
    const arg = normalizedArgs[index];
    if (!arg.startsWith("-")) {
      continue;
    }

    const optionName = runOptionName(arg);
    const absolutize = optionName === "download" ? repoRelativeDownload : repoRelativePath;
    if (localPathRunOptions.has(optionName) || optionName === "download") {
      const equals = arg.indexOf("=");
      if (equals >= 0) {
        normalizedArgs[index] = `${arg.slice(0, equals + 1)}${absolutize(arg.slice(equals + 1))}`;
      } else if (index + 1 < optionEnd) {
        normalizedArgs[index + 1] = absolutize(normalizedArgs[index + 1]);
        index += 1;
      }
      continue;
    }

    if (!arg.includes("=") && currentRunValueOptions().has(optionName)) {
      index += 1;
    }
  }
  return normalizedArgs;
}

function pathExists(path) {
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

function userDisplayPath(path) {
  const home = homedir();
  const rel = relative(home, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return `~/${rel}`;
  }
  return path;
}

function blacksmithTestboxPrivateKeyPath(id) {
  return resolve(crabboxConfigDir(), "testboxes", id, "id_ed25519");
}

// Crabbox claims bind raw Testbox ids to one repo before remote execution.
// Check the same sidecar so a dependency exit bug cannot make refusal green.
function blacksmithTestboxClaimRepoRoot(id) {
  const configuredStateRoot = process.env.XDG_STATE_HOME?.trim();
  const stateDir = configuredStateRoot
    ? resolve(configuredStateRoot, "crabbox")
    : resolve(crabboxConfigDir(), "state");
  const claimPath = resolve(stateDir, "claims", `${id}.json`);
  if (!pathExists(claimPath)) {
    return "";
  }
  const claim = JSON.parse(readFileSync(claimPath, "utf8"));
  return typeof claim.repoRoot === "string" ? claim.repoRoot : "";
}

function enforceCrabboxOwnedBlacksmithLease(commandArgs) {
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

function preserveTemporaryCrabboxRuns() {
  if (childCwd === repoRoot) {
    return;
  }

  const sourceRuns = resolve(childCwd, ".crabbox", "runs");
  if (!pathExists(sourceRuns)) {
    return;
  }

  const targetRuns = resolve(repoRoot, ".crabbox", "runs");
  mkdirSync(targetRuns, { recursive: true });
  let preserved = 0;
  for (const entry of readdirSync(sourceRuns)) {
    cpSync(resolve(sourceRuns, entry), resolve(targetRuns, entry), {
      recursive: true,
      force: true,
    });
    preserved += 1;
  }
  if (preserved > 0) {
    console.error(
      `[crabbox] preserved ${preserved} temporary run artifact ${preserved === 1 ? "directory" : "directories"} under ${relative(repoRoot, targetRuns)}`,
    );
  }
}

function shellQuote(value) {
  const text = `${value}`;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function shellJoin(commandArgs) {
  return commandArgs.map(shellQuote).join(" ");
}

function powershellQuote(value) {
  const text = `${value}`;
  if (text === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=%+-]+$/u.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

function powershellJoin(commandArgs) {
  return commandArgs.map(powershellQuote).join(" ");
}

function isLocalContainerProvider(providerName) {
  return ["local-container", "docker", "container", "local-docker"].includes(providerName);
}

function runCommandArgs(commandArgs) {
  const { start } = runCommandBounds(commandArgs);
  return start >= 0 ? commandArgs.slice(start) : [];
}

function normalizedCommandWords(commandArgs) {
  const words = commandArgs.length === 1 ? commandArgs[0].split(/\s+/u) : [...commandArgs];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
    words.shift();
  }
  return words.map((word) => word.replace(/^['"]|['";|&()]+$/g, ""));
}

function commandRuntimeEntrypoint(commandArgs) {
  if (commandArgs.length === 1) {
    for (const candidateWords of shellCommandWordCandidates(commandArgs[0])) {
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

function commandWordsRuntimeEntrypoint(wordsInput) {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop();
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

function commandWordsShellEntrypoint(wordsInput) {
  const words = normalizeExecutableWords(wordsInput);
  const first = shellWordBasename(words[0]);
  return shellInlineCommandInterpreters.has(first) ? first : "";
}

function commandNeedsAwsMacosPackageManager(commandArgs, options = {}) {
  if (isChangedGateCommand(commandArgs)) {
    return true;
  }
  if (commandNeedsEntrypoint(commandArgs, awsMacosCorepackEntrypoints, options)) {
    return true;
  }
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some((words) =>
      commandWordsNeedAwsMacosPackageManager(words, options),
    );
  }
  return commandWordsNeedAwsMacosPackageManager(normalizedCommandWords(commandArgs), options);
}

function commandNeedsAwsMacosBun(commandArgs) {
  return commandNeedsEntrypoint(commandArgs, awsMacosBunEntrypoints);
}

function commandNeedsAwsMacosSwiftToolchain(commandArgs) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some(commandWordsNeedAwsMacosSwiftToolchain);
  }
  return commandWordsNeedAwsMacosSwiftToolchain(normalizedCommandWords(commandArgs));
}

function commandWordsNeedAwsMacosSwiftToolchain(wordsInput) {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop();
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
    if (awsMacosSwiftScriptTargets.has(scriptName)) {
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

function commandWordsNeedAwsMacosPackageManager(wordsInput, options = {}) {
  let words = wordsInput;
  const originalFirst = shellWordBasename(normalizedCommandWords(wordsInput)[0]);
  const canShimIgnoreEnvironment = options.canShimIgnoreEnvironment !== false;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop();
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

function isAwsMacosSwiftScriptTarget(word) {
  if (!word) {
    return false;
  }
  const normalized = word.replace(/^\.\//u, "");
  return (
    awsMacosSwiftScriptTargets.has(normalized) ||
    awsMacosSwiftScriptTargets.has(normalized.split("/").pop() ?? "")
  );
}

function isAwsMacosPackageManagerScriptTarget(word) {
  if (!word) {
    return false;
  }
  const normalized = word.replace(/^\.\//u, "");
  return (
    awsMacosPackageManagerScriptTargets.has(normalized) ||
    awsMacosPackageManagerScriptTargets.has(normalized.split("/").pop() ?? "")
  );
}

function commandWordsRunScriptTarget(words, isScriptTarget) {
  const first = (words[0] ?? "").split("/").pop();
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

function commandWordsRunAwsMacosSwiftScript(words) {
  return commandWordsRunScriptTarget(words, isAwsMacosSwiftScriptTarget);
}

function commandWordsRunAwsMacosPackageManagerScript(words) {
  return commandWordsRunScriptTarget(words, isAwsMacosPackageManagerScriptTarget);
}

function commandNeedsEntrypoint(commandArgs, entrypoints, options = {}) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some((words) =>
      commandWordsNeedEntrypoint(words, entrypoints, options),
    );
  }
  return commandWordsNeedEntrypoint(normalizedCommandWords(commandArgs), entrypoints, options);
}

function commandWordsNeedEntrypoint(wordsInput, entrypoints, options = {}) {
  let words = wordsInput;
  words = normalizeExecutableWords(words, options);
  const first = (words[0] ?? "").split("/").pop();
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

function isChangedGateCommand(commandArgs) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some(isChangedGateCommandWords);
  }
  const words = normalizedCommandWords(commandArgs);
  return isChangedGateCommandWords(words, {
    canShimIgnoreEnvironment: shellWordBasename(commandArgs[0]) === "env",
  });
}

function isChangedGateCommandWords(wordsInput, options = {}) {
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

function isChangedGateWords(wordsInput) {
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

function nodeScriptWord(words) {
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

function nodeOptionsWithoutScriptPrefix(word) {
  return word.startsWith("--eval=") || word.startsWith("--print=");
}

function nodeOptionValueModeBeforeScript(word) {
  if (nodeOptionsWithNextValueBeforeScript.has(word)) {
    return "next";
  }
  const equalsIndex = word.indexOf("=");
  if (equalsIndex > 0 && nodeOptionsWithNextValueBeforeScript.has(word.slice(0, equalsIndex))) {
    return "inline";
  }
  return "";
}

function shellInlineCommand(words) {
  const command = shellWordBasename(words[0]);
  if (!shellInlineCommandInterpreters.has(command)) {
    return "";
  }

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
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

function shellInlineCommandOptionConsumesNextValue(word) {
  return shellInlineCommandOptionsWithNextValue.has(word) || /^[+-][^-+]*[oO]$/u.test(word);
}

function shellCommandWordCandidates(command) {
  return shellCommandSegments(stripHeredocBodies(command.replace(/\\\r?\n/gu, " ")));
}

function pushShellCandidate(candidates, segment) {
  const words = normalizedShellSegmentWords(segment);
  if (words.length > 0) {
    candidates.push(words);
  }
}

function normalizedShellSegmentWords(segment) {
  const trimmed = segment.trim().replace(/^[({]\s*/u, "");
  if (!trimmed || trimmed.startsWith("#")) {
    return [];
  }
  const words = normalizedCommandWords(splitShellWords(trimmed));
  while (shellControlCommandPrefixes.has(words[0])) {
    words.shift();
  }
  const normalizedWords = normalizedCommandWords(words);
  return normalizedCommandWords(stripShellExecutionPrefixes(normalizedWords));
}

function normalizeExecutableWords(words, options = {}) {
  return normalizedCommandWords(stripShellExecutionPrefixes(words, options));
}

function stripShellExecutionPrefixes(wordsInput, options = {}) {
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

function stripEnvCommandOptions(words, { canShimIgnoreEnvironment = true } = {}) {
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

function isSupportedSystemEnvCommand(command) {
  return command === "env" || command === "/usr/bin/env";
}

function shellWordBasename(word) {
  return (word ?? "").split("/").pop() ?? "";
}

function stripCommandBuiltinOptions(words) {
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

function stripTimeOptions(words) {
  while ((words[0] ?? "").startsWith("-")) {
    if (words[0] === "--") {
      words.shift();
      return;
    }
    words.shift();
  }
}

function stripTimeoutOptions(words) {
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

function splitShellWords(value) {
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

function stripHeredocBodies(command) {
  const lines = command.split("\n");
  const kept = [];
  const pendingDelimiters = [];
  for (const line of lines) {
    if (pendingDelimiters.length > 0) {
      const current = pendingDelimiters[0];
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

function lineHeredocDelimiters(line) {
  const delimiters = [];
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
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

function readHeredocDelimiter(line, startIndex) {
  let delimiterResult = "";
  let quote = "";
  let escaped = false;
  let quoted = false;
  let index = startIndex;
  for (; index < line.length; index += 1) {
    const char = line[index];
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

function extractCommandSubstitutionBodies(line) {
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

function shellCommandSegments(command) {
  const segments = [];
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

function readCommandSubstitution(command, startIndex) {
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

function startsShellReservedWord(command, index, word) {
  if (!command.startsWith(word, index)) {
    return false;
  }
  const after = command[index + word.length] ?? "";
  return !after || /\s|[;&|()<>]/u.test(after);
}

function startsShellToken(command, index, word) {
  if (!command.startsWith(word, index)) {
    return false;
  }
  const before = command[index - 1] ?? "";
  const after = command[index + word.length] ?? "";
  return (!before || /\s|[;&|()<>]/u.test(before)) && (!after || /\s|[;&|()<>]/u.test(after));
}

function skipUntilNewline(command, index) {
  const newlineIndex = command.indexOf("\n", index);
  return newlineIndex < 0 ? command.length - 1 : newlineIndex;
}

function mergeBaseForChangedGate() {
  const base = gitOutput(["merge-base", "origin/main", "HEAD"]);
  return base.status === 0 && base.stdout ? base.stdout : "origin/main";
}

function remoteGitBootstrapForChangedGate(changedGateBase) {
  const quotedBase = shellQuote(changedGateBase);
  return [
    "openclaw_changed_gate_base=${OPENCLAW_CHANGED_GATE_BASE:-" + quotedBase + "};",
    'if ! command -v git >/dev/null 2>&1; then echo "git is required for OpenClaw remote changed-gate sync" >&2; exit 2; fi;',
    'openclaw_changed_gate_remote_base="$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)";',
    'if ! git status --short >/dev/null 2>&1 || [ "$openclaw_changed_gate_remote_base" != "$openclaw_changed_gate_base" ]; then',
    "rm -rf .git;",
    "git init -q;",
    "git remote add origin https://github.com/openclaw/openclaw.git 2>/dev/null || git remote set-url origin https://github.com/openclaw/openclaw.git;",
    'git fetch -q --depth=1 origin "$openclaw_changed_gate_base:refs/remotes/origin/main";',
    "git reset --mixed --quiet refs/remotes/origin/main;",
    "git add -A;",
    "if ! git diff --cached --quiet; then git -c user.name=OpenClaw -c user.email=ci@openclaw.local commit -q --no-gpg-sign -m remote-changed-gate-tree; fi;",
    "fi",
  ].join(" ");
}

function injectRemoteChangedGateEnvironment(commandArgs) {
  if (commandArgs[0] !== "run" || isNativeWindowsRemoteTarget(commandArgs)) {
    return commandArgs;
  }

  const { start } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const remoteCommand = commandArgs.slice(start);
  if (!isChangedGateCommand(remoteCommand)) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const markedRemoteCommand =
    hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? [markShellChangedGateAsRemoteChild(remoteCommand[0])]
      : markDirectChangedGateAsRemoteChild(remoteCommand);
  normalizedArgs.splice(start, normalizedArgs.length - start, ...markedRemoteCommand);
  return normalizedArgs;
}

function markShellChangedGateAsRemoteChild(command) {
  return `export ${remoteChangedGateEnv.join(" ")}; ${command}`;
}

function markDirectChangedGateAsRemoteChild(commandArgs) {
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

function envAssignmentInsertIndex(words) {
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

function isWindowsRemoteTarget(commandArgs) {
  return (
    optionValue(commandArgs, "--target") === "windows" || hasOption(commandArgs, "--windows-mode")
  );
}

function isNativeWindowsRemoteTarget(commandArgs) {
  return (
    isWindowsRemoteTarget(commandArgs) && optionValue(commandArgs, "--windows-mode") !== "wsl2"
  );
}

function isAwsMacosRemoteTarget(commandArgs, providerName) {
  return (
    commandArgs[0] === "run" &&
    providerName === "aws" &&
    optionValue(commandArgs, "--target") === "macos"
  );
}

function isBrokeredWsl2RemoteTarget(commandArgs, providerName) {
  const canonicalProvider = canonicalProviderName(providerName);
  return (
    commandArgs[0] === "run" &&
    (canonicalProvider === "aws" || canonicalProvider === "azure") &&
    isWindowsRemoteTarget(commandArgs) &&
    optionValue(commandArgs, "--windows-mode") === "wsl2"
  );
}

function isHydratedNativeWindowsProvider(providerName) {
  return providerName === "aws" || providerName === "azure";
}

function remoteWindowsHydratedNodeModulesBootstrap() {
  return [
    "$openclawModulesDir = $env:PNPM_CONFIG_MODULES_DIR",
    "if ($openclawModulesDir) {",
    'if (-not (Test-Path $openclawModulesDir)) { throw "PNPM_CONFIG_MODULES_DIR does not exist: $openclawModulesDir" }',
    '$openclawWorkspaceModules = Join-Path (Get-Location).Path "node_modules"',
    '$openclawSelfModules = Join-Path $openclawModulesDir "node_modules"',
    'if (-not (Test-Path $openclawSelfModules)) { cmd /c mklink /J "$openclawSelfModules" "$openclawModulesDir" | Out-Host; if ($LASTEXITCODE -ne 0) { throw "failed to link hydrated pnpm node_modules" } }',
    'if (-not (Test-Path $openclawWorkspaceModules)) { cmd /c mklink /J "$openclawWorkspaceModules" "$openclawModulesDir" | Out-Host; if ($LASTEXITCODE -ne 0) { throw "failed to link workspace node_modules" } }',
    "}",
  ].join("; ");
}

function injectRemoteWindowsHydratedNodeModulesBootstrap(commandArgs, providerName) {
  const runtimeEntrypoint = commandRuntimeEntrypoint(runCommandArgs(commandArgs));
  if (
    commandArgs[0] !== "run" ||
    !isHydratedNativeWindowsProvider(providerName) ||
    !isNativeWindowsRemoteTarget(commandArgs) ||
    !hasOption(commandArgs, "--id") ||
    !runtimeEntrypoint
  ) {
    return commandArgs;
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const remoteCommand = normalizedArgs.slice(start);
  const originalShellCommand =
    hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : powershellJoin(remoteCommand);
  const shellCommand = `${remoteWindowsHydratedNodeModulesBootstrap()}; ${originalShellCommand}`;

  if (!hasOption(normalizedArgs, "--shell")) {
    normalizedArgs.splice(optionEnd, 0, "--shell");
  }

  const updatedBounds = runCommandBounds(normalizedArgs);
  normalizedArgs.splice(
    updatedBounds.start,
    normalizedArgs.length - updatedBounds.start,
    shellCommand,
  );
  return normalizedArgs;
}

function injectRemoteChangedGateGitBootstrap(commandArgs, changedGateBase) {
  if (!changedGateBase || commandArgs[0] !== "run" || isWindowsRemoteTarget(commandArgs)) {
    return commandArgs;
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const remoteCommand = normalizedArgs.slice(start);
  const originalShellCommand =
    hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : shellJoin(remoteCommand);
  const shellCommand = `${remoteGitBootstrapForChangedGate(changedGateBase)} && ${originalShellCommand}`;

  if (!hasOption(normalizedArgs, "--shell")) {
    normalizedArgs.splice(optionEnd, 0, "--shell");
  }

  const updatedBounds = runCommandBounds(normalizedArgs);
  normalizedArgs.splice(
    updatedBounds.start,
    normalizedArgs.length - updatedBounds.start,
    shellCommand,
  );
  return normalizedArgs;
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

function remoteAwsMacosJsBootstrap({ packageManager = false, bun = false } = {}) {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_MACOS_NODE_VERSION?.trim() || "24.15.0";
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

function remoteWsl2JsBootstrap({ packageManager = false } = {}) {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_WSL2_NODE_VERSION?.trim() || "24.15.0";
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

function scopedAwsMacosEnvCommand(commandArgs) {
  if (commandArgs.length <= 1 || !isSupportedSystemEnvCommand(commandArgs[0])) {
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

function scopedAwsMacosShellEnvCommand(command) {
  const candidates = shellCommandWordCandidates(command);
  if (candidates.length < 1) {
    return null;
  }

  const eligibleSegments = new Set();
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

function shellWordsKey(words) {
  return JSON.stringify(words);
}

function shellCommandWithEnvShim(command, eligibleSegments) {
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

function shellCommandSegmentsWithBounds(command) {
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

function shellHeredocBodyRanges(command) {
  const ranges = [];
  const pendingDelimiters = [];
  let lineStart = 0;
  for (;;) {
    const newlineIndex = command.indexOf("\n", lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex : command.length;
    const nextLineStart = newlineIndex >= 0 ? newlineIndex + 1 : command.length;
    const line = command.slice(lineStart, lineEnd);

    if (pendingDelimiters.length > 0) {
      ranges.push({ start: lineStart, end: nextLineStart });
      const current = pendingDelimiters[0];
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

function leadingShellEnvCommandToken(command, start = 0) {
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

function skipLeadingTimeCommand(command, start) {
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

function readLeadingShellWord(command, start) {
  let word = "";
  let quote = "";
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index];
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

function remoteWsl2JsBootstrapRequirements(commandArgs) {
  const runArgs = runCommandArgs(commandArgs);
  const directScopedEnvCommand = hasOption(commandArgs, "--shell")
    ? null
    : scopedAwsMacosEnvCommand(runArgs);
  const shellScopedEnvCommand =
    hasOption(commandArgs, "--shell") && runArgs.length === 1
      ? scopedAwsMacosShellEnvCommand(runArgs[0])
      : null;
  const scopedEnvCommand = directScopedEnvCommand ?? shellScopedEnvCommand;
  const packageManagerFallbackNeeded = scopedEnvCommand
    ? commandNeedsAwsMacosPackageManager(runArgs)
    : commandNeedsAwsMacosPackageManager(runArgs, { canShimIgnoreEnvironment: false });
  const packageManagerNeeded = scopedEnvCommand?.packageManager || packageManagerFallbackNeeded;
  const runtimeEntrypoint =
    scopedEnvCommand?.runtimeEntrypoint || commandRuntimeEntrypoint(runArgs);
  const runtimeNeeded =
    runtimeEntrypoint && !awsMacosBunEntrypoints.has(runtimeEntrypoint) ? runtimeEntrypoint : "";

  return {
    scopedEnvCommand,
    packageManager: packageManagerNeeded,
    runtimeEntrypoint: runtimeNeeded,
  };
}

function prepareRemoteWsl2JsBootstrapScript(commandArgs, providerName) {
  const requirements = remoteWsl2JsBootstrapRequirements(commandArgs);
  if (
    !isBrokeredWsl2RemoteTarget(commandArgs, providerName) ||
    (!requirements.runtimeEntrypoint && !requirements.packageManager)
  ) {
    return { args: commandArgs, cleanup: () => {}, prepared: false };
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return { args: commandArgs, cleanup: () => {}, prepared: false };
  }

  const scriptRoot = mkdtempSync(resolve(tmpdir(), "openclaw-crabbox-wsl2-script-"));
  const scriptPath = resolve(scriptRoot, "script.sh");
  const remoteCommand = commandArgs.slice(start);
  const originalShellCommand =
    requirements.scopedEnvCommand?.shellCommand ??
    (hasOption(commandArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : shellJoin(remoteCommand));
  const script = `${remoteWsl2JsBootstrap({
    packageManager: requirements.packageManager,
  })} || exit $?\n{ ${originalShellCommand}\n}\n`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o700);

  const normalizedArgs = commandArgs.slice(0, optionEnd);
  if (!hasOption(normalizedArgs, "--no-hydrate")) {
    normalizedArgs.push("--no-hydrate");
  }
  normalizedArgs.push("--script", scriptPath);

  return {
    args: normalizedArgs,
    cleanup: () => rmSync(scriptRoot, { recursive: true, force: true }),
    prepared: true,
  };
}

function injectRemoteAwsMacosJsBootstrap(commandArgs, providerName) {
  const runArgs = runCommandArgs(commandArgs);
  const directScopedEnvCommand = hasOption(commandArgs, "--shell")
    ? null
    : scopedAwsMacosEnvCommand(runArgs);
  const shellScopedEnvCommand =
    hasOption(commandArgs, "--shell") && runArgs.length === 1
      ? scopedAwsMacosShellEnvCommand(runArgs[0])
      : null;
  const scopedEnvCommand = directScopedEnvCommand ?? shellScopedEnvCommand;
  const packageManagerFallbackNeeded = scopedEnvCommand
    ? commandNeedsAwsMacosPackageManager(runArgs)
    : commandNeedsAwsMacosPackageManager(runArgs, { canShimIgnoreEnvironment: false });
  const packageManagerNeeded = scopedEnvCommand?.packageManager || packageManagerFallbackNeeded;
  const bunNeeded = scopedEnvCommand?.bun || commandNeedsAwsMacosBun(runArgs);
  const runtimeEntrypoint =
    scopedEnvCommand?.runtimeEntrypoint || commandRuntimeEntrypoint(runArgs);
  if (
    !isAwsMacosRemoteTarget(commandArgs, providerName) ||
    (!runtimeEntrypoint && !packageManagerNeeded && !bunNeeded)
  ) {
    return commandArgs;
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const remoteCommand = normalizedArgs.slice(start);
  const originalShellCommand =
    scopedEnvCommand?.shellCommand ??
    (hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : shellJoin(remoteCommand));
  const shellCommand = `${remoteAwsMacosJsBootstrap({
    packageManager: packageManagerNeeded,
    bun: bunNeeded,
  })} && { ${originalShellCommand}\n}`;

  if (!hasOption(normalizedArgs, "--shell")) {
    normalizedArgs.splice(optionEnd, 0, "--shell");
  }

  const updatedBounds = runCommandBounds(normalizedArgs);
  normalizedArgs.splice(
    updatedBounds.start,
    normalizedArgs.length - updatedBounds.start,
    shellCommand,
  );
  return normalizedArgs;
}

function remoteAwsMacosSwiftBootstrap() {
  return [
    "openclaw_crabbox_require_macos_swift_62() {",
    'openclaw_xcode="";',
    'for openclaw_candidate in /Applications/Xcode_26.1.app /Applications/Xcode_26*.app /Applications/Xcode-26*.app; do if [ -d "$openclaw_candidate" ]; then openclaw_xcode="$openclaw_candidate"; fi; done;',
    'if [ -n "$openclaw_xcode" ]; then openclaw_developer="$openclaw_xcode/Contents/Developer"; if [ ! -d "$openclaw_developer" ]; then openclaw_developer="$openclaw_xcode"; fi; sudo xcode-select -s "$openclaw_developer" || return 1; fi;',
    'openclaw_swift_version="$(swift --version 2>&1)" || { status=$?; printf "%s\\n" "$openclaw_swift_version" >&2; return "$status"; };',
    'printf "%s\\n" "$openclaw_swift_version" >&2;',
    'openclaw_swift_major_minor="$(printf "%s\\n" "$openclaw_swift_version" | sed -nE "s/.*Apple Swift version ([0-9]+)\\.([0-9]+).*/\\1 \\2/p" | head -n 1)";',
    'if [ -z "$openclaw_swift_major_minor" ]; then echo "[crabbox] OpenClaw macOS app proof requires Swift tools 6.2+; unable to parse swift --version." >&2; return 2; fi;',
    "set -- $openclaw_swift_major_minor;",
    'if [ "$1" -lt 6 ] || { [ "$1" -eq 6 ] && [ "$2" -lt 2 ]; }; then',
    'echo "[crabbox] OpenClaw macOS app proof requires Swift tools 6.2+ (Xcode 26.x)." >&2;',
    'echo "[crabbox] current Swift is $1.$2; select/install Xcode 26.x or use a Blacksmith macOS runner with Xcode_26.1.app." >&2;',
    "return 2;",
    "fi;",
    'openclaw_xcodebuild_version="$(xcodebuild -version 2>&1)" || { printf "%s\\n" "$openclaw_xcodebuild_version" >&2; echo "[crabbox] OpenClaw macOS app proof requires Xcode 26.x; active developer directory does not provide usable xcodebuild." >&2; return 2; };',
    'printf "%s\\n" "$openclaw_xcodebuild_version" >&2;',
    'openclaw_xcode_major="$(printf "%s\\n" "$openclaw_xcodebuild_version" | sed -nE "s/^Xcode ([0-9]+)(\\..*)?$/\\1/p" | head -n 1)";',
    'if [ "$openclaw_xcode_major" != "26" ]; then echo "[crabbox] OpenClaw macOS app proof requires Xcode 26.x; current xcodebuild is ${openclaw_xcode_major:-unknown}." >&2; return 2; fi;',
    "};",
    "openclaw_crabbox_require_macos_swift_62",
  ].join(" ");
}

function injectRemoteAwsMacosSwiftBootstrap(commandArgs, providerName, force = false) {
  const runArgs = runCommandArgs(commandArgs);
  if (
    !isAwsMacosRemoteTarget(commandArgs, providerName) ||
    (!force && !commandNeedsAwsMacosSwiftToolchain(runArgs))
  ) {
    return commandArgs;
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const remoteCommand = normalizedArgs.slice(start);
  const originalShellCommand =
    hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : shellJoin(remoteCommand);
  const shellCommand = `${remoteAwsMacosSwiftBootstrap()} && { ${originalShellCommand}\n}`;

  if (!hasOption(normalizedArgs, "--shell")) {
    normalizedArgs.splice(optionEnd, 0, "--shell");
  }

  const updatedBounds = runCommandBounds(normalizedArgs);
  normalizedArgs.splice(
    updatedBounds.start,
    normalizedArgs.length - updatedBounds.start,
    shellCommand,
  );
  return normalizedArgs;
}

function hasRunOption(commandArgs, name) {
  if (commandArgs[0] !== "run") {
    return false;
  }
  const { optionEnd } = runCommandBounds(commandArgs);
  const normalizedName = name.replace(/^-+/u, "");
  for (let index = 1; index < optionEnd; index += 1) {
    const arg = commandArgs[index];
    if (arg.startsWith("-") && runOptionName(arg) === normalizedName) {
      return true;
    }
    if (!arg.includes("=") && currentRunValueOptions().has(runOptionName(arg))) {
      index += 1;
    }
  }
  return false;
}

function replaceRunFlagWithScript(commandArgs, flagName, scriptPath) {
  const { optionEnd } = runCommandBounds(commandArgs);
  const normalizedName = flagName.replace(/^-+/u, "");
  const normalizedArgs = [...commandArgs];
  for (let index = 1; index < optionEnd; index += 1) {
    const arg = normalizedArgs[index];
    if (arg.startsWith("-") && runOptionName(arg) === normalizedName) {
      normalizedArgs.splice(index, 1, "--script", scriptPath);
      return normalizedArgs;
    }
    if (!arg.includes("=") && currentRunValueOptions().has(runOptionName(arg))) {
      index += 1;
    }
  }
  return normalizedArgs;
}

function prepareAwsMacosScriptStdinBootstrap(commandArgs, providerName) {
  if (
    !isAwsMacosRemoteTarget(commandArgs, providerName) ||
    !hasRunOption(commandArgs, "--script-stdin")
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

function createAwsMacosScriptStdinWrapper(script) {
  const requirements = awsMacosScriptBootstrapRequirements(script);
  if (!script.startsWith("#!")) {
    return `${remoteAwsMacosScriptBootstrap(requirements)} || exit $?\n${script}`;
  }
  const delimiterValue = uniqueHereDocDelimiter(script);
  return [
    `${remoteAwsMacosScriptBootstrap(requirements)} || exit $?`,
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

function remoteAwsMacosScriptBootstrap(requirements) {
  const bootstraps = [remoteAwsMacosJsBootstrap(requirements)];
  if (requirements.swift) {
    bootstraps.push(remoteAwsMacosSwiftBootstrap());
  }
  return bootstraps.join(" && ");
}

function awsMacosScriptBootstrapRequirements(script) {
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

function uniqueHereDocDelimiter(script) {
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

function shouldUseFullCheckoutForCleanRemoteSync(commandArgs, _providerName) {
  if (commandArgs[0] !== "run") {
    return false;
  }
  if (hasOption(commandArgs, "--no-sync")) {
    return false;
  }
  if (!isWorktreeClean()) {
    return false;
  }

  return isSparseCheckout() || isChangedGateCommand(runCommandArgs(commandArgs));
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

function parseNonNegativeIntegerEnv(name, fallback, unit) {
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

function formatByteCount(bytes) {
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

function assertFullCheckoutSyncDisk(root) {
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

function prepareFullCheckoutForSync(options = {}) {
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

    if (options.changedGateBase) {
      const reset = gitOutput(["-C", dir, "reset", "--mixed", "--quiet", options.changedGateBase]);
      if (reset.status !== 0) {
        cleanupFullCheckout(dir, active);
        active = false;
        throw new Error(`git reset for changed-gate sync failed: ${reset.text}`);
      }
    }
  }

  create();

  return {
    dir,
    changedGateBase: options.changedGateBase ?? "",
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

function startFullCheckoutKeepalive(checkout, options = {}) {
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

function cleanupFullCheckout(dir, active) {
  if (active) {
    const remove = gitOutput(["worktree", "remove", "--force", dir]);
    if (remove.status === 0) {
      return;
    }
    console.error(`[crabbox] warning: git worktree remove failed for ${dir}: ${remove.text}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function assertFullCheckoutAvailableBeforeExit(dir) {
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

function injectFullCheckoutLeaseReclaim(commandArgs) {
  if (
    commandArgs[0] !== "run" ||
    !hasOption(commandArgs, "--id") ||
    hasOption(commandArgs, "--reclaim")
  ) {
    return commandArgs;
  }
  const normalizedArgs = [...commandArgs];
  const { optionEnd } = runCommandBounds(normalizedArgs);
  normalizedArgs.splice(optionEnd, 0, "--reclaim");
  return normalizedArgs;
}

function injectRemoteTestboxCi(commandArgs, providerName) {
  if (commandArgs[0] !== "run" || canonicalProviderName(providerName) !== "blacksmith-testbox") {
    return commandArgs;
  }
  const normalizedArgs = [...commandArgs];
  const { start } = runCommandBounds(normalizedArgs);
  if (start < 0) {
    return normalizedArgs;
  }
  if (hasOption(normalizedArgs, "--shell")) {
    normalizedArgs[start] = `export CI=true; ${normalizedArgs[start]}`;
  } else {
    normalizedArgs.splice(start, 0, "env", "CI=true");
  }
  return normalizedArgs;
}

const version = probeCrabboxMetadata(binary, ["--version"]);
const help = probeCrabboxMetadata(binary, ["run", "--help"]);
const providers = parseProvidersFromHelp(help.text);
const displayBinary = binary === "crabbox" ? "crabbox" : relative(repoRoot, binary);
const provider = selectedProvider(args, providers);
const canonicalProvider = canonicalProviderName(provider);
const commandProviderValue = commandProvider(args);
let normalizedArgs = ensureAwsMacOnDemandMarket(
  ensureNativeWindowsHydrateJob(ensureAzureWindowsProvider(args, provider, providers)),
  provider,
);

console.error(
  `[crabbox] bin=${displayBinary} version=${version.text || "unknown"} provider=${provider || "unknown"} providers=${providers.join(",") || "unknown"}`,
);

if (version.status !== 0 || help.status !== 0) {
  console.error("[crabbox] selected binary failed basic --version/--help sanity checks");
  process.exit(2);
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

if (canonicalProvider === "blacksmith-testbox") {
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
}

enforceBrokeredAws(normalizedArgs, provider);

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
let remoteChangedGateBase = "";
const scriptBootstrap = prepareAwsMacosScriptStdinBootstrap(normalizedArgs, provider);
normalizedArgs = scriptBootstrap.args;
const scriptStdinPrepared = scriptBootstrap.prepared;
let wsl2ScriptBootstrap = { args: normalizedArgs, cleanup: () => {}, prepared: false };
try {
  if (shouldUseFullCheckoutForCleanRemoteSync(normalizedArgs, provider)) {
    const runWords = runCommandArgs(normalizedArgs);
    const changedGateBase = isChangedGateCommand(runWords) ? mergeBaseForChangedGate() : "";
    const checkout = prepareFullCheckoutForSync({ changedGateBase });
    fullCheckout = checkout;
    normalizedArgs = injectFullCheckoutLeaseReclaim(normalizedArgs);
    childCwd = checkout.dir;
    cleanupChildCwd = () => checkout.cleanup();
    remoteChangedGateBase = checkout.changedGateBase;
    console.error(
      `[crabbox] sparse clean checkout detected; syncing from temporary full checkout ${checkout.dir}`,
    );
    if (checkout.changedGateBase) {
      console.error(
        `[crabbox] remote changed gate detected; overlaying local HEAD as worktree changes from ${checkout.changedGateBase}`,
      );
    }
  }
} catch (error) {
  scriptBootstrap.cleanup();
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
  preserveTemporaryCrabboxRuns();
  cleanupChildCwd();
}

const runtimeEntrypoint = commandRuntimeEntrypoint(runCommandArgs(normalizedArgs));
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
  const wsl2Requirements = remoteWsl2JsBootstrapRequirements(normalizedArgs);
  if (wsl2Requirements.runtimeEntrypoint || wsl2Requirements.packageManager) {
    console.error(
      `[crabbox] provider=${provider} WSL2 raw boxes may lack Node/Corepack/pnpm for ${wsl2Requirements.runtimeEntrypoint || "package-manager"}; using no-hydrate pinned user-local JavaScript tooling before the command`,
    );
  }
}

const childEnv = { ...process.env };
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

const remoteMarkedArgs = injectRemoteChangedGateEnvironment(normalizedArgs);
const remoteMarkedNeedsAwsMacosSwift =
  isAwsMacosRemoteTarget(remoteMarkedArgs, provider) &&
  commandNeedsAwsMacosSwiftToolchain(runCommandArgs(remoteMarkedArgs));
try {
  wsl2ScriptBootstrap = prepareRemoteWsl2JsBootstrapScript(
    childCwd === repoRoot ? remoteMarkedArgs : absolutizeLocalRunPaths(remoteMarkedArgs),
    provider,
  );
} catch (error) {
  cleanupOnce();
  throw error;
}
const childArgs = injectRemoteTestboxCi(
  childCwd === repoRoot
    ? injectRemoteWindowsHydratedNodeModulesBootstrap(
        injectRemoteAwsMacosSwiftBootstrap(
          injectRemoteAwsMacosJsBootstrap(wsl2ScriptBootstrap.args, provider),
          provider,
          remoteMarkedNeedsAwsMacosSwift,
        ),
        provider,
      )
    : injectRemoteChangedGateGitBootstrap(
        injectRemoteWindowsHydratedNodeModulesBootstrap(
          injectRemoteAwsMacosSwiftBootstrap(
            injectRemoteAwsMacosJsBootstrap(wsl2ScriptBootstrap.args, provider),
            provider,
            remoteMarkedNeedsAwsMacosSwift,
          ),
          provider,
        ),
        remoteChangedGateBase,
      ),
  provider,
);
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
// Fast-fail hint context: run --id reuse dies in under a second when the
// lease hit its idle timeout, with only a bare nonzero exit from the binary.
const reusedRunLeaseId = normalizedArgs[0] === "run" ? optionValue(normalizedArgs, "--id") : "";
const childStartedAtMs = Date.now();
const FAST_FAIL_HINT_WINDOW_MS = 15_000;
const child = spawn(childInvocation.command, childInvocation.args, {
  cwd: childCwd,
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: childEnv,
  windowsVerbatimArguments: childInvocation.windowsVerbatimArguments,
});
const childKillGraceMs = resolveChildKillGraceMs(process.env);
let childForceKillTimer;
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

const signalExitCodes = new Map([
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

async function exitAfterChildTreeTermination(childProcess, signal, exitCode) {
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

function signalChildProcessTree(childProcess, signal) {
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
    if (error?.code !== "ESRCH") {
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

function childProcessTreeIsAlive(childProcess) {
  if (process.platform === "win32" || typeof childProcess.pid !== "number") {
    return childProcess.exitCode === null && childProcess.signalCode === null;
  }
  try {
    process.kill(-childProcess.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForChildTreeExit(childProcess, timeoutMs) {
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

function resolveChildKillGraceMs(env) {
  if (!env.VITEST || !env.OPENCLAW_TEST_CRABBOX_CHILD_KILL_GRACE_MS) {
    return 5_000;
  }
  const value = Number.parseInt(env.OPENCLAW_TEST_CRABBOX_CHILD_KILL_GRACE_MS, 10);
  return Number.isFinite(value) && value >= 0 ? value : 5_000;
}

function resolveMetadataProbeTimeoutMs(env) {
  if (!env.VITEST || !env.OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS) {
    return CRABBOX_METADATA_PROBE_TIMEOUT_MS;
  }
  const value = Number.parseInt(env.OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : CRABBOX_METADATA_PROBE_TIMEOUT_MS;
}
