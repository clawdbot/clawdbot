export function canonicalProviderName(provider: string): string;
export function parseProvidersFromHelp(text: string): string[];
export function isProviderAdvertised(
  provider: string,
  advertisedProviders: readonly string[],
): boolean;
