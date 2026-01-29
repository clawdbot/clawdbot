import { defaultRuntime } from "../runtime.js";
import { ensurePluginRegistryLoaded } from "./plugin-registry.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { emitCliBanner } from "./banner.js";
import { VERSION } from "../version.js";
import { getCommandPath, hasHelpOrVersion } from "./argv.js";
import { ensureConfigReady } from "./program/config-guard.js";
import { findRoutedCommand } from "./program/command-registry.js";

async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean;
}) {
  emitCliBanner(VERSION, { argv: params.argv });
  await ensureConfigReady({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    rawArgs: params.argv,
  });
  if (params.loadPlugins) {
    ensurePluginRegistryLoaded();
  }
}

export async function tryRouteCli(argv: string[]): Promise<boolean> {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_ROUTE_FIRST)) return false;
  if (hasHelpOrVersion(argv)) return false;

  const path = getCommandPath(argv, 2);
  if (!path[0]) return false;
  const route = findRoutedCommand(path);
  if (!route) return false;
  await prepareRoutedCommand({ argv, commandPath: path, loadPlugins: route.loadPlugins });
  return route.run(argv);
}
