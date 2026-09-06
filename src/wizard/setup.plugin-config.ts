// Setup plugin config helpers build plugin config from onboarding answers.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { getPath, setPathCreateStrict } from "../secrets/path-utils.js";
import {
  parseConcreteConfigPathTokens,
  type ConcreteConfigPathSegment,
} from "../shared/dot-path.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { t } from "./i18n/index.js";
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
  jsonSchema?: JsonSchemaObject;
};

const loadPluginMetadataSnapshotModule = createLazyRuntimeModule(
  () => import("../plugins/plugin-metadata-snapshot.js"),
);

const loadPluginActivationModule = createLazyRuntimeModule(async () => {
  const [configState, defaultEnablement, activationContext] = await Promise.all([
    import("../plugins/config-state.js"),
    import("../plugins/default-enablement.js"),
    import("../plugins/activation-context.js"),
  ]);
  return { ...configState, ...defaultEnablement, ...activationContext };
});

type JsonSchemaProperty = {
  type?: string;
  enum?: unknown[];
  description?: string;
};

function resolveJsonSchemaProperty(
  jsonSchema: JsonSchemaObject | undefined,
  pathSegments: readonly ConcreteConfigPathSegment[],
): JsonSchemaProperty | undefined {
  if (!jsonSchema) {
    return undefined;
  }
  let cursor: unknown = jsonSchema;
  for (const segment of pathSegments) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    const schema = cursor as Record<string, unknown>;
    const properties = schema.properties;
    cursor =
      schema.type === "array"
        ? schema.items
        : properties && typeof properties === "object"
          ? (properties as Record<string, unknown>)[String(segment)]
          : undefined;
  }
  return cursor && typeof cursor === "object" ? (cursor as JsonSchemaProperty) : undefined;
}

function getExistingPluginConfig(
  config: OpenClawConfig,
  pluginId: string,
): Record<string, unknown> {
  return (config.plugins?.entries?.[pluginId]?.config as Record<string, unknown>) ?? {};
}

/**
 * Moves entries saved under a legacy plugin id onto the canonical one.
 *
 * An entry on an old key is invisible to a lookup by manifest id, so the wizard reads back
 * nothing, asks again for fields the user already filled, and then writes a second entry
 * beside the old one. Folding up front means everything below works on canonical ids.
 */
async function foldLegacyPluginEntries(
  config: OpenClawConfig,
  pluginIds: readonly string[],
): Promise<OpenClawConfig> {
  const { mergePluginEntryAliases, normalizePluginId, normalizePluginTargetConfig } =
    await loadPluginActivationModule();
  return pluginIds.reduce((folded, pluginId) => {
    const resolvedId = normalizePluginId(pluginId);
    const next = normalizePluginTargetConfig(folded, pluginId);
    if (!next.plugins?.entries?.[resolvedId]) {
      return next;
    }
    // The normalizer keeps only one of the duplicate entries, so the merged one is written
    // back over it. Read the merge off the pre-fold config, which still holds both keys.
    return {
      ...next,
      plugins: {
        ...next.plugins,
        entries: {
          ...next.plugins.entries,
          [resolvedId]: mergePluginEntryAliases(folded, pluginId),
        },
      },
    };
  }, config);
}

function toPathSegments(
  fieldKey: string,
  existing: Record<string, unknown>,
  jsonSchema?: JsonSchemaObject,
): ConcreteConfigPathSegment[] {
  const segments = parseConcreteConfigPathTokens(fieldKey);
  let value: unknown = existing;

  return segments.map((segment, index) => {
    const schema = resolveJsonSchemaProperty(jsonSchema, segments.slice(0, index));
    // Existing containers own their shape; the schema recovers arrays not created yet.
    const arrayContainer = Array.isArray(value) || (value == null && schema?.type === "array");
    const arrayIndex =
      typeof segment === "string" && arrayContainer
        ? parseConfigPathArrayIndex(segment)
        : undefined;
    const resolved = arrayIndex ?? segment;
    value =
      value !== null && typeof value === "object"
        ? Reflect.get(value, String(resolved))
        : undefined;
    return resolved;
  });
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

function parseJsonNumberInput(value: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
      const val = getPath(existing, toPathSegments(key, existing, plugin.jsonSchema).map(String));
      return val === undefined || val === null || val === "";
    });
  });
}

