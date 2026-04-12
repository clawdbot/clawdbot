import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "../secrets/path-utils.js";
import type { WizardPrompter } from "./prompts.js";

/**
 * A discovered plugin that has configurable fields via uiHints.
 */
export type ConfigurablePlugin = {
  id: string;
  name: string;
  /** uiHints from the plugin manifest, keyed by config field name. */
  uiHints: Record<string, PluginConfigUiHint>;
  /** JSON schema from the plugin manifest (used for type/enum info). */
  jsonSchema?: Record<string, unknown>;
};

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
  description?: string;
};

function resolveJsonSchemaProperty(
  jsonSchema: Record<string, unknown> | undefined,
  fieldKey: string,
): JsonSchemaProperty | undefined {
  if (!jsonSchema) {
    return undefined;
  }
  let cursor: unknown = jsonSchema;
  for (const segment of fieldKey.split(".")) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    const properties = (cursor as Record<string, unknown>).properties;
    if (!properties || typeof properties !== "object") {
      return undefined;
    }
    cursor = (properties as Record<string, unknown>)[segment];
  }
  return cursor && typeof cursor === "object" ? (cursor as JsonSchemaProperty) : undefined;
}

function getExistingPluginConfig(
  config: OpenClawConfig,
  pluginId: string,
): Record<string, unknown> {
  return (config.plugins?.entries?.[pluginId]?.config as Record<string, unknown>) ?? {};
}

function toPathSegments(fieldKey: string): string[] {
  return fieldKey.split(".").filter(Boolean);
}

function formatCurrentValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return JSON.stringify(value);
}

/**
 * Discover plugins that have non-advanced uiHints fields.
 * Returns only plugins that have at least one promptable field.
 */
export function discoverConfigurablePlugins(params: {
  manifestPlugins: ReadonlyArray<{
    id: string;
    name?: string;
    configUiHints?: Record<string, PluginConfigUiHint>;
    configSchema?: Record<string, unknown>;
    enabled?: boolean;
  }>;
}): ConfigurablePlugin[] {
  const result: ConfigurablePlugin[] = [];
  for (const plugin of params.manifestPlugins) {
    if (!plugin.configUiHints) {
      continue;
    }
    // Only include non-advanced fields
    const promptableHints: Record<string, PluginConfigUiHint> = {};
    for (const [key, hint] of Object.entries(plugin.configUiHints)) {
      if (!hint.advanced) {
        promptableHints[key] = hint;
      }
    }
    if (Object.keys(promptableHints).length === 0) {
      continue;
    }
    result.push({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      uiHints: promptableHints,
      jsonSchema: plugin.configSchema,
    });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover plugins with unconfigured non-advanced fields (for onboard flow).
 * Returns only plugins where at least one promptable field has no value yet.
 */
export function discoverUnconfiguredPlugins(params: {
  manifestPlugins: ReadonlyArray<{
    id: string;
    name?: string;
    configUiHints?: Record<string, PluginConfigUiHint>;
    configSchema?: Record<string, unknown>;
    enabled?: boolean;
  }>;
  config: OpenClawConfig;
}): ConfigurablePlugin[] {
  const all = discoverConfigurablePlugins(params);
  return all.filter((plugin) => {
    const existing = getExistingPluginConfig(params.config, plugin.id);
    return Object.keys(plugin.uiHints).some((key) => {
      const val = getPath(existing, toPathSegments(key));
      return val === undefined || val === null || val === "";
    });
  });
}

/**
 * Prompt the user to configure a single plugin's fields via uiHints.
 * Returns the updated config with plugin values applied.
 */
async function promptPluginFields(params: {
  plugin: ConfigurablePlugin;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  /** When true, show all fields including already-configured ones (for configure flow). */
  showConfigured?: boolean;
}): Promise<OpenClawConfig> {
  const { plugin, config, prompter } = params;
  const existing = getExistingPluginConfig(config, plugin.id);
  const updatedConfig = structuredClone(existing);
  let changed = false;

  for (const [key, hint] of Object.entries(plugin.uiHints)) {
    const pathSegments = toPathSegments(key);
    const currentValue = getPath(existing, pathSegments);
    const hasValue = currentValue !== undefined && currentValue !== null && currentValue !== "";

    // In onboard mode, skip already-configured fields
    if (hasValue && !params.showConfigured) {
      continue;
    }

    const schemaProp = resolveJsonSchemaProperty(plugin.jsonSchema, key);
    const label = hint.label ?? key;
    const helpSuffix = hint.help ? ` — ${hint.help}` : "";

    // Skip sensitive fields — WizardPrompter has no masked input;
    // direct users to openclaw config set or the Web UI instead.
    if (hint.sensitive) {
      await prompter.note(
        `"${label}" is sensitive. Set it via:\n  openclaw config set plugins.entries.${plugin.id}.config.${key} <value>\nor use the Web UI Settings page.`,
        "Sensitive field",
      );
      continue;
    }

    // Handle enum fields with select
    if (schemaProp?.enum && Array.isArray(schemaProp.enum)) {
      const options = schemaProp.enum.map((v) => ({
        value: String(v),
        label: String(v),
      }));
      if (hasValue) {
        options.unshift({
          value: "__keep__",
          label: `Keep current (${formatCurrentValue(currentValue)})`,
        });
      }
      const selected = await prompter.select({
        message: `${label}${helpSuffix}`,
        options,
        initialValue: hasValue ? "__keep__" : undefined,
      });
      if (selected !== "__keep__") {
        setPathCreateStrict(updatedConfig, pathSegments, selected);
        changed = true;
      }
      continue;
    }

    // Handle boolean fields with confirm
    if (schemaProp?.type === "boolean") {
      const confirmed = await prompter.confirm({
        message: `${label}${helpSuffix}`,
        initialValue: typeof currentValue === "boolean" ? currentValue : false,
      });
      if (confirmed !== currentValue) {
        setPathCreateStrict(updatedConfig, pathSegments, confirmed);
        changed = true;
      }
      continue;
    }

    // Handle array fields — prompt as comma-separated string
    if (schemaProp?.type === "array") {
      const currentStr = Array.isArray(currentValue) ? (currentValue as unknown[]).join(", ") : "";
      const input = await prompter.text({
        message: `${label} (comma-separated, empty to clear)${helpSuffix}`,
        initialValue: currentStr,
        placeholder: hint.placeholder ?? "value1, value2",
      });
      const trimmed = input.trim();
      if (trimmed !== currentStr) {
        if (trimmed) {
          const values = trimmed
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          setPathCreateStrict(updatedConfig, pathSegments, values);
        } else {
          setPathCreateStrict(updatedConfig, pathSegments, undefined);
        }
        changed = true;
      }
      continue;
    }

    // Default: text input (string, number, etc.)
    const currentStr = formatCurrentValue(currentValue);
    const input = await prompter.text({
      message: `${label}${helpSuffix}`,
      initialValue: currentStr,
      placeholder: hint.placeholder,
    });
    const trimmed = input.trim();
    if (trimmed !== currentStr) {
      // Coerce numeric text input when the schema expects a JSON number or integer.
      if (schemaProp?.type === "number" || schemaProp?.type === "integer") {
        if (trimmed === "") {
          setPathCreateStrict(updatedConfig, pathSegments, undefined);
          changed = true;
        } else {
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) {
            setPathCreateStrict(updatedConfig, pathSegments, parsed);
            changed = true;
          }
        }
      } else {
        setPathCreateStrict(updatedConfig, pathSegments, trimmed || undefined);
        changed = true;
      }
    }
  }

  if (!changed) {
    return config;
  }

  // Merge updated plugin config back into the full config
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [plugin.id]: {
          ...config.plugins?.entries?.[plugin.id],
          config: updatedConfig,
        },
      },
    },
  };
}

