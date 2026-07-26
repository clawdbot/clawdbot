import type { HealthFinding } from "../flows/health-checks.js";
import "./doctor-auth.js";

type TestApi = {
  legacyCodexProviderOverrideToHealthFinding(providerOverride: unknown): HealthFinding;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorAuthTestApi")
  ] as TestApi;
}

export const legacyCodexProviderOverrideToHealthFinding: TestApi["legacyCodexProviderOverrideToHealthFinding"] =
  (providerOverride) => getTestApi().legacyCodexProviderOverrideToHealthFinding(providerOverride);
