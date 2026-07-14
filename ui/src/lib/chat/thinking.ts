// Control UI module implements thinking behavior.
import type {
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { sessionModelMatchesDefaults } from "../session-model-defaults.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

type ThinkingCatalogEntry = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function normalizeThinkLevel(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "max") {
    return "max";
  }
  if (collapsed === "ultra") {
    return "ultra";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off" || key === "none") {
    return "off";
  }
  if (["on", "enable", "enabled"].includes(key)) {
    return "low";
  }
  if (["min", "minimal"].includes(key)) {
    return "minimal";
  }
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key)) {
    return "low";
  }
  if (["mid", "med", "medium", "thinkharder", "think-harder", "harder"].includes(key)) {
    return "medium";
  }
  if (["high", "ultrathink", "think-hard", "thinkhardest", "highest"].includes(key)) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

function listThinkingLevelLabels(
  provider?: string | null,
  model?: string | null,
): readonly string[] {
  void provider;
  void model;
  return BASE_THINKING_LEVELS;
}

function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: readonly ThinkingCatalogEntry[];
}): string {
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  return candidate?.reasoning ? "low" : "off";
}

type ThinkingSessionDefaults = SessionsListResult["defaults"] | undefined;

type ChatThinkingSelectState = {
  currentOverride: string;
  defaultLabel: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
};

function resolveThinkingLevelOptionsForSession(
  session: GatewaySessionRow | undefined,
  defaults: ThinkingSessionDefaults,
): GatewayThinkingLevelOption[] {
  const { provider, model } = resolveThinkingTargetModel({ defaults, session });
  return resolveThinkingLevelOptions({ catalog: [], defaults, model, provider, session });
}

export function formatThinkingCommandOptionsForSession(
  session: GatewaySessionRow | undefined,
  defaults?: SessionsListResult["defaults"],
): string {
  const options = resolveThinkingLevelOptionsForSession(session, defaults)
    .map((level) => level.label)
    .join(", ");
  return options.split(", ").includes("default") ? options : `default, ${options}`;
}

export function resolveThinkingLevelInput(
  rawLevel: string,
  session: GatewaySessionRow | undefined,
  defaults: ThinkingSessionDefaults,
): string | undefined {
  const normalized = normalizeThinkLevel(rawLevel);
  if (normalized) {
    return normalized;
  }
  const rawKey = normalizeLowercaseStringOrEmpty(rawLevel);
  return resolveThinkingLevelOptionsForSession(session, defaults)
    .map((option) => ({
      id: normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id),
      label: normalizeLowercaseStringOrEmpty(option.label),
    }))
    .find((option) => option.id === rawKey || option.label === rawKey)?.id;
}

export function isThinkingLevelOptionForSession(
  session: GatewaySessionRow | undefined,
  defaults: ThinkingSessionDefaults,
  level: string,
): boolean {
  return resolveThinkingLevelOptionsForSession(session, defaults).some((option) => {
    const id = normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id);
    return id === level || normalizeThinkLevel(option.label) === level;
  });
}

export function resolveCurrentThinkingLevel(
  session: GatewaySessionRow | undefined,
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
  return resolveThinkingDefaultForModel({
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
  session: GatewaySessionRow | undefined;
}): { provider: string | null; model: string | null } {
  return {
    provider: params.session?.modelProvider ?? params.defaults?.modelProvider ?? null,
    model: params.session?.model ?? params.defaults?.model ?? null,
  };
}

function resolveThinkingLevelOptions(params: {
  catalog: readonly ThinkingCatalogEntry[];
  defaults: ThinkingSessionDefaults;
  hideUnsupportedOffOnly?: boolean;
  model: string | null;
  provider: string | null;
  session: GatewaySessionRow | undefined;
}): GatewayThinkingLevelOption[] {
  const modelMatchesDefaults = sessionModelMatchesDefaults(params.session, params.defaults);
  const catalogEntry =
    params.provider && params.model
      ? params.catalog.find(
          (entry) => entry.provider === params.provider && entry.id === params.model,
        )
      : undefined;
  const explicitLevels =
    (params.session?.thinkingLevels?.length ? params.session.thinkingLevels : null) ??
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
  const labels =
    explicitLabels ??
    (params.provider && params.model
      ? listThinkingLevelLabels(params.provider, params.model)
      : listThinkingLevelLabels());
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

export function resolveChatThinkingSelectState(params: {
  catalog: readonly ThinkingCatalogEntry[];
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
}): ChatThinkingSelectState {
  const session = params.sessionsResult?.sessions?.find((row) => row.key === params.sessionKey);
  const persisted = session?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = params.sessionsResult?.defaults;
  const { provider, model } = resolveThinkingTargetModel({ defaults, session });
  const levels = resolveThinkingLevelOptions({
    catalog: params.catalog,
    defaults,
    hideUnsupportedOffOnly: true,
    model,
    provider,
    session,
  });
  const defaultFromSessionDefaults =
    (!session || sessionModelMatchesDefaults(session, defaults)) && defaults?.thinkingDefault
      ? defaults.thinkingDefault
      : undefined;
  const defaultLevel =
    session?.thinkingDefault ??
    defaultFromSessionDefaults ??
    (provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: params.catalog,
        })
      : "off");
  const effectiveOverride = levels.length === 0 && currentOverride === "off" ? "" : currentOverride;
  return {
    currentOverride: effectiveOverride,
    defaultLabel: formatInheritedThinkingLabel(defaultLevel),
    defaultValue: normalizeThinkingOptionValue(defaultLevel),
    options: buildThinkingOptions(levels),
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