/**
 * Run the plugin configuration step for the onboard wizard.
 * Shows unconfigured plugin fields and prompts the user.
 */
export async function setupPluginConfig(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const { loadPluginManifestRegistry } = await import("../plugins/manifest-registry.js");
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const unconfigured = discoverUnconfiguredPlugins({
    manifestPlugins: registry.plugins.filter((p) => {
      // Only show enabled plugins
      const entry = params.config.plugins?.entries?.[p.id];
      // Plugin is discoverable if it's enabled or enabledByDefault and not denied
      return p.enabledByDefault || entry?.enabled === true;
    }),
    config: params.config,
  });

  if (unconfigured.length === 0) {
    return params.config;
  }

  const selected = await params.prompter.multiselect({
    message: "Configure plugins (select to set up now, or skip)",
    options: [
      {
        value: "__skip__",
        label: "Skip for now",
        hint: "Continue without configuring plugins",
      },
      ...unconfigured.map((p) => ({
        value: p.id,
        label: p.name,
        hint: `${Object.keys(p.uiHints).length} field${Object.keys(p.uiHints).length === 1 ? "" : "s"}`,
      })),
    ],
  });

  let config = params.config;
  for (const pluginId of selected.filter((value) => value !== "__skip__")) {
    const plugin = unconfigured.find((p) => p.id === pluginId);
    if (!plugin) {
      continue;
    }
    await params.prompter.note(`Configure ${plugin.name}`, "Plugin setup");
    config = await promptPluginFields({
      plugin,
      config,
      prompter: params.prompter,
    });
  }

  return config;
}

/**
 * Run the plugin configuration step for the configure wizard.
 * Shows all configurable plugins and all their non-advanced fields.
 */
export async function configurePluginConfig(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<OpenClawConfig> {
  const { loadPluginManifestRegistry } = await import("../plugins/manifest-registry.js");
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const configurable = discoverConfigurablePlugins({
    manifestPlugins: registry.plugins.filter((p) => {
      const entry = params.config.plugins?.entries?.[p.id];
      return p.enabledByDefault || entry?.enabled === true;
    }),
  });

  if (configurable.length === 0) {
    await params.prompter.note("No plugins with configurable fields found.", "Plugins");
    return params.config;
  }

  const selected = await params.prompter.select({
    message: "Select plugin to configure",
    options: [
      ...configurable.map((p) => {
        const existing = getExistingPluginConfig(params.config, p.id);
        const configuredCount = Object.keys(p.uiHints).filter((k) => {
          const val = getPath(existing, toPathSegments(k));
          return val !== undefined && val !== null && val !== "";
        }).length;
        const totalCount = Object.keys(p.uiHints).length;
        return {
          value: p.id,
          label: p.name,
          hint: `${configuredCount}/${totalCount} configured`,
        };
      }),
      { value: "__skip__", label: "Back", hint: "Return to section menu" },
    ],
  });

  if (selected === "__skip__") {
    return params.config;
  }

  const plugin = configurable.find((p) => p.id === selected);
  if (!plugin) {
    return params.config;
  }

  return promptPluginFields({
    plugin,
    config: params.config,
    prompter: params.prompter,
    showConfigured: true,
  });
}
