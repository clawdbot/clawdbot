const UPGRADE_SURVIVOR_SCENARIOS = Object.freeze([
  "base",
  "abandoned-update",
  "legacy-operator-state",
  "mobile-pairing-reconnect",
  "acpx-openclaw-tools-bridge",
  "feishu-channel",
  "bootstrap-persona",
  "channel-post-core-restore",
  "plugin-deps-cleanup",
  "configured-plugin-installs",
  "stale-source-plugin-shadow",
  "prerelease-plugin-registry",
  "tilde-log-path",
  "meeting-transcripts-sqlite",
  "versioned-runtime-deps",
  "cron-scheduled-authority",
  "sqlite-volume",
  "recovery-cleanup",
  "auth-profile-v2026-7-2-beta-5",
  "watchos-direct-node",
]);

// Oldest release line supported by the operator-state upgrade regression gate.
export const OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE = "2026.6.34";

// These black-box scenarios are implemented entirely by the current trusted
// release harness and treat the selected tree only as the package under test.
const TRUSTED_HARNESS_OWNED_SCENARIOS = new Set(["mobile-pairing-reconnect", "abandoned-update"]);

export function isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario) {
  return TRUSTED_HARNESS_OWNED_SCENARIOS.has(scenario);
}

// Registry proof needs its artifact contract; versioned auth fixtures exercise
// legacy import rather than native state from every baseline in a broad sweep.
// Platform pairing probes run only through explicit or dedicated scheduled
// qualification until their runtime cost justifies aggregate release coverage.
const aggregateScenarios = UPGRADE_SURVIVOR_SCENARIOS.filter(
  (scenario) =>
    scenario !== "abandoned-update" &&
    scenario !== "mobile-pairing-reconnect" &&
    scenario !== "watchos-direct-node" &&
    scenario !== "prerelease-plugin-registry" &&
    scenario !== "auth-profile-v2026-7-2-beta-5" &&
    scenario !== "recovery-cleanup",
);
const scenarioAliases = new Map([
  ["reported-issues", aggregateScenarios.filter((scenario) => scenario !== "sqlite-volume")],
  ["far-reaching", aggregateScenarios],
]);

export function normalizeUpgradeSurvivorBaselineSpec(raw) {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  const spec = value.startsWith("openclaw@") ? value : `openclaw@${value}`;
  if (
    !/^openclaw@(?:alpha|beta|latest|[0-9]{4}\.[0-9]+\.[0-9]+(?:-(?:[0-9]+|alpha\.[0-9]+|beta\.[0-9]+))?)$/u.test(
      spec,
    )
  ) {
    throw new Error(
      `invalid published upgrade survivor baseline: ${JSON.stringify(
        value,
      )}. Expected openclaw@latest, openclaw@beta, openclaw@alpha, or openclaw@YYYY.M.PATCH.`,
    );
  }
  return spec;
}

export function parseUpgradeSurvivorBaselineSpecs(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,\s]+/u)
        .map(normalizeUpgradeSurvivorBaselineSpec)
        .filter((spec) => spec !== undefined),
    ),
  ];
}

function normalizeUpgradeSurvivorScenario(raw) {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  if (!UPGRADE_SURVIVOR_SCENARIOS.includes(value)) {
    throw new Error(
      `invalid published upgrade survivor scenario: ${JSON.stringify(
        value,
      )}. Expected one of: ${UPGRADE_SURVIVOR_SCENARIOS.join(", ")}, reported-issues, or far-reaching.`,
    );
  }
  return value;
}

export function parseUpgradeSurvivorScenarios(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .flatMap((token) => scenarioAliases.get(token) ?? [token])
        .map(normalizeUpgradeSurvivorScenario)
        .filter((scenario) => scenario !== undefined),
    ),
  ];
}

function parsePublishedReleaseVersion(spec) {
  const match = /^openclaw@([0-9]{4})\.([0-9]+)\.([0-9]+)/u.exec(spec ?? "");
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    patch: Number(match[3]),
  };
}

function comparePublishedReleaseVersion(a, b) {
  return a.year - b.year || a.month - b.month || a.patch - b.patch;
}

function supportsUpgradeSurvivorPluginDependencyCleanup(baselineSpec) {
  if (!baselineSpec) {
    return true;
  }
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (!version) {
    return true;
  }
  return comparePublishedReleaseVersion(version, { year: 2026, month: 4, patch: 23 }) >= 0;
}

function supportsUpgradeSurvivorAcpToolsBridge(baselineSpec) {
  if (!baselineSpec) {
    return true;
  }
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (!version) {
    return true;
  }
  return comparePublishedReleaseVersion(version, { year: 2026, month: 4, patch: 22 }) >= 0;
}

function supportsUpgradeSurvivorWatchDirectNode(baselineSpec) {
  if (!baselineSpec) {
    return true;
  }
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (!version) {
    return true;
  }
  return comparePublishedReleaseVersion(version, { year: 2026, month: 8, patch: 1 }) >= 0;
}

function supportsUpgradeSurvivorMobilePairingReconnect(baselineSpec) {
  if (!baselineSpec) {
    return true;
  }
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (!version) {
    return true;
  }
  return comparePublishedReleaseVersion(version, { year: 2026, month: 7, patch: 1 }) >= 0;
}

function supportsUpgradeSurvivorLegacyOperatorState(baselineSpec) {
  const version = parsePublishedReleaseVersion(baselineSpec);
  const floor = parsePublishedReleaseVersion(
    `openclaw@${OLDEST_SUPPORTED_UPGRADE_SURVIVOR_BASELINE}`,
  );
  return !version || comparePublishedReleaseVersion(version, floor) >= 0;
}

export function supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec) {
  return (
    (scenario !== "abandoned-update" || baselineSpec === "openclaw@2026.9.2") &&
    (scenario !== "legacy-operator-state" ||
      supportsUpgradeSurvivorLegacyOperatorState(baselineSpec)) &&
    (scenario !== "plugin-deps-cleanup" ||
      supportsUpgradeSurvivorPluginDependencyCleanup(baselineSpec)) &&
    (scenario !== "acpx-openclaw-tools-bridge" ||
      supportsUpgradeSurvivorAcpToolsBridge(baselineSpec)) &&
    (scenario !== "mobile-pairing-reconnect" ||
      supportsUpgradeSurvivorMobilePairingReconnect(baselineSpec)) &&
    (scenario !== "watchos-direct-node" || supportsUpgradeSurvivorWatchDirectNode(baselineSpec))
  );
}
