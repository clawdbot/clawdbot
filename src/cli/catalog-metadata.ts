export type CliCatalogRisk = "low" | "medium" | "high";
export type CliCatalogEffectMode = "read" | "mutating" | "mixed";
export type CliCatalogVisibility = "docs" | "audit" | "operator" | "policy";
type CliCommandExposureTier = "public" | "internal";

export type CommandEffectProfile = {
  readonly effectMode: CliCatalogEffectMode;
  readonly confirmationRequired?: boolean;
  readonly risk?: CliCatalogRisk;
};

export type CommandExposure = {
  readonly tier?: CliCommandExposureTier;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeCommandEffectProfile(value: unknown): CommandEffectProfile | undefined {
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).some(
      (key) => key !== "effectMode" && key !== "confirmationRequired" && key !== "risk",
    ) ||
    (record.effectMode !== "read" &&
      record.effectMode !== "mutating" &&
      record.effectMode !== "mixed") ||
    (record.confirmationRequired !== undefined &&
      typeof record.confirmationRequired !== "boolean") ||
    (record.risk !== undefined &&
      record.risk !== "low" &&
      record.risk !== "medium" &&
      record.risk !== "high")
  ) {
    return undefined;
  }
  return {
    effectMode: record.effectMode,
    ...(typeof record.confirmationRequired === "boolean"
      ? { confirmationRequired: record.confirmationRequired }
      : {}),
    ...(record.risk === "low" || record.risk === "medium" || record.risk === "high"
      ? { risk: record.risk }
      : {}),
  };
}

export function normalizeCommandExposure(value: unknown): CommandExposure | undefined {
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).some((key) => key !== "tier") ||
    (record.tier !== undefined && record.tier !== "public" && record.tier !== "internal")
  ) {
    return undefined;
  }
  return record.tier === "public" || record.tier === "internal" ? { tier: record.tier } : {};
}
