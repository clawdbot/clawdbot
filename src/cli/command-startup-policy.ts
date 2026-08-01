// Startup policy helpers for config guards, plugin loading, banners, and CLI path checks.
import { isTruthyEnvValue } from "../infra/env.js";
import type { CliCommandPluginLoadPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}

function shouldLoadPlugins(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
  loadPlugins: CliCommandPluginLoadPolicy;
}): boolean {
  // Some commands need plugin text/help in human output but not in JSON mode.
  const loadPlugins = params.loadPlugins;
  if (typeof loadPlugins === "function") {
    return loadPlugins({
      argv: params.argv ?? [],
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    });
  }
  return loadPlugins === "always" || (loadPlugins === "text-only" && !params.jsonOutputMode);
}

export function resolveCliStartupPolicy(params: {
  argv?: string[];
  commandPath: string[];
  protocolCommandPath?: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const commandPolicy = resolveCliCommandPathPolicy(params.commandPath);
  // Commander resolves required option values before selecting the action command, so this path
  // remains authoritative when a protocol option value itself begins with "-".
  const ownsProtocolStdout = params.protocolCommandPath
    ? resolveCliCommandPathPolicy(params.protocolCommandPath).ownsProtocolStdout
    : commandPolicy.ownsProtocolStdout;
  // Protocol commands own stdout from process startup, before their action installs later routing.
  const suppressDoctorStdout = params.jsonOutputMode || ownsProtocolStdout;
  const env = params.env ?? process.env;
  return {
    suppressDoctorStdout,
    hideBanner: isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) || commandPolicy.hideBanner,
    skipConfigGuard: params.routeMode
      ? commandPolicy.routeConfigGuard === "always" ||
        (commandPolicy.routeConfigGuard === "when-suppressed" && suppressDoctorStdout)
      : false,
    loadPlugins: shouldLoadPlugins({
      argv: params.argv,
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
      loadPlugins: commandPolicy.loadPlugins,
    }),
    pluginRegistry: commandPolicy.pluginRegistry,
  };
}
