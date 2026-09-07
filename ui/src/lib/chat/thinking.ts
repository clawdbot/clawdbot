import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  BASE_THINKING_LEVELS,
  normalizeThinkLevel,
  resolveThinkingDefaultForModelCore,
} from "../../../../src/auto-reply/thinking.shared.js";
import type {
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { sessionModelMatchesDefaults } from "../session-model-defaults.ts";
// Control UI module implements thinking behavior.
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";

type ThinkingSessionDefaults = SessionsListResult["defaults"] | undefined;

type ChatThinkingSelection = {
  source: "override" | "default";
  value: string;
  displayLabel: string;
} & ({ kind: "anchored"; index: number } | { kind: "unanchored" });

export type ChatThinkingTarget = Pick<
  GatewaySessionRow,
  | "agentRuntime"
  | "model"
  | "modelProvider"
  | "thinkingDefault"
  | "thinkingLevel"
  | "thinkingLevels"
  | "thinkingOptions"
>;

export type ChatThinkingSelectState = {
  selection: ChatThinkingSelection;
  inherited: { value: string; displayLabel: string };
  options: Array<{ value: string; label: string }>;
};

function resolveThinkingLevelOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
  fallbackLabels?: readonly string[],
): GatewayThinkingLevelOption[] {
  const { provider, model } = resolveThinkingTargetModel({ defaults, session });
  return resolveThinkingLevelOptions({
    catalogEntry: resolveThinkingCatalogEntry(catalog, provider, model, session?.agentRuntime?.id),
    defaults,
    fallbackLabels,
    session,
  });
}

export function resolveThinkingCommandArgOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string[] {
  const options = resolveThinkingLevelOptionsForSession(session, defaults, catalog, []).map(
    (level) => normalizeThinkingOptionValue(level.id),
  );
  return options.length > 0
    ? ["default", ...new Set(options.filter((option) => option && option !== "default"))]
    : [];
}

export function formatThinkingCommandOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string {
  const options = resolveThinkingLevelOptionsForSession(session, defaults, catalog)
    .map((level) => level.label)
    .join(", ");
  return options.split(", ").includes("default") ? options : `default, ${options}`;
}

export function resolveThinkingLevelInput(
  rawLevel: string,
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
): string | undefined {
  const normalized = normalizeThinkLevel(rawLevel);
  if (normalized) {
    return normalized;
  }
  const rawKey = normalizeLowercaseStringOrEmpty(rawLevel);
  return resolveThinkingLevelOptionsForSession(session, defaults, catalog)
    .map((option) => ({
      id: normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id),
      label: normalizeLowercaseStringOrEmpty(option.label),
    }))
    .find((option) => option.id === rawKey || option.label === rawKey)?.id;
}

export function isThinkingLevelOptionForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  level: string,
  catalog: readonly ModelCatalogEntry[] = [],
): boolean {
  return resolveThinkingLevelOptionsForSession(session, defaults, catalog).some((option) => {
    const id = normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id);
    return id === level || normalizeThinkLevel(option.label) === level;
  });
}

export function resolveCurrentThinkingLevel(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  models: ModelCatalogEntry[],
): string {
  const persisted = normalizeThinkLevel(session?.thinkingLevel);
  if (persisted) {
    return (
      resolveThinkingLevelOptionsForSession(session, defaults).find(
        (level) => normalizeThinkLevel(level.id) === persisted,
      )?.label ?? persisted
    );
  }
  if (session?.thinkingDefault) {
    return session.thinkingDefault;
  }
  if ((!session || sessionModelMatchesDefaults(session, defaults)) && defaults?.thinkingDefault) {
    return defaults.thinkingDefault;
  }
  const provider = session?.modelProvider ?? defaults?.modelProvider;
  const model = session?.model ?? defaults?.model;
  if (!provider || !model) {
    return "off";
  }
  return resolveThinkingDefaultForModelCore({
    provider,
    model,
    catalog: models,
  });
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };

  for (const level of levels) {
    addOption(level.id, level.label);
  }
  return options;
}

function isOffThinkingOption(value: string | null | undefined): boolean {
  return normalizeThinkingOptionValue(value ?? "") === "off";
}

function isOffOnlyThinkingLevels(levels: readonly GatewayThinkingLevelOption[]): boolean {
  return levels.every((level) => isOffThinkingOption(level.id || level.label));
}

function resolveThinkingTargetModel(params: {
  defaults: ThinkingSessionDefaults;
  session: ChatThinkingTarget | undefined;
}): { provider: string | null; model: string | null } {
  return {
    provider: params.session?.modelProvider ?? params.defaults?.modelProvider ?? null,
    model: params.session?.model ?? params.defaults?.model ?? null,
  };
}

