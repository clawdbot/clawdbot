#!/usr/bin/env node
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    return {
      command: env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildBatchCommandLine(command, commandArgs)],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: commandArgs };
}

const cmdMetaCharactersRe = /([()\][%!^"`<>&|;, *?])/g;
const jsRuntimeEntrypoints = new Set(["pnpm", "npm", "npx", "corepack", "node", "yarn", "bun"]);
const awsMacosCorepackEntrypoints = new Set(["pnpm", "yarn", "corepack"]);
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
const shellInlineCommandOptionsWithNextValue = new Set([
  "+O",
  "+o",
  "-O",
  "-o",
  "--init-file",
  "--rcfile",
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

function checkedOutput(command, commandArgs) {
  const invocation = spawnInvocation(command, commandArgs, process.env, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return {
    status: result.status ?? 1,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    stdout: (result.stdout ?? "").trim(),
  };
}

function parseCrabboxVersion(value) {
  const match = `${value}`.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:-([^\s+]+))?(?:\+[^\s]+)?\b/u);
  if (!match) {
    return null;
  }
  return {
    tuple: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    suffix: match[4] ?? "",
  };
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
  const invocation = spawnInvocation(gitBinary, commandArgs, process.env, process.platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
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
  const envProvider = process.env.CRABBOX_PROVIDER?.trim();
  if (envProvider) {
    return envProvider;
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
  const delimiter = commandArgs.indexOf("--");
  return delimiter >= 0 ? commandArgs.slice(0, delimiter) : commandArgs;
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
  const canonicalProvider = providerAliases.get(providerName) ?? providerName;
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
  return Boolean(parsed?.coordinator && parsed?.brokerAuth === "configured");
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
  const delimiter = commandArgs.indexOf("--");
  return delimiter >= 0 ? delimiter : commandArgs.length;
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

function commandNeedsAwsMacosPackageManager(commandArgs) {
  if (isChangedGateCommand(commandArgs)) {
    return true;
  }
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some(commandWordsNeedAwsMacosPackageManager);
  }
  return commandWordsNeedAwsMacosPackageManager(normalizedCommandWords(commandArgs));
}

function commandWordsNeedAwsMacosPackageManager(wordsInput) {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  const first = (words[0] ?? "").split("/").pop();
  if (awsMacosCorepackEntrypoints.has(first)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  if (!inlineCommand) {
    return false;
  }
  return shellCommandWordCandidates(inlineCommand).some(commandWordsNeedAwsMacosPackageManager);
}

function isChangedGateCommand(commandArgs) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some(isChangedGateCommandWords);
  }
  const words = normalizedCommandWords(commandArgs);
  return isChangedGateCommandWords(words);
}

function isChangedGateCommandWords(wordsInput) {
  let words = wordsInput;
  words = normalizeExecutableWords(words);
  if (isChangedGateWords(words)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  return inlineCommand
    ? shellCommandWordCandidates(inlineCommand).some(isChangedGateCommandWords)
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
    (words[0] === "node" && (words[1] ?? "").endsWith("scripts/check-changed.mjs"))
  );
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

function normalizeExecutableWords(words) {
  return normalizedCommandWords(stripShellExecutionPrefixes(words));
}

function stripShellExecutionPrefixes(wordsInput) {
  let words = wordsInput;
  words = [...words];
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
      if (!stripEnvCommandOptions(words, { canShimIgnoreEnvironment: false })) {
        return words;
      }
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
      if (!canShimIgnoreEnvironment || envCommand.includes("/")) {
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
        if (!canShimIgnoreEnvironment || envCommand.includes("/")) {
          words.splice(0, words.length, ...originalWords);
          return false;
        }
        ignoresEnvironment = true;
      }
      words.shift();
      continue;
    }
    if (ignoresEnvironment && (!canShimIgnoreEnvironment || envCommand.includes("/"))) {
      words.splice(0, words.length, ...originalWords);
      return false;
    }
    return true;
  }
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
  let delimiter = "";
  let quote = "";
  let escaped = false;
  let quoted = false;
  let index = startIndex;
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      delimiter += char;
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
        delimiter += char;
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
    delimiter += char;
  }
  return { delimiter, endIndex: Math.max(startIndex, index), quoted };
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
    "if ! git status --short >/dev/null 2>&1; then",
    "rm -rf .git;",
    "git init -q;",
    "git remote add origin https://github.com/openclaw/openclaw.git 2>/dev/null || git remote set-url origin https://github.com/openclaw/openclaw.git;",
    `git fetch -q --depth=1 origin ${quotedBase}:refs/remotes/origin/main;`,
    "git reset --mixed --quiet refs/remotes/origin/main;",
    "git add -A;",
    "if ! git diff --cached --quiet; then git -c user.name=OpenClaw -c user.email=ci@openclaw.local commit -q --no-gpg-sign -m remote-changed-gate-tree; fi;",
    "fi",
  ].join(" ");
}

function isWindowsRemoteTarget(commandArgs) {
  return (
    optionValue(commandArgs, "--target") === "windows" || hasOption(commandArgs, "--windows-mode")
  );
}

function isAwsMacosRemoteTarget(commandArgs, providerName) {
  return (
    commandArgs[0] === "run" &&
    providerName === "aws" &&
    optionValue(commandArgs, "--target") === "macos"
  );
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

function remoteAwsMacosJsBootstrap({ packageManager = false } = {}) {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_MACOS_NODE_VERSION?.trim() || "24.15.0";
  const bootstrap = [
    "openclaw_crabbox_bootstrap_macos_js() {",
    'tool_root="${OPENCLAW_CRABBOX_MACOS_TOOLCHAIN_DIR:-$HOME/.openclaw-crabbox-toolchain}";',
    `node_version=${shellQuote(nodeVersion)};`,
    'arch="$(uname -m)";',
    'case "$arch" in arm64) node_arch=arm64 ;; x86_64) node_arch=x64 ;; *) echo "unsupported macOS arch: $arch" >&2; return 2 ;; esac;',
    'if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR" 2>/dev/null || export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then echo "usable TMPDIR not found: $TMPDIR" >&2; return 1; fi;',
    'node_dir="$tool_root/node-v${node_version}-darwin-${node_arch}";',
    'export PATH="$node_dir/bin:$PATH";',
    'if [ ! -x "$node_dir/bin/node" ]; then',
    'tmp_dir="$(mktemp -d)" || return 1;',
    'pkg="node-v${node_version}-darwin-${node_arch}.tar.gz";',
    'base_url="https://nodejs.org/dist/v${node_version}";',
    'mkdir -p "$tool_root" || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    'curl -fsSLo "$tmp_dir/$pkg" "$base_url/$pkg" || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    'curl -fsSLo "$tmp_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt" || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    '(cd "$tmp_dir" && grep " $pkg$" SHASUMS256.txt | shasum -a 256 -c -) || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$node_dir" || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    'tar -xzf "$tmp_dir/$pkg" -C "$tool_root" || { status=$?; rm -rf "$tmp_dir"; return "$status"; };',
    'rm -rf "$tmp_dir";',
    "fi;",
    "node --version >&2 || return 1;",
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
    'PATH=*) if [ "$openclaw_env_ignore" = "1" ]; then openclaw_env_args+=("PATH=$PATH:${1#PATH=}"); else openclaw_env_args+=("$1"); fi; openclaw_env_path_seen=1; shift ;;',
    '[A-Za-z_]*=*) openclaw_env_args+=("$1"); shift ;;',
    '--) openclaw_env_args+=("--"); shift; break ;;',
    "*) break ;;",
    "esac;",
    "done;",
    'if [ "$openclaw_env_ignore" = "1" ] && [ "$openclaw_env_path_seen" = "0" ]; then openclaw_env_args+=("PATH=$PATH"); fi;',
    'command env "${openclaw_env_args[@]}" "$@";',
    "};",
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
  bootstrap.push("};", "openclaw_crabbox_bootstrap_macos_js");
  return bootstrap.join(" ");
}

function scopedAwsMacosEnvCommand(commandArgs) {
  if (
    commandArgs.length <= 1 ||
    shellWordBasename(commandArgs[0]) !== "env" ||
    commandArgs[0].includes("/")
  ) {
    return null;
  }

  const targetWords = [...commandArgs];
  if (!stripEnvCommandOptions(targetWords, { canShimIgnoreEnvironment: true })) {
    return null;
  }

  const targetEntrypoint = shellWordBasename(targetWords[0]);
  if (
    !jsRuntimeEntrypoints.has(targetEntrypoint) &&
    !awsMacosCorepackEntrypoints.has(targetEntrypoint)
  ) {
    return null;
  }

  return {
    runtimeEntrypoint: targetEntrypoint,
    packageManager: awsMacosCorepackEntrypoints.has(targetEntrypoint),
    shellCommand: `openclaw_crabbox_env ${shellJoin(commandArgs.slice(1))}`,
  };
}

function injectRemoteAwsMacosJsBootstrap(commandArgs, providerName) {
  const runArgs = runCommandArgs(commandArgs);
  const directScopedEnvCommand = hasOption(commandArgs, "--shell")
    ? null
    : scopedAwsMacosEnvCommand(runArgs);
  const runtimeEntrypoint =
    directScopedEnvCommand?.runtimeEntrypoint || commandRuntimeEntrypoint(runArgs);
  if (!isAwsMacosRemoteTarget(commandArgs, providerName) || !runtimeEntrypoint) {
    return commandArgs;
  }

  const { start, optionEnd } = runCommandBounds(commandArgs);
  if (start < 0) {
    return commandArgs;
  }

  const normalizedArgs = [...commandArgs];
  const remoteCommand = normalizedArgs.slice(start);
  const originalShellCommand =
    directScopedEnvCommand?.shellCommand ??
    (hasOption(normalizedArgs, "--shell") && remoteCommand.length === 1
      ? remoteCommand[0]
      : shellJoin(remoteCommand));
  const shellCommand = `${remoteAwsMacosJsBootstrap({
    packageManager:
      directScopedEnvCommand?.packageManager || commandNeedsAwsMacosPackageManager(runArgs),
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
  const packageManager = scriptNeedsAwsMacosPackageManager(script);
  if (!script.startsWith("#!")) {
    return `${remoteAwsMacosJsBootstrap({ packageManager })} || exit $?\n${script}`;
  }
  const delimiter = uniqueHereDocDelimiter(script);
  return [
    `${remoteAwsMacosJsBootstrap({ packageManager })} || exit $?`,
    'tmp_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-crabbox-script.XXXXXX")" || exit $?',
    'cleanup_openclaw_crabbox_script() { rm -f "$tmp_script"; }',
    "trap cleanup_openclaw_crabbox_script EXIT",
    `cat >"$tmp_script" <<'${delimiter}'`,
    script.endsWith("\n") ? script.slice(0, -1) : script,
    delimiter,
    'chmod 700 "$tmp_script" || exit $?',
    '"$tmp_script" "$@"',
    "",
  ].join("\n");
}

function scriptNeedsAwsMacosPackageManager(script) {
  const firstLine = script.match(/^[^\r\n]*/u)?.[0] ?? "";
  if (firstLine.startsWith("#!")) {
    let words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
    if ((words[0] ?? "").split("/").pop() === "env") {
      words = words.slice(1);
      while ((words[0] ?? "").startsWith("-")) {
        words = words.slice(1);
      }
    }
    if (commandWordsNeedAwsMacosPackageManager(words)) {
      return true;
    }
  }
  return commandNeedsAwsMacosPackageManager([script]);
}

function uniqueHereDocDelimiter(script) {
  let index = 0;
  for (;;) {
    const delimiter = `OPENCLAW_CRABBOX_SCRIPT_${index}`;
    if (!new RegExp(`^${delimiter}$`, "mu").test(script)) {
      return delimiter;
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
  return gitOutput(["status", "--porcelain=v1"]).stdout === "";
}

function shouldUseFullCheckoutForCleanSparseRemoteSync(commandArgs, providerName) {
  if (commandArgs[0] !== "run") {
    return false;
  }
  if (hasOption(commandArgs, "--no-sync")) {
    return false;
  }

  return isSparseCheckout() && isWorktreeClean();
}

function prepareFullCheckoutForSync(options = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "openclaw-crabbox-sync-"));
  let active = false;
  const add = gitOutput(["worktree", "add", "--detach", dir, "HEAD"]);
  if (add.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${add.text}`);
  }
  active = true;

  const disableSparse = gitOutput(["-C", dir, "sparse-checkout", "disable"]);
  if (disableSparse.status !== 0) {
    cleanupFullCheckout(dir, active);
    throw new Error(`git sparse-checkout disable failed: ${disableSparse.text}`);
  }

  if (options.changedGateBase) {
    const reset = gitOutput(["-C", dir, "reset", "--mixed", "--quiet", options.changedGateBase]);
    if (reset.status !== 0) {
      cleanupFullCheckout(dir, active);
      throw new Error(`git reset for changed-gate sync failed: ${reset.text}`);
    }
  }

  return {
    dir,
    changedGateBase: options.changedGateBase ?? "",
    cleanup() {
      cleanupFullCheckout(dir, active);
      active = false;
    },
  };
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

const version = checkedOutput(binary, ["--version"]);
const help = checkedOutput(binary, ["run", "--help"]);
const providerAliases = new Map([
  ["blacksmith", "blacksmith-testbox"],
  ["cf", "cloudflare"],
  ["container", "local-container"],
  ["docker", "local-container"],
  ["exe", "exe-dev"],
  ["exedev", "exe-dev"],
  ["google", "gcp"],
  ["google-cloud", "gcp"],
  ["local-docker", "local-container"],
  ["namespace", "namespace-devbox"],
  ["namespace-devboxes", "namespace-devbox"],
  ["rail", "railway"],
  ["railwayapp", "railway"],
  ["run-pod", "runpod"],
  ["runpodio", "runpod"],
  ["sem", "semaphore"],
  ["static", "ssh"],
  ["static-ssh", "ssh"],
  ["tensorlake-sbx", "tensorlake"],
  ["tl", "tensorlake"],
]);
// Crabbox providerHelpAll can omit Tensorlake even when the binary accepts it.
const providerHelpOmissions = new Set(["tensorlake"]);

function addProviderNames(names, text) {
  for (const name of text
    .replace(/\s+\(default\b.*$/u, "")
    .split(/\s*(?:,|\||\bor\b)\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
      names.add(name);
    }
  }
}

function providerListContinuation(line, previousText) {
  const match = line.match(
    /^\s*((?:or\s+)?[a-z0-9][a-z0-9-]*(?:\s*(?:,|\||\bor\b)\s*(?:or\s+)?[a-z0-9][a-z0-9-]*)*\s*(?:,|\|)?)(?:\s+\(default\b.*)?\s*$/u,
  );
  if (!match) {
    return "";
  }
  if (/[,|]\s*$/u.test(previousText) || /[,|]|\bor\b|\(default\b/u.test(line)) {
    return match[1];
  }
  return "";
}

function parseProvidersFromHelp(text) {
  const names = new Set();
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const providerMatch = line.match(/provider:\s*([a-z0-9][a-z0-9, -]*)(?:\s*\(default\b|$)/u);
    if (providerMatch) {
      let providerText = providerMatch[1];
      while (!/\(default\b/u.test(lines[index]) && index + 1 < lines.length) {
        const continuation = providerListContinuation(lines[index + 1], providerText);
        if (!continuation) {
          break;
        }
        index += 1;
        providerText = `${providerText} ${continuation}`;
      }
      addProviderNames(names, providerText);
      continue;
    }

    const flagMatch = line.match(
      /^\s+-{1,2}provider(?:[=\s]+)([a-z0-9][a-z0-9|, -]*)(?:\s{2,}|\s+\(|$)/u,
    );
    if (flagMatch && /[,|]|\bor\b/u.test(flagMatch[1])) {
      addProviderNames(names, flagMatch[1]);
    }
  }
  return [...names];
}

function isProviderAdvertised(provider, advertisedProviders) {
  const canonicalProvider = providerAliases.get(provider) ?? provider;
  return (
    advertisedProviders.includes(provider) ||
    advertisedProviders.includes(canonicalProvider) ||
    providerHelpOmissions.has(canonicalProvider)
  );
}

const providers = parseProvidersFromHelp(help.text);
const displayBinary = binary === "crabbox" ? "crabbox" : relative(repoRoot, binary);
const provider = selectedProvider(args, providers);
const canonicalProvider = providerAliases.get(provider) ?? provider;
const commandProviderValue = commandProvider(args);
let normalizedArgs = ensureAwsMacOnDemandMarket(
  ensureAzureWindowsProvider(args, provider, providers),
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
  const envProvider = process.env.CRABBOX_PROVIDER?.trim();
  const source = commandProviderValue
    ? "explicit"
    : envProvider
      ? "from CRABBOX_PROVIDER"
      : "from config";
  const fallback = commandProviderValue
    ? "rerun without --provider to use .crabbox.yaml"
    : envProvider
      ? "unset CRABBOX_PROVIDER to use .crabbox.yaml"
      : "pass another --provider to override it";
  console.error(
    `[crabbox] provider=blacksmith-testbox ${source}; if Testbox is queued or down, ${fallback}`,
  );
}

let childCwd = repoRoot;
let cleanupChildCwd = () => {};
let cleanupDone = false;
let remoteChangedGateBase = "";
let scriptStdinPrepared = false;
const scriptBootstrap = prepareAwsMacosScriptStdinBootstrap(normalizedArgs, provider);
normalizedArgs = scriptBootstrap.args;
scriptStdinPrepared = scriptBootstrap.prepared;
try {
  if (shouldUseFullCheckoutForCleanSparseRemoteSync(normalizedArgs, provider)) {
    const runWords = runCommandArgs(normalizedArgs);
    const changedGateBase = isChangedGateCommand(runWords) ? mergeBaseForChangedGate() : "";
    const checkout = prepareFullCheckoutForSync({ changedGateBase });
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
      `[crabbox] provider=aws macOS raw boxes may lack Node/Corepack/pnpm for ${runtimeEntrypoint || "--script-stdin"}; bootstrapping a pinned user-local Node toolchain before the command`,
    );
  } else {
    const id = optionValue(normalizedArgs, "--id");
    const hydrate = id
      ? `pnpm crabbox:hydrate -- --id ${id}`
      : "pnpm crabbox:warmup, then pnpm crabbox:hydrate -- --id <id>";
    console.error(
      `[crabbox] warning: provider=aws raw boxes may lack Node/Corepack/pnpm for ${runtimeEntrypoint}; hydrate first (${hydrate}) or pass --provider blacksmith-testbox for OpenClaw CI-like proof; not switching providers automatically`,
    );
  }
}

const childEnv = { ...process.env };
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

const childArgs =
  childCwd === repoRoot
    ? injectRemoteAwsMacosJsBootstrap(normalizedArgs, provider)
    : injectRemoteChangedGateGitBootstrap(
        injectRemoteAwsMacosJsBootstrap(absolutizeLocalRunPaths(normalizedArgs), provider),
        remoteChangedGateBase,
      );
const childInvocation = spawnInvocation(binary, childArgs, childEnv, process.platform);
const child = spawn(childInvocation.command, childInvocation.args, {
  cwd: childCwd,
  stdio: "inherit",
  env: childEnv,
  windowsVerbatimArguments: childInvocation.windowsVerbatimArguments,
});

const signalExitCodes = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
for (const signal of signalExitCodes.keys()) {
  process.once(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
    cleanupOnce();
    process.exit(signalExitCodes.get(signal) ?? 1);
  });
}
process.once("exit", cleanupOnce);

child.on("exit", (code, signal) => {
  cleanupOnce();
  if (signal) {
    process.exit(signalExitCodes.get(signal) ?? 1);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  cleanupOnce();
  console.error(`[crabbox] failed to execute ${displayBinary}: ${error.message}`);
  process.exit(2);
});
