import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function normalizeWorkerProviderIds(providerIds: readonly string[]): string[] {
  const normalized = providerIds
    .map(normalizeCapabilityProviderId)
    .filter((id): id is string => id !== undefined);
  return [...new Set(normalized)].toSorted(compareText);
}
