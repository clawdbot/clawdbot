import { projectPluginHttpRoutes } from "./http-route-owner.js";
import { pluginArrays, pluginMaps } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

function projectArray<T>(source: T[], target: T[] | undefined, owns: (entry: T) => boolean): void {
  if (target) {
    target.push(...source.filter(owns));
  } else {
    for (let index = source.length - 1; index >= 0; index--) {
      if (owns(source[index]!)) {
        source.splice(index, 1);
      }
    }
  }
}

function projectMap<K, V>(
  source: Map<K, V>,
  target: Map<K, V> | undefined,
  owns: (entry: V, key: K) => boolean,
): void {
  for (const [key, entry] of source) {
    if (!owns(entry, key)) {
      continue;
    }
    if (target) {
      target.set(key, entry);
    } else {
      source.delete(key);
    }
  }
}

/** Copy exact owned contributions into a candidate, or remove them during failed registration. */
export function projectPluginContributions(
  source: PluginRegistry,
  record: PluginRecord,
  target?: PluginRegistry,
): void {
  const pluginId = record.id;
  projectPluginHttpRoutes(source, record, target);
  const owns = (entry: { pluginId?: string }) => entry.pluginId === pluginId;
  for (const key of pluginArrays) {
    projectArray<{ pluginId?: string }>(source[key], target?.[key], owns);
  }
  for (const key of pluginMaps) {
    projectMap<string, { pluginId: string }>(source[key], target?.[key], owns);
  }
  projectArray(
    source.compactionProviders,
    target?.compactionProviders,
    (entry) => entry.ownerPluginId === pluginId,
  );
  projectMap(
    source.contextEngines,
    target?.contextEngines,
    (entry) => entry.owner === `plugin:${pluginId}`,
  );
  projectMap(
    source.pluginRuntimeArtifacts,
    target?.pluginRuntimeArtifacts,
    // SAFETY: Runtime artifact keys are host-created JSON tuples with the owning plugin id first.
    (_entry, key) => (JSON.parse(key) as unknown[])[0] === pluginId,
  );
  const ownsMethod = (entry: PluginRegistry["gatewayMethodDescriptors"][number]) =>
    entry.owner.kind === "plugin" && entry.owner.pluginId === pluginId;
  for (const entry of source.gatewayMethodDescriptors.filter(ownsMethod)) {
    if (target) {
      target.gatewayHandlers[entry.name] = source.gatewayHandlers[entry.name]!;
    } else {
      delete source.gatewayHandlers[entry.name];
    }
  }
  projectArray(source.gatewayMethodDescriptors, target?.gatewayMethodDescriptors, ownsMethod);
}
