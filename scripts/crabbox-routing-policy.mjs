const workloadAliases = new Map([
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
]);

export function normalizeCrabboxWorkload(value) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
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
}) {
  const providers = new Set(advertisedProviders);
  const normalizedConfigured = `${configuredProvider ?? ""}`.trim();
  const normalizedTarget = `${target ?? ""}`.trim().toLowerCase();

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

export function selectReadyCrabboxProvider(chain, readiness) {
  for (const provider of chain) {
    const status = readiness.get(provider);
    if (status?.ready) {
      return { provider, readiness: status };
    }
  }
  return null;
}

function available(candidates, advertisedProviders) {
  return candidates.filter((provider) => provider && advertisedProviders.has(provider));
}
