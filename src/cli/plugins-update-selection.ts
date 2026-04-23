import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  extractInstalledNpmHookPackageName,
  extractInstalledNpmPackageName,
} from "./plugins-install-records.js";

export function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { pluginIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { pluginIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { pluginIds: [] };
  }

  if (params.rawId in params.installs) {
    return { pluginIds: [params.rawId] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec) {
    return { pluginIds: [params.rawId] };
  }
  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { pluginIds: [params.rawId] };
  }

  const [pluginId] = matches[0];
  if (!pluginId) {
    return { pluginIds: [params.rawId] };
  }
  if (parsedSpec.selectorKind === "none") {
    return {
      pluginIds: [pluginId],
      specOverrides: {
        [pluginId]: parsedSpec.raw,
      },
    };
  }
  return {
    pluginIds: [pluginId],
    specOverrides: {
      [pluginId]: parsedSpec.raw,
    },
  };
}

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
  if (params.rawId in params.installs) {
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

  const [hookId] = matches[0];
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
