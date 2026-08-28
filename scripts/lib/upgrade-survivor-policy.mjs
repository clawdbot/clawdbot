export const UPGRADE_SURVIVOR_SCENARIOS = Object.freeze([
  "base",
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
]);

// Registry proof needs its own artifact contract, so broad aliases omit it.
const aggregateScenarios = UPGRADE_SURVIVOR_SCENARIOS.filter(
  (scenario) => scenario !== "prerelease-plugin-registry",
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
