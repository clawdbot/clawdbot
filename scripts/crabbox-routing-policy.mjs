const workloadAliases = new Map([
  ["check", "ci-fast"],
  ["ci", "ci-fast"],
  ["ci-docker", "ci-docker"],
  ["ci-fast", "ci-fast"],
  ["ci-proof", "ci-proof"],
  ["desktop", "desktop"],
  ["docker", "ci-docker"],
  ["interactive", "interactive"],
  ["release", "release-proof"],
  ["release-proof", "release-proof"],
  ["untrusted", "untrusted"],
  ["windows", "windows"],
]);

const linuxCloudServerTypes = {
  "ci-fast": {
    aws: "c7a.4xlarge",
    azure: "Standard_D4ads_v6",
  },
  "ci-proof": {
    aws: "c7a.8xlarge",
    azure: "Standard_D16ads_v6",
  },
  "ci-docker": {
    aws: "c7a.8xlarge",
    azure: "Standard_D16ads_v6",
  },
  "release-proof": {
    aws: "c7a.8xlarge",
    azure: "Standard_D16ads_v6",
  },
};

export function normalizeCrabboxWorkload(value) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return workloadAliases.get(normalized) ?? null;
}

export function crabboxWorkloadServerType({ workload, provider, target }) {
  const normalizedTarget = `${target ?? ""}`.trim().toLowerCase() || "linux";
  if (normalizedTarget !== "linux") {
    return "";
  }
  const sizes = linuxCloudServerTypes[workload];
  return sizes?.[`${provider ?? ""}`.trim().toLowerCase()] ?? "";
}

export function crabboxWorkloadHydrateJob({ workload, target }) {
  const normalizedTarget = `${target ?? ""}`.trim().toLowerCase() || "linux";
  return workload === "ci-docker" && normalizedTarget === "linux" ? "hydrate-docker" : "";
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
      return available(["blacksmith-testbox", "daytona", ...cloudFallback], providers);
    case "ci-docker":
    case "release-proof":
      return available(["blacksmith-testbox", ...cloudFallback], providers);
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
