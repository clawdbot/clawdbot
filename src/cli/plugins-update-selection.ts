import { expectDefined } from "@openclaw/normalization-core";
// Plugin and hook-pack update selectors for id and npm-spec command inputs.
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  extractInstalledNpmHookPackageName,
  extractInstalledNpmPackageName,
} from "./plugins-install-records.js";

/** Resolve a plugin update target and optional npm spec override from CLI input. */
export function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  installOwnerByPluginId?: ReadonlyMap<string, string>;
  rejectedPluginIds?: ReadonlyMap<string, string>;
  rawId?: string;
  all?: boolean;
}): { pluginIds: string[]; specOverrides?: Record<string, string>; error?: string } {
  if (params.all) {
    const rejectedOwners = Object.keys(params.installs).filter((pluginId) =>
      params.rejectedPluginIds?.has(pluginId),
    );
    if (rejectedOwners.length > 0) {
      return {
        pluginIds: [],
        error: params.rejectedPluginIds?.get(rejectedOwners[0]!),
      };
    }
    return {
      pluginIds: Object.keys(params.installs),
    };
  }
  if (!params.rawId) {
    return { pluginIds: [] };
  }

  if (params.rejectedPluginIds?.has(params.rawId)) {
    return { pluginIds: [], error: params.rejectedPluginIds.get(params.rawId) };
  }
  if (Object.hasOwn(params.installs, params.rawId)) {
    return { pluginIds: [params.rawId] };
  }
  const installOwner = params.installOwnerByPluginId?.get(params.rawId);
  if (installOwner && Object.hasOwn(params.installs, installOwner)) {
    return { pluginIds: [installOwner] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec) {
    return { pluginIds: [] };
  }
  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { pluginIds: [] };
  }

  const [pluginId] = expectDefined(matches[0], "matches capture group 0");
  if (!pluginId) {
    return { pluginIds: [] };
  }
  if (params.rejectedPluginIds?.has(pluginId)) {
    return { pluginIds: [], error: params.rejectedPluginIds.get(pluginId) };
  }
  return {
    pluginIds: [pluginId],
    specOverrides: {
      [pluginId]: parsedSpec.raw,
    },
  };
}

/** Resolve a hook-pack update target and optional npm spec override from CLI input. */
export function resolveHookPackUpdateSelection(params: {
  installs: Record<string, HookInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { hookIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { hookIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { hookIds: [] };
  }
  if (Object.hasOwn(params.installs, params.rawId)) {
    return { hookIds: [params.rawId] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec || parsedSpec.selectorKind === "none") {
    return { hookIds: [] };
  }

  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmHookPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { hookIds: [] };
  }

  const [hookId] = expectDefined(matches[0], "matches capture group 0");
  if (!hookId) {
    return { hookIds: [] };
  }
  return {
    hookIds: [hookId],
    specOverrides: {
      [hookId]: parsedSpec.raw,
    },
  };
}
