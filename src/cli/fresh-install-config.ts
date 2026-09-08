import type { ConfigFileSnapshot } from "../config/types.openclaw.js";

const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);

function isIncompleteWizardConfig(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "securityAcknowledgedAt" || key === "accessMode")
  );
}

export function isUnconfiguredConfigSource(sourceConfig: Record<string, unknown>): boolean {
  return Object.entries(sourceConfig).every(
    ([key, value]) =>
      UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key) ||
      (key === "wizard" && isIncompleteWizardConfig(value)),
  );
}

export async function shouldStartLocalOnboarding(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig" | "path">,
): Promise<boolean> {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid || snapshot.sourceConfig.gateway?.mode === "remote") {
    return false;
  }
  if (isUnconfiguredConfigSource(snapshot.sourceConfig)) {
    return true;
  }
  // Inference persists before setup finishes; only its owning receipt can
  // distinguish interrupted local onboarding from an authored model-only config.
  const { readLocalOnboardingStateForConfig } = await import("../state/local-onboarding-state.js");
  return (
    readLocalOnboardingStateForConfig(snapshot.path, snapshot.sourceConfig)?.status === "pending"
  );
}
