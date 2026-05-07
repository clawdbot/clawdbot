import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";

export type CommandResult = {
  stderr: string;
  stdout: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<CommandResult>;

export type CrabboxInspect = {
  host?: string;
  id?: string;
  provider?: string;
  ready?: boolean;
  slug?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.stdio === "inherit") {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.stdio === "inherit") {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

export async function resolveCrabboxBin(params: {
  env: NodeJS.ProcessEnv;
  envName: string;
  explicit?: string;
  repoRoot: string;
}) {
  const configured = trimToValue(params.explicit) ?? trimToValue(params.env[params.envName]);
  if (configured) {
    return configured;
  }
  const sibling = path.resolve(params.repoRoot, "../crabbox/bin/crabbox");
  if (await pathExists(sibling)) {
    return sibling;
  }
  return "crabbox";
}

export function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runCommand(params: {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  stdio?: "inherit" | "pipe";
}) {
  return params.runner(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: params.stdio ?? "pipe",
  });
}

export async function warmupCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  idleTimeout: string;
  machineClass: string;
  provider: string;
  runner: CommandRunner;
  ttl: string;
}) {
  const result = await runCommand({
    command: params.crabboxBin,
    args: [
      "warmup",
      "--provider",
      params.provider,
      "--desktop",
      "--browser",
      "--class",
      params.machineClass,
      "--idle-timeout",
      params.idleTimeout,
      "--ttl",
      params.ttl,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
    stdio: "inherit",
  });
  const leaseId = extractLeaseId(`${result.stdout}\n${result.stderr}`);
  if (!leaseId) {
    throw new Error("Crabbox warmup did not print a lease id.");
  }
  return leaseId;
}

export async function inspectCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseId: string;
  provider: string;
  runner: CommandRunner;
}) {
  const result = await runCommand({
    command: params.crabboxBin,
    args: ["inspect", "--provider", params.provider, "--id", params.leaseId, "--json"],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  });
  return JSON.parse(result.stdout) as CrabboxInspect;
}

export async function stopCrabbox(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseId: string;
  provider: string;
  runner: CommandRunner;
}) {
  await runCommand({
    command: params.crabboxBin,
    args: ["stop", "--provider", params.provider, params.leaseId],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
    stdio: "inherit",
  });
}

export function sshCommand(params: { inspect: CrabboxInspect }) {
  const { host, sshKey, sshPort, sshUser } = params.inspect;
  if (!host || !sshKey || !sshUser) {
    throw new Error("Crabbox inspect output is missing SSH copy details.");
  }
  return {
    host,
    sshArgs: [
      "ssh",
      "-i",
      shellQuote(sshKey),
      "-p",
      sshPort ?? "22",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
    ].join(" "),
    sshUser,
  };
}