async function listEnabledConfigurableManifestPlugins(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): Promise<readonly PluginManifestRecord[]> {
  const { loadPluginMetadataSnapshot } = await loadPluginMetadataSnapshotModule();
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  const {
    resolveEffectivePluginActivationState,
    isPluginEnabledByDefaultForPlatform,
    resolvePluginActivationInputs,
  } = await loadPluginActivationModule();

  // `enabledByDefault || entry.enabled === true` is not what decides whether a plugin runs. It
  // misses an explicit false overriding a default-on manifest, a global `plugins.enabled: false`,
  // deny and allow policy, workspace policy, selected slots, auto-enable reasons and
  // platform-specific defaults.
  //
  // Going through resolvePluginActivationInputs rather than normalizing here matters twice
  // over. Its normalizer resolves built-in aliases, so a legacy plugin id used as an entry key
  // still lines up with the manifest id, and `applyAutoEnable` materializes the auto-enables
  // that runtime performs before activation is judged. Reading the raw config instead misses a
  // plugin that is only on because auto-enable turned it on.
  const inputs = resolvePluginActivationInputs({
    rawConfig: params.config,
    env: process.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    // Hand over the registry this function already loaded. Without it auto-enable detection
    // re-resolves the setup registry from disk, which is both wasted work here and a second
    // source for the same answer.
    manifestRegistry: snapshot.manifestRegistry,
    // Pass the discovery this snapshot was built from too. With only the registry,
    // auto-enable re-derives a default-scope discovery and a workspace scoped run ends up
    // judging activation against a different generation than the inventory came from.
    discovery: snapshot.discovery,
  });

  return snapshot.plugins.filter((plugin) => {
    const autoEnabledReason = inputs.autoEnabledReasons[plugin.id]?.[0];
    const activation = resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      config: inputs.normalized,
      rootConfig: inputs.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
      activationSource: inputs.activationSource,
      ...(autoEnabledReason ? { autoEnabledReason } : {}),
    });
    return activation.activated;
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
    const pathSegments = toPathSegments(key, existing, plugin.jsonSchema);
    const currentValue = getPath(existing, pathSegments.map(String));
    const hasValue = currentValue !== undefined && currentValue !== null && currentValue !== "";

    // In onboard mode, skip already-configured fields
    if (hasValue && !params.showConfigured) {
      continue;
    }

    const schemaProp = resolveJsonSchemaProperty(plugin.jsonSchema, pathSegments);
    const label = hint.label ?? key;
    const helpSuffix = hint.help ? ` — ${hint.help}` : "";

    // Skip sensitive fields — WizardPrompter has no masked input;
    // direct users to openclaw config set or the Web UI instead.
    if (hint.sensitive) {
      await prompter.note(
        t("wizard.plugins.sensitiveField", {
          label,
          plugin: plugin.id,
          field: key,
        }),
        t("wizard.plugins.sensitiveTitle"),
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
          label: t("wizard.plugins.currentValue", { value: formatCurrentValue(currentValue) }),
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
        message: `${label}${t("wizard.plugins.arrayPromptSuffix")}${helpSuffix}`,
        initialValue: currentStr,
        placeholder: hint.placeholder ?? t("wizard.plugins.arrayPlaceholder"),
      });
      const trimmed = input.trim();
      if (trimmed !== currentStr) {
        if (trimmed) {
          const values = normalizeStringEntries(trimmed.split(","));
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
          const parsed = parseJsonNumberInput(trimmed);
          if (parsed !== undefined && (schemaProp.type === "number" || Number.isInteger(parsed))) {
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
  const manifestPlugins = await listEnabledConfigurableManifestPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const folded = await foldLegacyPluginEntries(
    params.config,
    manifestPlugins.map((plugin) => plugin.id),
  );

  const unconfigured = discoverUnconfiguredPlugins({
    manifestPlugins,
    config: folded,
  });

  if (unconfigured.length === 0) {
    return params.config;
  }

  const selected = await params.prompter.multiselect({
    message: t("wizard.plugins.configureSelectOnboard"),
    options: [
      {
        value: "__skip__",
        label: t("common.skipForNow"),
        hint: t("wizard.plugins.skipConfigHint"),
      },
      ...unconfigured.map((p) => ({
        value: p.id,
        label: p.name,
        hint: t("wizard.plugins.fieldsCount", {
          count: Object.keys(p.uiHints).length,
          plural: Object.keys(p.uiHints).length === 1 ? "" : "s",
        }),
      })),
    ],
  });

  let config = folded;
  for (const pluginId of selected.filter((value) => value !== "__skip__")) {
    const plugin = unconfigured.find((p) => p.id === pluginId);
    if (!plugin) {
      continue;
    }
    await params.prompter.note(
      t("wizard.plugins.configurePlugin", { plugin: plugin.name }),
      t("wizard.plugins.configureFieldsTitle"),
    );
    config = await promptPluginFields({
      plugin,
      config,
      prompter: params.prompter,
    });
  }

  // Nothing was answered, so hand back what came in rather than rewriting entry keys the
  // user did not ask us to touch.
  return config === folded ? params.config : config;
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
  const manifestPlugins = await listEnabledConfigurableManifestPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const configurable = discoverConfigurablePlugins({
    manifestPlugins,
  });

  const folded = await foldLegacyPluginEntries(
    params.config,
    manifestPlugins.map((plugin) => plugin.id),
  );

  if (configurable.length === 0) {
    await params.prompter.note(
      t("wizard.plugins.configureEmpty"),
      t("wizard.plugins.configureEmptyTitle"),
    );
    return params.config;
  }

  const selected = await params.prompter.select({
    message: t("wizard.plugins.configureSelect"),
    options: [
      ...configurable.map((p) => {
        const existing = getExistingPluginConfig(folded, p.id);
        const configuredCount = Object.keys(p.uiHints).filter((k) => {
          const val = getPath(existing, toPathSegments(k, existing, p.jsonSchema).map(String));
          return val !== undefined && val !== null && val !== "";
        }).length;
        const totalCount = Object.keys(p.uiHints).length;
        return {
          value: p.id,
          label: p.name,
          hint: t("wizard.plugins.configuredCount", {
            configured: configuredCount,
            total: totalCount,
          }),
        };
      }),
      { value: "__skip__", label: t("common.back"), hint: t("wizard.plugins.configureBackHint") },
    ],
    searchable: true,
  });

  if (selected === "__skip__") {
    return params.config;
  }

  const plugin = configurable.find((p) => p.id === selected);
  if (!plugin) {
    return params.config;
  }

  const next = await promptPluginFields({
    plugin,
    config: folded,
    prompter: params.prompter,
    showConfigured: true,
  });

  // Same as the onboard path: an untouched config goes back exactly as it came in.
  return next === folded ? params.config : next;
}
