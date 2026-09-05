import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

/** Reads registration/request/active ownership without initializing a cold plugin runtime. */
export function getPluginRegistryForContext(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return (
    state?.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    state?.activeRegistry ??
    null
  );
}

/** Exact context identity disambiguates package siblings; a unique root works for host callers. */
export function resolvePluginRuntimeRecord(
  params: { pluginId?: string } & (
    | { pluginRoot: string; modulePath?: never }
    | { modulePath: string; pluginRoot?: never }
  ),
) {
  const root = params.pluginRoot ? getPluginCacheRoot(params.pluginRoot).rootDir : undefined;
  const source = params.modulePath ? path.resolve(params.modulePath) : undefined;
  const owners =
    getPluginRegistryForContext()?.plugins.filter(
      (record) =>
        record.rootDir &&
        (root
          ? getPluginCacheRoot(record.rootDir).rootDir === root
          : isPathInside(record.rootDir, source!) ||
            getPluginInstance(record)?.hasModuleSource(source!) === true),
    ) ?? [];
  const pluginId =
    params.pluginId ??
    getPluginRegistryState()?.registrationContext?.pluginId ??
    getPluginRuntimeGatewayRequestScope()?.pluginId;
  const owner = owners.find((record) => record.id === pluginId);
  if (!owner && (owners.length > 1 || (params.pluginId && owners.length))) {
    throw new Error(
      `Plugin public surface ${root ?? source} has ambiguous runtime ownership; specify its plugin id.`,
    );
  }
  return owner ?? owners[0];
}
