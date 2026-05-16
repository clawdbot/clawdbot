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
  try {
    const config = readFileSync(resolve(repoRoot, ".crabbox.yaml"), "utf8");
    const match = config.match(/^provider:\s*([^\s#]+)/m);
    return match?.[1] ?? "aws";
  } catch {
    return "aws";
  }
}

function selectedProvider(commandArgs) {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--provider") {
      return commandArgs[index + 1] ?? "";
    }
    if (arg.startsWith("--provider=")) {
      return arg.slice("--provider=".length);
    }
  }
  return configuredProvider();
}

const version = checkedOutput(binary, ["--version"]);
const help = checkedOutput(binary, ["run", "--help"]);
const knownProviders = [
  "hetzner",
  "aws",
  "azure",
  "gcp",
  "proxmox",
  "ssh",
  "blacksmith-testbox",
  "namespace-devbox",
  "semaphore",
  "daytona",
  "islo",
  "e2b",
  "modal",
  "sprites",
  "cloudflare",
];
const providers = knownProviders.filter((provider) =>
  new RegExp(`\\b${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
    help.text,
  ),
);
const displayBinary = binary === "crabbox" ? "crabbox" : relative(repoRoot, binary);
const provider = selectedProvider(args);

console.error(
  `[crabbox] bin=${displayBinary} version=${version.text || "unknown"} provider=${provider || "unknown"} providers=${providers.join(",") || "unknown"}`,
);

if (version.status !== 0 || help.status !== 0) {
  console.error("[crabbox] selected binary failed basic --version/--help sanity checks");
  process.exit(2);
}

if (provider && knownProviders.includes(provider) && !providers.includes(provider)) {
  console.error(
    `[crabbox] selected binary does not advertise provider ${provider}; update Crabbox or choose a supported provider`,
  );
  process.exit(2);
}

if (provider === "blacksmith-testbox") {
  console.error(
    "[crabbox] provider=blacksmith-testbox explicit; if Testbox is queued or down, rerun without --provider to use .crabbox.yaml",
  );
}

const child = spawn(binary, args, {
  cwd: repoRoot,
  stdio: "inherit",
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
