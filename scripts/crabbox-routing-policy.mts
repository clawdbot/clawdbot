const workloadAliasEntries = [
  ["check", "ci-fast"],
  ["ci", "ci-fast"],
  ["ci-fast", "ci-fast"],
  ["ci-proof", "ci-proof"],
  ["desktop", "desktop"],
  ["interactive", "interactive"],
  ["release", "release-proof"],
  ["release-proof", "release-proof"],
  ["untrusted", "untrusted"],
  ["windows", "windows"],
] as const;

type CrabboxWorkload = (typeof workloadAliasEntries)[number][1];

const workloadAliases = new Map<string, CrabboxWorkload>(workloadAliasEntries);

export function normalizeCrabboxWorkload(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return "";
  }
  return workloadAliases.get(normalized) ?? null;
}

export function crabboxProviderChain({
  workload,
  configuredProvider,
  target,
  advertisedProviders,
}: {
  workload: CrabboxWorkload | "";
  configuredProvider: string;
  target: string;
  advertisedProviders: readonly string[];
}) {
  const providers = new Set(advertisedProviders);
  const normalizedConfigured = configuredProvider.trim();
  const normalizedTarget = target.trim().toLowerCase();

  if (normalizedTarget === "macos") {
    return available(["aws"], providers);
  }
  if (normalizedTarget === "windows" || workload === "windows") {
    return available(["azure", "aws"], providers);
  }

  const cloudFallback = ["azure", "aws"];
  switch (workload) {
    case "ci-fast":
      return available(["blacksmith-testbox", "daytona", ...cloudFallback], providers);
    case "ci-proof":
    case "release-proof":
      return available(["blacksmith-testbox", "daytona", ...cloudFallback], providers);
    case "interactive":
      return available(["daytona", ...cloudFallback], providers);
    case "desktop":
      return available(cloudFallback, providers);
    case "untrusted":
      // Daytona remains excluded until its brokered isolation profile has live proof.
      return available(cloudFallback, providers);
    default:
      return available([normalizedConfigured], providers);
  }
}

export function selectReadyCrabboxProvider<T extends { ready: boolean }>(
  chain: readonly string[],
  readiness: ReadonlyMap<string, T>,
) {
  for (const provider of chain) {
    const status = readiness.get(provider);
    if (status?.ready) {
      return { provider, readiness: status };
    }
  }
  return null;
}

function available(candidates: readonly string[], advertisedProviders: ReadonlySet<string>) {
  return candidates.filter((provider) => provider && advertisedProviders.has(provider));
}
