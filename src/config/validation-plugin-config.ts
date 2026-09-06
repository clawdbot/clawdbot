import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import {
  normalizePluginsConfig,
  normalizePluginId,
  isExplicitPluginDisableMarker,
  isRetiredPluginId,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../plugins/default-enablement.js";
import { resolveManifestCommandAliasOwnerInRegistry } from "../plugins/manifest-command-aliases.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstallSources,
} from "../plugins/official-external-plugin-catalog.js";
import { validatePluginSchemaValue } from "../plugins/schema-validator.js";
import { hasKind } from "../plugins/slots.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

const BLOCKED_PLUGIN_CANDIDATE_PREFIX = "blocked plugin candidate:";

type ExplicitPluginReferences = {
  entries: Set<string>;
  allow: Set<string>;
  deny: Set<string>;
  slots: Map<string, string>;
};

export function collectExplicitPluginReferences(raw: unknown): ExplicitPluginReferences {
  const references: ExplicitPluginReferences = {
    entries: new Set(),
    allow: new Set(),
    deny: new Set(),
    slots: new Map(),
  };
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return references;
  }
  const { plugins } = raw;
  if (isRecord(plugins.entries)) {
    for (const pluginId of Object.keys(plugins.entries)) {
      const normalized = normalizePluginId(pluginId);
      if (normalized) {
        references.entries.add(normalized);
      }
    }
  }
  for (const [key, target] of [
    ["allow", references.allow],
    ["deny", references.deny],
  ] as const) {
    const value = plugins[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalized = normalizePluginId(entry);
        if (normalized) {
          target.add(normalized);
        }
      }
    }
  }
  if (isRecord(plugins.slots)) {
    for (const [slotId, pluginId] of Object.entries(plugins.slots)) {
      if (typeof pluginId !== "string") {
        continue;
      }
      const normalized = normalizePluginId(pluginId);
      if (normalized && normalized !== "none") {
        references.slots.set(normalized, slotId);
      }
    }
  }
  return references;
}

export function resolveExplicitPluginReferencePath(
  references: ExplicitPluginReferences,
  pluginId: string,
): string | undefined {
  const normalized = normalizePluginId(pluginId);
  if (!normalized) {
    return undefined;
  }
  if (references.entries.has(normalized)) {
    return `plugins.entries.${normalized}`;
  }
  if (references.allow.has(normalized)) {
    return "plugins.allow";
  }
  if (references.deny.has(normalized)) {
    return "plugins.deny";
  }
  const slotId = references.slots.get(normalized);
  return slotId ? `plugins.slots.${slotId}` : undefined;
}

function formatRemovedPluginConfigWarning(pluginId: string): string {
  if (pluginId === "skill-workshop") {
    return "plugin removed: skill-workshop (stale plugin config ignored; Skill Workshop is built into OpenClaw skills now. Use skills.workshop settings and openclaw skills workshop commands, then remove this plugins config entry)";
  }
  return `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`;
}

function formatMissingOfficialExternalPluginWarning(
  pluginId: string,
  opts?: { selectedMissingMemorySlot?: boolean },
): string | null {
  const catalogEntry = getOfficialExternalPluginCatalogEntry(pluginId);
  if (!catalogEntry) {
    return null;
  }
  const installSpec = resolveOfficialExternalPluginInstallSources(catalogEntry)[0]?.spec;
  if (!installSpec) {
    return null;
  }
  if (pluginId === "memory-lancedb" && opts?.selectedMissingMemorySlot) {
    return `plugin not installed: ${pluginId} — gateway will run without persistent memory until installed; install the official external plugin with: openclaw plugins install ${installSpec}`;
  }
  return `plugin not installed: ${pluginId} — install the official external plugin with: openclaw plugins install ${installSpec}`;
}

