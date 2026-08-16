/** Keeps provider-auth refresh warnings aligned with the state that refresh publishes. */
import type { SecretResolverWarning } from "./runtime-shared.js";

function isProviderAuthRuntimeWarning(warning: SecretResolverWarning): boolean {
  return warning.path.startsWith("models.providers.") || warning.path.includes(".auth-profiles.");
}

export function mergeProviderAuthRuntimeWarnings(
  activeWarnings: readonly SecretResolverWarning[],
  candidateWarnings: readonly SecretResolverWarning[],
): SecretResolverWarning[] {
  return [
    ...activeWarnings.filter((warning) => !isProviderAuthRuntimeWarning(warning)),
    ...candidateWarnings.filter(isProviderAuthRuntimeWarning),
  ];
}
