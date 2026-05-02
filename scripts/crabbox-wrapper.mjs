#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const version = checkedOutput(binary, ["--version"]);
const help = checkedOutput(binary, ["run", "--help"]);
const providers = ["hetzner", "aws", "blacksmith-testbox"].filter((provider) =>
  help.text.includes(provider),
);
const displayBinary = binary === "crabbox" ? "crabbox" : relative(repoRoot, binary);

console.error(
  `[crabbox] bin=${displayBinary} version=${version.text || "unknown"} providers=${providers.join(",") || "unknown"}`,
);

if (version.status !== 0 || help.status !== 0) {
  console.error("[crabbox] selected binary failed basic --version/--help sanity checks");
  process.exit(2);
}

if (!providers.includes("blacksmith-testbox")) {
  console.error(
    "[crabbox] selected binary does not advertise provider blacksmith-testbox; refusing stale Crabbox binary",
  );
  process.exit(2);
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
