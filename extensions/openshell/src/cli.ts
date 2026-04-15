import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildExecRemoteCommand,
  createSshSandboxSessionFromConfigText,
  runPluginCommandWithTimeout,
  shellEscape,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedOpenShellPluginConfig } from "./config.js";

export { buildExecRemoteCommand, shellEscape } from "openclaw/plugin-sdk/sandbox";

const require = createRequire(import.meta.url);

let cachedBundledOpenShellCommand: string | null | undefined;
let bundledCommandResolverForTest: (() => string | null) | undefined;

export type OpenShellExecContext = {
  config: ResolvedOpenShellPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

export function setBundledOpenShellCommandResolverForTest(resolver?: () => string | null): void {
  bundledCommandResolverForTest = resolver;
  cachedBundledOpenShellCommand = undefined;
}

function resolveBundledOpenShellCommand(): string | null {
  if (bundledCommandResolverForTest) {
    return bundledCommandResolverForTest();
  }
  if (cachedBundledOpenShellCommand !== undefined) {
    return cachedBundledOpenShellCommand;
  }
  try {
    const packageJsonPath = require.resolve("openshell/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.openshell;
    cachedBundledOpenShellCommand = relativeBin
      ? path.resolve(path.dirname(packageJsonPath), relativeBin)
      : null;
  } catch {
    cachedBundledOpenShellCommand = null;
  }
  return cachedBundledOpenShellCommand;
}

export function resolveOpenShellCommand(command: string): string {
  if (command !== "openshell") {
    return command;
  }
  return resolveBundledOpenShellCommand() ?? command;
}

export function buildOpenShellBaseArgv(config: ResolvedOpenShellPluginConfig): string[] {
  const argv = [resolveOpenShellCommand(config.command)];
  if (config.gateway) {
    argv.push("--gateway", config.gateway);
  }
  if (config.gatewayEndpoint) {
    argv.push("--gateway-endpoint", config.gatewayEndpoint);
  }
  return argv;
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

export async function runOpenShellCli(params: {
  context: OpenShellExecContext;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await runPluginCommandWithTimeout({
    argv: [...buildOpenShellBaseArgv(params.context.config), ...params.args],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
    env: process.env,
  });
}

export async function createOpenShellSshSession(params: {
  context: OpenShellExecContext;
}): Promise<SshSandboxSession> {
  const result = await runOpenShellCli({
    context: params.context,
    args: ["sandbox", "ssh-config", params.context.sandboxName],
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "openshell sandbox ssh-config failed");
  }
  return await createSshSandboxSessionFromConfigText({
    configText: result.stdout,
  });
}