export function validateExplicitPluginConfig(params: {
  raw: unknown;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  applyDefaults: boolean;
  registry: PluginManifestRegistry;
  knownIds: Set<string>;
  normalizedPlugins: ReturnType<typeof normalizePluginsConfig>;
  ensureCompatPluginIds: () => ReadonlySet<string>;
  ensureOverriddenPluginIds: () => Set<string>;
  replacePluginEntryConfig: (pluginId: string, nextValue: Record<string, unknown>) => void;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
}): void {
  const {
    raw,
    config,
    env,
    applyDefaults,
    registry,
    knownIds,
    normalizedPlugins,
    ensureCompatPluginIds,
    ensureOverriddenPluginIds,
    issues,
    warnings,
  } = params;
  const blockedPluginDiagnostics = new Map<string, { message: string; source?: string }>();
  const blockedPluginDiagnosticsWithSource: Array<{ message: string; source: string }> = [];
  const normalizeBlockedDiagnosticPath = (value: string | undefined): string => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return path.resolve(resolveUserPath(trimmed, env ?? process.env));
    } catch {
      return path.resolve(trimmed);
    }
  };
  for (const diag of registry.diagnostics) {
    if (!diag.message.startsWith(BLOCKED_PLUGIN_CANDIDATE_PREFIX)) {
      continue;
    }
    if (!diag.pluginId && diag.source) {
      blockedPluginDiagnosticsWithSource.push({ message: diag.message, source: diag.source });
    }
    if (diag.pluginId) {
      const normalizedPluginId = normalizePluginId(diag.pluginId);
      for (const key of [diag.pluginId, normalizedPluginId]) {
        if (key && !blockedPluginDiagnostics.has(key)) {
          blockedPluginDiagnostics.set(key, {
            message: diag.message,
            ...(diag.source ? { source: diag.source } : {}),
          });
        }
      }
    }
  }
  const blockedDiagnosticSourceMatchesPluginId = (
    diagnostic: { message: string; source: string },
    pluginId: string,
  ): boolean => {
    const normalizedPluginId = normalizePluginId(pluginId);
    if (!normalizedPluginId) {
      return false;
    }
    const sourcePath = normalizeBlockedDiagnosticPath(diagnostic.source);
    if (!sourcePath) {
      return false;
    }
    if (
      normalizePluginId(path.basename(sourcePath)) === normalizedPluginId ||
      normalizePluginId(path.basename(path.dirname(sourcePath))) === normalizedPluginId
    ) {
      return true;
    }
    const loadPaths = config.plugins?.load?.paths;
    if (!Array.isArray(loadPaths)) {
      return false;
    }
    for (const loadPath of loadPaths) {
      if (typeof loadPath !== "string") {
        continue;
      }
      const resolvedLoadPath = normalizeBlockedDiagnosticPath(loadPath);
      if (
        resolvedLoadPath &&
        normalizePluginId(path.basename(resolvedLoadPath)) === normalizedPluginId &&
        (sourcePath === resolvedLoadPath ||
          isPathInside(resolvedLoadPath, sourcePath) ||
          isPathInside(sourcePath, resolvedLoadPath))
      ) {
        return true;
      }
    }
    return false;
  };
  const findBlockedPluginDiagnostic = (pluginId: string) =>
    blockedPluginDiagnostics.get(pluginId) ??
    blockedPluginDiagnostics.get(normalizePluginId(pluginId)) ??
    blockedPluginDiagnosticsWithSource.find((diagnostic) =>
      blockedDiagnosticSourceMatchesPluginId(diagnostic, pluginId),
    );
  const missingOfficialPluginWarningIds = new Set<string>();
  const pushMissingPluginIssue = (
    issuePath: string,
    pluginId: string,
    options?: {
      warnOnly?: boolean;
      officialInstallHint?: boolean;
      missingMessage?: string | null;
    },
  ) => {
    if (isRetiredPluginId(pluginId)) {
      warnings.push({ path: issuePath, message: formatRemovedPluginConfigWarning(pluginId) });
      return;
    }
    const blockedDiagnostic = findBlockedPluginDiagnostic(pluginId);
    if (blockedDiagnostic) {
      const source = blockedDiagnostic.source ? `; source: ${blockedDiagnostic.source}` : "";
      const message = `plugin present but blocked: ${pluginId} (see preceding plugin warning${source}; fix the blocked plugin path instead of removing config)`;
      (options?.warnOnly ? warnings : issues).push({ path: issuePath, message });
      return;
    }
    if (
      normalizePluginId(pluginId) === "codex" &&
      issuePath === "plugins.entries.codex" &&
      shouldSuppressMissingCodexPluginDiagnostics(
        config,
        env ?? process.env,
        isRecord(raw) ? (raw as OpenClawConfig) : undefined,
      )
    ) {
      return;
    }
    if (options?.warnOnly && options.officialInstallHint !== false) {
      const externalInstallWarning =
        options.missingMessage ?? formatMissingOfficialExternalPluginWarning(pluginId);
      if (externalInstallWarning) {
        const normalizedPluginId = normalizePluginId(pluginId);
        if (!options.missingMessage && normalizedPluginId) {
          if (missingOfficialPluginWarningIds.has(normalizedPluginId)) {
            return;
          }
          missingOfficialPluginWarningIds.add(normalizedPluginId);
        }
        warnings.push({ path: issuePath, message: externalInstallWarning });
        return;
      }
    }
    const message = options?.warnOnly
      ? `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`
      : `plugin not found: ${pluginId}`;
    (options?.warnOnly ? warnings : issues).push({ path: issuePath, message });
  };

  const pluginsConfig = config.plugins;
  const entries = pluginsConfig?.entries;
  // Normalized entries gain optional keys, so inspect the original disable marker shape.
  const hasIntentionalDisableMarker = (pluginId: string) =>
    isExplicitPluginDisableMarker(entries?.[pluginId]) && !isRetiredPluginId(pluginId);
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId) && !hasIntentionalDisableMarker(pluginId)) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }
  for (const pluginId of pluginsConfig?.allow ?? []) {
    if (typeof pluginId !== "string" || !pluginId.trim() || knownIds.has(pluginId)) {
      continue;
    }
    const commandAlias = resolveManifestCommandAliasOwnerInRegistry({
      command: pluginId,
      registry,
    });
    if (commandAlias?.pluginId && knownIds.has(commandAlias.pluginId)) {
      warnings.push({
        path: "plugins.allow",
        message:
          `"${pluginId}" is not a plugin — it is a command provided by the "${commandAlias.pluginId}" plugin. ` +
          `Use "${commandAlias.pluginId}" in plugins.allow instead.`,
      });
    } else if (!hasIntentionalDisableMarker(pluginId)) {
      pushMissingPluginIssue("plugins.allow", pluginId, { warnOnly: true });
    }
  }
  for (const pluginId of pluginsConfig?.deny ?? []) {
    if (typeof pluginId === "string" && pluginId.trim() && !knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId, {
        warnOnly: true,
        officialInstallHint: false,
      });
    }
  }

  // The default memory slot is inferred; only a user-configured slot should block startup.
  const pluginSlots = pluginsConfig?.slots;
  const hasExplicitMemorySlot = pluginSlots !== undefined && Object.hasOwn(pluginSlots, "memory");
  const memorySlot = normalizedPlugins.slots.memory;
  if (
    hasExplicitMemorySlot &&
    typeof memorySlot === "string" &&
    memorySlot.trim() &&
    !knownIds.has(memorySlot)
  ) {
    const missingMessage = formatMissingOfficialExternalPluginWarning(memorySlot, {
      selectedMissingMemorySlot: true,
    });
    const isMissingOfficialExternalMemorySlot =
      memorySlot === "memory-lancedb" && Boolean(missingMessage);
    pushMissingPluginIssue("plugins.slots.memory", memorySlot, {
      warnOnly: isMissingOfficialExternalMemorySlot && !findBlockedPluginDiagnostic(memorySlot),
      missingMessage,
    });
  }

  let selectedMemoryPluginId: string | null = null;
  const seenPlugins = new Set<string>();
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    const entry = normalizedPlugins.entries[pluginId];
    const entryHasConfig = Boolean(entry?.config);
    const activationState = resolveEffectivePluginActivationState({
      id: pluginId,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedPlugins,
      rootConfig: config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    });
    let enabled = activationState.activated;
    let reason = activationState.reason;
    if (enabled) {
      const memoryDecision = resolveMemorySlotDecision({
        id: pluginId,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        enabled = false;
        reason = memoryDecision.reason;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = pluginId;
      }
    }
    const shouldReplacePluginConfig = entryHasConfig || (applyDefaults && enabled);
    const shouldValidate = enabled || entryHasConfig;
    if (shouldValidate) {
      if (record.configSchema) {
        const result = validatePluginSchemaValue({
          origin: record.origin,
          schema: record.configSchema,
          cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
          value: entry?.config ?? {},
          applyDefaults: true, // Always apply defaults for AJV schema validation;
          // writeConfigFile persists persistCandidate, not validated.config (#61841)
        });
        if (!result.ok) {
          for (const error of result.errors) {
            const base = `plugins.entries.${pluginId}.config`;
            issues.push({
              path: !error.path || error.path === "<root>" ? base : `${base}.${error.path}`,
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        } else if (shouldReplacePluginConfig) {
          params.replacePluginEntryConfig(pluginId, result.value as Record<string, unknown>);
        }
      } else if (record.format === "bundle") {
        // Compatible bundles currently expose no native OpenClaw config schema.
        // Treat them as schema-less capability packs rather than failing validation.
      } else {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }
    const suppressDisabledConfigWarning =
      ensureCompatPluginIds().has(pluginId) && !ensureOverriddenPluginIds().has(pluginId);
    if (!enabled && entryHasConfig && !suppressDisabledConfigWarning) {
      warnings.push({
        path: `plugins.entries.${pluginId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }
}
