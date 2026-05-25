#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoLocal = resolveCrabboxBinary(process.env, process.platform);
const pathLocal = resolvePathBinary("crabbox", process.env, process.platform);
const binary =
  repoLocal ?? pathLocal ?? resolveGitCommonCrabboxBinary(process.env, process.platform) ?? "crabbox";
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
  const words = normalizedCommandWords(commandArgs);
  const first = (words[0] ?? "").split("/").pop();
  return ["pnpm", "npm", "npx", "corepack", "node", "yarn", "bun"].includes(first) ? first : "";
}

function isChangedGateCommand(commandArgs) {
  const words = normalizedCommandWords(commandArgs);
  if (words[0] === "corepack") {
    words.shift();
  }
  return (
    (words[0] === "pnpm" && words[1] === "check:changed") ||
    (words[0] === "pnpm" && words[1] === "run" && words[2] === "check:changed") ||
    (words[0] === "node" && (words[1] ?? "").endsWith("scripts/check-changed.mjs"))
  );
}

function headInRemoteRefs() {
  const refs = gitOutput([
    "for-each-ref",
    "--contains",
    "HEAD",
    "--format=%(refname)",
    "refs/remotes",
  ]);
  return refs.status === 0 && refs.stdout !== "";
}

function mergeBaseForChangedGate() {
  const base = gitOutput(["merge-base", "origin/main", "HEAD"]);
  return base.status === 0 && base.stdout ? base.stdout : "origin/main";
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
  if (
    hasOption(commandArgs, "--no-sync") ||
    hasOption(commandArgs, "--id")
  ) {
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
const normalizedArgs = ensureAwsMacOnDemandMarket(args, provider);

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
if (shouldUseFullCheckoutForCleanSparseRemoteSync(normalizedArgs, provider)) {
  const runWords = runCommandArgs(normalizedArgs);
  const changedGateBase =
    isChangedGateCommand(runWords) && !headInRemoteRefs() ? mergeBaseForChangedGate() : "";
  const checkout = prepareFullCheckoutForSync({ changedGateBase });
  childCwd = checkout.dir;
  cleanupChildCwd = () => checkout.cleanup();
  console.error(
    `[crabbox] sparse clean checkout detected; syncing from temporary full checkout ${checkout.dir}`,
  );
  if (checkout.changedGateBase) {
    console.error(
      `[crabbox] remote changed gate detected; overlaying local HEAD as worktree changes from ${checkout.changedGateBase}`,
    );
  }
}

function cleanupOnce() {
  if (cleanupDone) {
    return;
  }
  cleanupDone = true;
  cleanupChildCwd();
}

const runtimeEntrypoint = commandRuntimeEntrypoint(runCommandArgs(normalizedArgs));
if (normalizedArgs[0] === "run" && provider === "aws" && runtimeEntrypoint) {
  const id = optionValue(normalizedArgs, "--id");
  const hydrate = id
    ? `pnpm crabbox:hydrate -- --id ${id}`
    : "pnpm crabbox:warmup, then pnpm crabbox:hydrate -- --id <id>";
  console.error(
    `[crabbox] warning: provider=aws raw boxes may lack Node/Corepack/pnpm for ${runtimeEntrypoint}; hydrate first (${hydrate}) or pass --provider blacksmith-testbox for OpenClaw CI-like proof; not switching providers automatically`,
  );
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

const childArgs = childCwd === repoRoot ? normalizedArgs : absolutizeLocalRunPaths(normalizedArgs);
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
