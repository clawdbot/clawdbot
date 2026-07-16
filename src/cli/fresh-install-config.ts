const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);

function isIncompleteWizardConfig(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "securityAcknowledgedAt")
  );
}

export function isUnconfiguredConfigSource(sourceConfig: Record<string, unknown>): boolean {
  return Object.entries(sourceConfig).every(
    ([key, value]) =>
      UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key) ||
      (key === "wizard" && isIncompleteWizardConfig(value)),
  );
}