function resolveThinkingCatalogEntry(
  catalog: readonly ModelCatalogEntry[],
  provider: string | null,
  model: string | null,
  runtimeId?: string,
): ModelCatalogEntry | undefined {
  const runtime = runtimeId?.trim();
  return catalog.find((entry) => {
    const entryRuntime = entry.agentRuntime?.id?.trim();
    // Agent-scoped catalogs must not supply another runtime's session thinking profile.
    return (
      entry.provider === provider &&
      entry.id === model &&
      (!runtime || !entryRuntime || runtime === entryRuntime)
    );
  });
}

function resolveThinkingLevelOptions(params: {
  catalogEntry: ModelCatalogEntry | undefined;
  defaults: ThinkingSessionDefaults;
  fallbackLabels?: readonly string[];
  hideUnsupportedOffOnly?: boolean;
  session: ChatThinkingTarget | undefined;
}): GatewayThinkingLevelOption[] {
  const { catalogEntry } = params;
  const modelMatchesDefaults = sessionModelMatchesDefaults(params.session, params.defaults);
  const explicitLevels =
    (params.session?.thinkingLevels?.length ? params.session.thinkingLevels : null) ??
    (params.session?.model && catalogEntry?.thinkingLevels?.length
      ? catalogEntry.thinkingLevels
      : null) ??
    (modelMatchesDefaults && params.defaults?.thinkingLevels?.length
      ? params.defaults.thinkingLevels
      : null);
  if (explicitLevels) {
    if (
      params.hideUnsupportedOffOnly &&
      catalogEntry?.reasoning === false &&
      isOffOnlyThinkingLevels(explicitLevels)
    ) {
      return [];
    }
    return explicitLevels;
  }
  const explicitLabels =
    (params.session?.thinkingOptions?.length ? params.session.thinkingOptions : null) ??
    (modelMatchesDefaults && params.defaults?.thinkingOptions?.length
      ? params.defaults.thinkingOptions
      : null);
  if (params.hideUnsupportedOffOnly && catalogEntry?.reasoning === false) {
    if (!explicitLabels || explicitLabels.every(isOffThinkingOption)) {
      return [];
    }
  }
  const labels = explicitLabels ?? params.fallbackLabels ?? BASE_THINKING_LEVELS;
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

export function resolveChatThinkingSelectState(params: {
  catalog: readonly ModelCatalogEntry[];
  defaults?: SessionsListResult["defaults"];
  session?: ChatThinkingTarget;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
}): ChatThinkingSelectState {
  const session =
    params.session ??
    params.sessionsResult?.sessions?.find((row) =>
      areUiSessionKeysEquivalent(row.key, params.sessionKey),
    );
  const persisted = session?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = params.defaults ?? params.sessionsResult?.defaults;
  const { provider, model } = resolveThinkingTargetModel({ defaults, session });
  const catalogEntry = resolveThinkingCatalogEntry(
    params.catalog,
    provider,
    model,
    session?.agentRuntime?.id,
  );
  const levels = resolveThinkingLevelOptions({
    catalogEntry,
    defaults,
    hideUnsupportedOffOnly: true,
    session,
  });
  const defaultFromSessionDefaults =
    (!session || sessionModelMatchesDefaults(session, defaults)) && defaults?.thinkingDefault
      ? defaults.thinkingDefault
      : undefined;
  const defaultLevel =
    session?.thinkingDefault ??
    (session?.model ? catalogEntry?.thinkingDefault : undefined) ??
    defaultFromSessionDefaults ??
    (provider && model
      ? resolveThinkingDefaultForModelCore({
          provider,
          model,
          catalog: [...params.catalog],
        })
      : "off");
  const effectiveOverride = levels.length === 0 && currentOverride === "off" ? "" : currentOverride;
  const options = buildThinkingOptions(levels);
  const defaultValue = normalizeThinkingOptionValue(defaultLevel);
  const inherited = {
    value: defaultValue,
    displayLabel: formatInheritedThinkingLabel(defaultLevel),
  };
  const selectionValue = effectiveOverride || defaultValue;
  const selectionIndex = options.findIndex((option) => option.value === selectionValue);
  const source = effectiveOverride ? "override" : "default";
  const displayLabel = effectiveOverride
    ? (options[selectionIndex]?.label ?? formatThinkingOverrideLabel(effectiveOverride))
    : inherited.displayLabel;
  return {
    selection:
      selectionIndex >= 0
        ? { kind: "anchored", source, value: selectionValue, displayLabel, index: selectionIndex }
        : { kind: "unanchored", source, value: selectionValue, displayLabel },
    inherited,
    options,
  };
}

export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

export function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  const normalized = effectiveLevel ? normalizeThinkingOptionValue(effectiveLevel) : "off";
  return `Inherited: ${formatThinkingLevelDisplayLabel(normalized)}`;
}

export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") {
    return "Off";
  }
  return formatThinkingLevelDisplayLabel(label?.trim() || normalized);
}

function formatThinkingLevelDisplayLabel(value: string): string {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (["on", "enable", "enabled"].includes(raw)) {
    return "On";
  }
  const normalized = normalizeThinkingOptionValue(value);
  switch (normalized) {
    case "adaptive":
      return "Adaptive";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    case "ultra":
      return "Ultra";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
