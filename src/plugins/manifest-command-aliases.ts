import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";

export type PluginManifestCommandAliasKind = "runtime-slash";

export type PluginManifestCommandAlias = {
  /** Command-like name users may put in plugin config by mistake. */
  name: string;
  /** Command family, used for targeted diagnostics. */
  kind?: PluginManifestCommandAliasKind;
  /** Optional root CLI command that handles related CLI operations. */
  cliCommand?: string;
};

export type PluginManifestCommandAliasRecord = PluginManifestCommandAlias & {
  pluginId: string;
  enabledByDefault?: boolean;
};

export type PluginManifestToolOwnerRecord = {
  toolName: string;
  pluginId: string;
  /**
   * "loaded" — the owning plugin passes control-plane availability filters and
   * the tool itself passes manifest-tool-availability checks (configSignals/
   * authSignals). The diagnostic can say the tool is available from this plugin.
   *
   * "manifest-only" — the manifest claims ownership but availability checks
   * either failed (plugin denied/disabled, missing required config) or were
   * not performed (pure registry lookup with no plugin metadata snapshot).
   * Emit a softer "may be provided by" message in that case so the diagnostic
   * does not over-assert about plugins that the runtime never registered.
   */
  availability?: "loaded" | "manifest-only";
};

export type PluginManifestCommandAliasRegistry = {
  plugins: readonly {
    id: string;
    enabledByDefault?: boolean;
    commandAliases?: readonly PluginManifestCommandAlias[];
    contracts?: { tools?: readonly string[] };
  }[];
};

export function normalizeManifestCommandAliases(
  value: unknown,
): PluginManifestCommandAlias[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: PluginManifestCommandAlias[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = normalizeOptionalString(entry) ?? "";
      if (name) {
        normalized.push({ name });
      }
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const name = normalizeOptionalString(entry.name) ?? "";
    if (!name) {
      continue;
    }
    const kind = entry.kind === "runtime-slash" ? entry.kind : undefined;
    const cliCommand = normalizeOptionalString(entry.cliCommand) ?? "";
    normalized.push({
      name,
      ...(kind ? { kind } : {}),
      ...(cliCommand ? { cliCommand } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveManifestToolOwnerInRegistry(params: {
  toolName: string | undefined;
  registry: PluginManifestCommandAliasRegistry;
}): PluginManifestToolOwnerRecord | undefined {
  const normalizedToolName = normalizeOptionalLowercaseString(params.toolName);
  if (!normalizedToolName) {
    return undefined;
  }
  for (const plugin of params.registry.plugins) {
    const tools = plugin.contracts?.tools;
    if (!tools || tools.length === 0) {
      continue;
    }
    const match = tools.find(
      (entry) => normalizeOptionalLowercaseString(entry) === normalizedToolName,
    );
    if (match) {
      return { toolName: match, pluginId: plugin.id };
    }
  }
  return undefined;
}

export function resolveManifestCommandAliasOwnerInRegistry(params: {
  command: string | undefined;
  registry: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const normalizedCommand = normalizeOptionalLowercaseString(params.command);
  if (!normalizedCommand) {
    return undefined;
  }

  const commandIsPluginId = params.registry.plugins.some(
    (plugin) => normalizeOptionalLowercaseString(plugin.id) === normalizedCommand,
  );

  for (const plugin of params.registry.plugins) {
    const alias = plugin.commandAliases?.find(
      (entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand,
    );
    if (alias) {
      if (commandIsPluginId && normalizeOptionalLowercaseString(plugin.id) !== normalizedCommand) {
        continue;
      }
      return {
        ...alias,
        pluginId: plugin.id,
        ...(plugin.enabledByDefault === true ? { enabledByDefault: true } : {}),
      };
    }
  }
  return undefined;
}
