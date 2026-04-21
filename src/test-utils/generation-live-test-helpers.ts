import { loadShellEnvFallback } from "../infra/shell-env.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";

export function maybeLoadShellEnvForGenerationProviders(providerIds: string[]): void {
  const expectedKeys = [
    ...new Set(providerIds.flatMap((providerId) => getProviderEnvVars(providerId))),
  ];
  if (expectedKeys.length === 0) {
    return;
  }
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys,
    logger: { warn: (message: string) => console.warn(message) },
  });
}
