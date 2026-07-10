/**
 * Plugin node-host command registry bridge.
 *
 * Node hosts load the active plugin registry, expose registered capabilities
 * and commands, and dispatch incoming node-host commands by exact command id.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommandAvailabilityContext } from "../plugins/types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadPluginRegistryLoaderModule = createLazyRuntimeModule(
  () => import("../plugins/runtime/runtime-registry-loader.js"),
);

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  (await loadPluginRegistryLoaderModule()).ensurePluginRegistryLoaded({
    scope: "all",
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
  });
}

/** List registered node-host capabilities and command ids in deterministic order. */
export function listRegisteredNodeHostCapsAndCommands(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
): {
  caps: string[];
  commands: string[];
} {
  const registry = getActivePluginRegistry();
  const caps = new Set<string>();
  const commands = new Set<string>();
  for (const entry of registry?.nodeHostCommands ?? []) {
    // Availability belongs to the node-local plugin. Gateway policy still keeps
    // the command registered so a differently configured remote node can expose it.
    if (entry.command.isAvailable?.(context) === false) {
      continue;
    }
    if (entry.command.cap) {
      caps.add(entry.command.cap);
    }
    commands.add(entry.command.command);
  }
  return {
    caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
    commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
  };
}

/** Invoke a registered node-host plugin command, or return null for unknown commands. */
export async function invokeRegisteredNodeHostCommand(
  command: string,
  paramsJSON?: string | null,
): Promise<string | null> {
  const registry = getActivePluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  return await match.command.handle(paramsJSON);
}
