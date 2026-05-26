import {
  createSshSandboxSessionFromConfigText,
  runPluginCommandWithTimeout,
  shellEscape,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedOpenShellPluginConfig } from "./config.js";

export {
  buildExecRemoteCommand,
  buildValidatedExecRemoteCommand,
  shellEscape,
} from "openclaw/plugin-sdk/sandbox";

export type OpenShellExecContext = {
  config: ResolvedOpenShellPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

export function resolveOpenShellCommand(command: string): string {
  return command;
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

export function applyGatewayEndpointToSshConfig(params: {
  configText: string;
  gatewayEndpoint?: string;
}): string {
  const endpoint = params.gatewayEndpoint?.trim();
  if (!endpoint) {
    return params.configText;
  }
  return params.configText.replace(/^(\s*ProxyCommand\s+)(.*)$/m, (line, prefix, command) => {
    if (!command.includes("ssh-proxy")) {
      return line;
    }
    if (/(^|\s)--server(\s|=)|(^|\s)--gateway-endpoint(\s|=)/.test(command)) {
      return line;
    }
    return `${prefix}${command} --server ${shellEscape(endpoint)}`;
  });
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
    configText: applyGatewayEndpointToSshConfig({
      configText: result.stdout,
      gatewayEndpoint: params.context.config.gatewayEndpoint,
    }),
  });
}
