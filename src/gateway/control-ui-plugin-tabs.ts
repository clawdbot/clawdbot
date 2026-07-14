// Projects plugin "tab" Control UI descriptors into the hello payload so the
// dashboard renders plugin tabs without hardcoding plugin ids in core.
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";

type ControlUiPluginTab = {
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  icon?: string;
  path?: string;
  group?: "control" | "agent";
  order?: number;
};

type ControlUiDescriptorEntry = {
  pluginId: string;
  descriptor: PluginControlUiDescriptor;
};

/** Pure projection of tab descriptors visible to the presented scopes. */
function projectControlUiPluginTabs(
  entries: readonly ControlUiDescriptorEntry[],
  scopes: readonly string[],
): ControlUiPluginTab[] {
  const tabs: ControlUiPluginTab[] = [];
  for (const entry of entries) {
    const descriptor = entry.descriptor;
    if (descriptor.surface !== "tab") {
      continue;
    }
    const visible = (descriptor.requiredScopes ?? []).every(
      (scope) => authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
    );
    if (!visible) {
      continue;
    }
    tabs.push({
      pluginId: entry.pluginId,
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      icon: descriptor.icon,
      path: descriptor.path,
      group: descriptor.group,
      order: descriptor.order,
    });
  }
  // Deterministic ordering keeps hello payloads stable across connects.
  return tabs.toSorted(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
}

/** Lists active plugins' tab descriptors visible to the presented scopes. */
export function listControlUiPluginTabs(scopes: readonly string[]): ControlUiPluginTab[] {
  const registry = getActivePluginRegistry();
  return projectControlUiPluginTabs(registry?.controlUiDescriptors ?? [], scopes);
}
