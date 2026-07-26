// Projects plugin "tab" Control UI descriptors into the hello payload so the
// dashboard renders plugin tabs without hardcoding plugin ids in core.
// Read the session-extension registry (gateway-pinned at startup), not the
// mutable active registry: agent-turn standalone loads swap the active registry
// for one without control-UI descriptors, which would empty hello for every
// connection made after the first agent run.
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginSessionExtensionRegistry } from "../plugins/runtime.js";
import { resolveControlUiPluginTabPathname } from "./control-ui-contract.js";
import {
  authorizeOperatorScopesForRequiredScope,
  READ_SCOPE,
  type OperatorScope,
} from "./method-scopes.js";
import { resolvePluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { findMatchingPluginHttpRoutes } from "./server/plugins-http/route-match.js";

type ControlUiPluginTab = {
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  icon?: string;
  path?: string;
  group?: "control" | "agent";
  order?: number;
  requiresGatewayAuth?: boolean;
};

type ControlUiPluginWidgetKind = {
  pluginId: string;
  kind: string;
  label: string;
};

function findControlUiTabGatewayRoute(
  registry: PluginRegistry,
  tab: ControlUiPluginTab,
): ReturnType<typeof findMatchingPluginHttpRoutes>[number] | null | undefined {
  if (!tab.path) {
    return undefined;
  }
  const routePath = resolveControlUiPluginTabPathname(tab.path);
  if (!routePath) {
    return undefined;
  }
  const route = findMatchingPluginHttpRoutes(
    registry,
    resolvePluginRoutePathContext(routePath),
  ).find((candidate) => candidate.auth === "gateway");
  if (!route) {
    return undefined;
  }
  return route.pluginId === tab.pluginId ? route : null;
}

type ControlUiDescriptorEntry = {
  pluginId: string;
  descriptor: PluginControlUiDescriptor;
};

export type ControlUiPluginTabAuthGrant = {
  pluginId: string;
  path: string;
  match: "exact" | "prefix";
  scopes: OperatorScope[];
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
export function listControlUiPluginTabs(
  scopes: readonly string[],
  opts: { requireGatewayAuthGrant?: boolean } = {},
): ControlUiPluginTab[] {
  const registry = getActivePluginSessionExtensionRegistry();
  return projectControlUiPluginTabs(registry?.controlUiDescriptors ?? [], scopes).flatMap((tab) => {
    const route = registry ? findControlUiTabGatewayRoute(registry, tab) : undefined;
    if (route === null) {
      // Dispatch authenticates against its first matching gateway route. Hide
      // a descriptor whose owning plugin cannot receive that request.
      return [];
    }
    return route && opts.requireGatewayAuthGrant !== false
      ? [{ ...tab, requiresGatewayAuth: true }]
      : [tab];
  });
}

/** Lists active plugins' trusted widget kinds visible to the presented scopes. */
export function listControlUiPluginWidgetKinds(
  scopes: readonly string[],
): ControlUiPluginWidgetKind[] {
  const entries = getActivePluginSessionExtensionRegistry()?.controlUiDescriptors ?? [];
  return entries
    .flatMap((entry) => {
      const descriptor = entry.descriptor;
      if (descriptor.surface !== "widget") {
        return [];
      }
      const visible = (descriptor.requiredScopes ?? []).every(
        (scope) => authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
      );
      return visible
        ? [
            {
              pluginId: entry.pluginId,
              kind: `${entry.pluginId}:${descriptor.id}`,
              label: descriptor.label,
            },
          ]
        : [];
    })
    .toSorted(
      (left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind),
    );
}

/** Builds least-privilege grants only for visible tabs backed by same-plugin gateway routes. */
export function listControlUiPluginTabAuthGrants(
  callerScopes: readonly string[],
): ControlUiPluginTabAuthGrant[] {
  const registry = getActivePluginSessionExtensionRegistry();
  if (!registry || !authorizeOperatorScopesForRequiredScope(READ_SCOPE, callerScopes).allowed) {
    return [];
  }
  const grants = new Map<string, ControlUiPluginTabAuthGrant>();
  for (const tab of projectControlUiPluginTabs(registry.controlUiDescriptors ?? [], callerScopes)) {
    if (!tab.path) {
      continue;
    }
    const route = findControlUiTabGatewayRoute(registry, tab);
    if (!route) {
      continue;
    }
    const key = `${tab.pluginId}\n${route.path}`;
    const existing = grants.get(key);
    if (existing) {
      if (existing.match === "exact" && route.match === "prefix") {
        grants.set(key, { ...existing, match: "prefix" });
      }
      continue;
    }
    grants.set(key, {
      pluginId: tab.pluginId,
      path: route.path,
      match: route.match,
      scopes: [READ_SCOPE],
    });
  }
  return [...grants.values()];
}
