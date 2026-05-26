#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  readFileSync,
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
  };
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

function configuredProvider() {
  const envProvider = process.env.CRABBOX_PROVIDER?.trim();
  if (envProvider) {
    return envProvider;
  }
  try {
    const config = readFileSync(resolve(repoRoot, ".crabbox.yaml"), "utf8");
    const match = config.match(/^provider:\s*([^\s#]+)/m);
    return match?.[1] ?? "aws";
  } catch {
    return "aws";
  }
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

function commandProvider(commandArgs) {
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

function selectedProvider(commandArgs) {
  return commandProvider(commandArgs) || configuredProvider();
}

function optionValue(commandArgs, name) {
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

function hasOption(commandArgs, name) {
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
  while (words[0] === "env") {
    words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
      words.shift();
    }
  }
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

function commandWordsRuntimeEntrypoint(words) {
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

function isChangedGateCommand(commandArgs) {
  if (commandArgs.length === 1) {
    return shellCommandWordCandidates(commandArgs[0]).some(isChangedGateCommandWords);
  }
  const words = normalizedCommandWords(commandArgs);
  return isChangedGateCommandWords(words);
}

function isChangedGateCommandWords(words) {
  if (isChangedGateWords(words)) {
    return true;
  }

  const inlineCommand = shellInlineCommand(words);
  return inlineCommand ? shellCommandWordCandidates(inlineCommand).some(isChangedGateCommandWords) : false;
}

function isChangedGateWords(words) {
  words = [...words];
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

function stripShellExecutionPrefixes(words) {
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
    if (first === "time") {
      words.shift();
      stripTimeOptions(words);
      continue;
    }
    return words;
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
    "if ! git rev-parse --git-dir >/dev/null 2>&1; then",
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

function remoteAwsMacosJsBootstrap() {
  const nodeVersion = process.env.OPENCLAW_CRABBOX_MACOS_NODE_VERSION?.trim() || "24.15.0";
  return [
    "openclaw_crabbox_bootstrap_macos_js() {",
    'tool_root="${OPENCLAW_CRABBOX_MACOS_TOOLCHAIN_DIR:-$HOME/.openclaw-crabbox-toolchain}";',
    'pnpm_home="${PNPM_HOME:-$tool_root/pnpm-home}";',
    `node_version=${shellQuote(nodeVersion)};`,
    'arch="$(uname -m)";',
    'case "$arch" in arm64) node_arch=arm64 ;; x86_64) node_arch=x64 ;; *) echo "unsupported macOS arch: $arch" >&2; return 2 ;; esac;',
    'if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR" 2>/dev/null || export TMPDIR="/tmp"; fi;',
    'if [ ! -d "$TMPDIR" ]; then echo "usable TMPDIR not found: $TMPDIR" >&2; return 1; fi;',
    'node_dir="$tool_root/node-v${node_version}-darwin-${node_arch}";',
    'export PATH="$node_dir/bin:$pnpm_home:$PATH";',
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
    'export COREPACK_HOME="${COREPACK_HOME:-$tool_root/corepack}";',
    'export PNPM_HOME="$pnpm_home";',
    'mkdir -p "$COREPACK_HOME" "$PNPM_HOME" || return 1;',
    'export PATH="$PNPM_HOME:$PATH";',
    'corepack enable --install-directory "$PNPM_HOME" || return 1;',
    "node --version >&2;",
    "pnpm --version >&2;",
    "};",
    "openclaw_crabbox_bootstrap_macos_js",
  ].join(" ");
}

function injectRemoteAwsMacosJsBootstrap(commandArgs, providerName) {
  if (
    !isAwsMacosRemoteTarget(commandArgs, providerName) ||
    !commandRuntimeEntrypoint(runCommandArgs(commandArgs))
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
  const shellCommand = `${remoteAwsMacosJsBootstrap()} && { ${originalShellCommand}\n}`;

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
  if (!script.startsWith("#!")) {
    return `${remoteAwsMacosJsBootstrap()} || exit $?\n${script}`;
  }
  const delimiter = uniqueHereDocDelimiter(script);
  return [
    `${remoteAwsMacosJsBootstrap()} || exit $?`,
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
  if (commandArgs[0] !== "run" || isLocalContainerProvider(providerName)) {
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
const provider = selectedProvider(args);
const commandProviderValue = commandProvider(args);
let normalizedArgs = ensureAwsMacOnDemandMarket(args, provider);

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

if (provider === "blacksmith-testbox") {
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
  process.platform !== "win32" &&
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
