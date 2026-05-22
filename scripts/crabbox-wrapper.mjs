#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoLocal = resolve(repoRoot, "../crabbox/bin/crabbox");
const binary = existsSync(repoLocal) ? repoLocal : "crabbox";
const args = process.argv.slice(2);

if (args[0] === "--") {
  args.shift();
}
const userArgStart = args[0] === "actions" && args[1] === "hydrate" ? 2 : 1;
if (args[userArgStart] === "--") {
  args.splice(userArgStart, 1);
}

function checkedOutput(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
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

function isLocalContainerProvider(providerName) {
  return ["local-container", "docker", "container", "local-docker"].includes(providerName);
}

function runCommandArgs(commandArgs) {
  const { start } = runCommandBounds(commandArgs);
  return start >= 0 ? commandArgs.slice(start) : [];
}

function commandRuntimeEntrypoint(commandArgs) {
  const words = commandArgs.length === 1 ? commandArgs[0].split(/\s+/u) : commandArgs;
  while (words[0] === "env") {
    words.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
      words.shift();
    }
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
    words.shift();
  }
  const first = (words[0] ?? "")
    .replace(/^['"]|['";|&()]+$/g, "")
    .split("/")
    .pop();
  return ["pnpm", "npm", "npx", "corepack", "node", "yarn", "bun"].includes(first) ? first : "";
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

const runtimeEntrypoint = commandRuntimeEntrypoint(runCommandArgs(args));
if (args[0] === "run" && provider === "aws" && runtimeEntrypoint) {
  const id = optionValue(args, "--id");
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
  !hasOption(args, "--local-container-docker-socket")
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
  !hasOption(args, "--local-container-work-root")
) {
  childEnv.CRABBOX_LOCAL_CONTAINER_WORK_ROOT = "/tmp/openclaw-crabbox-docker-work";
  console.error(
    "[crabbox] provider=docker using short host-visible work root for OpenClaw Docker tests",
  );
}

const child = spawn(binary, args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`[crabbox] failed to execute ${displayBinary}: ${error.message}`);
  process.exit(2);
});
