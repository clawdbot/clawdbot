// Startup policy helpers for config guards, plugin loading, banners, and CLI path checks.
import { isTruthyEnvValue } from "../infra/env.js";
import type { CliCommandPluginLoadPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

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
  jsonOutputMode: boolean;
  machineOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const commandPolicy = resolveCliCommandPathPolicy(params.commandPath);
  const machineOutputMode = params.jsonOutputMode || params.machineOutputMode === true;
  // Protocol commands own stdout from process startup, before their action installs later routing.
  const suppressDoctorStdout = machineOutputMode || commandPolicy.ownsProtocolStdout;
  const configGuard =
    typeof commandPolicy.configGuard === "function"
      ? commandPolicy.configGuard({ argv: params.argv ?? [], commandPath: params.commandPath })
      : commandPolicy.configGuard;
  const env = params.env ?? process.env;
  const hideBanner = machineOutputMode || commandPolicy.hideBanner;
  return {
    suppressDoctorStdout,
    hideBanner: hideBanner || isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER),
    skipConfigGuard:
      configGuard === "skip" || (configGuard === "when-suppressed" && suppressDoctorStdout),
    ...(configGuard === "validate" ? { validateConfigOnly: true } : {}),
    loadPlugins: shouldLoadPlugins({
      argv: params.argv,
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
      loadPlugins: commandPolicy.loadPlugins,
    }),
    pluginRegistry: commandPolicy.pluginRegistry,
  };
}
