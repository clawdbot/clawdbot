// Docker E2E scheduler planning helpers.
// This module turns the scenario catalog plus env-driven inputs into a concrete
// lane plan. It intentionally does not define scenario commands.
import {
  BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS,
  DEFAULT_LIVE_RETRIES,
  allReleasePathLanes,
  mainLanes,
  releasePathChunkLanes,
  tailLanes,
} from "./docker-e2e-scenarios.mjs";

export { DEFAULT_LIVE_RETRIES };

export const DEFAULT_E2E_BARE_IMAGE = "openclaw-docker-e2e-bare:local";
export const DEFAULT_E2E_FUNCTIONAL_IMAGE = "openclaw-docker-e2e-functional:local";
export const DEFAULT_E2E_IMAGE = DEFAULT_E2E_FUNCTIONAL_IMAGE;
export const DEFAULT_PARALLELISM = 10;
export const DEFAULT_PROFILE = "all";
export const DEFAULT_RESOURCE_LIMITS = {
  docker: DEFAULT_PARALLELISM,
  live: 9,
  "live:claude": 4,
  "live:codex": 4,
  "live:droid": 4,
  "live:gemini": 4,
  "live:opencode": 4,
  npm: 10,
  service: 7,
};
export const DEFAULT_TAIL_PARALLELISM = 10;
export const RELEASE_PATH_PROFILE = "release-path";

export function parseLaneSelection(raw) {
  if (!raw) {
    return [];
  }
  const laneAliases = new Map([
    ["install-e2e", ["install-e2e-openai", "install-e2e-anthropic"]],
    [
      "bundled-plugin-install-uninstall",
      Array.from(
        { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
        (_, index) => `bundled-plugin-install-uninstall-${index}`,
      ),
    ],
  ]);
  return [
    ...new Set(
      String(raw)
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .flatMap((token) => laneAliases.get(token) ?? [token]),
    ),
  ];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sanitizeLaneNameSuffix(value) {
  return (
    String(value)
      .replace(/^openclaw@/u, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "baseline"
  );
}

const UPGRADE_SURVIVOR_SCENARIOS = [
  "base",
  "feishu-channel",
  "bootstrap-persona",
  "plugin-deps-cleanup",
  "configured-plugin-installs",
  "tilde-log-path",
  "versioned-runtime-deps",
];

const UPGRADE_SURVIVOR_SCENARIO_ALIASES = new Map([
  ["reported-issues", UPGRADE_SURVIVOR_SCENARIOS],
  ["far-reaching", UPGRADE_SURVIVOR_SCENARIOS],
]);

export function normalizeUpgradeSurvivorBaselineSpec(raw) {
  const value = String(raw ?? "").trim();
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
      )}. Expected openclaw@latest, openclaw@beta, openclaw@alpha, or openclaw@YYYY.M.D.`,
    );
  }
  return spec;
}

function parseUpgradeSurvivorBaselineSpecs(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      String(raw)
        .split(/[,\s]+/u)
        .map(normalizeUpgradeSurvivorBaselineSpec)
        .filter(Boolean),
    ),
  ];
}

function normalizeUpgradeSurvivorScenario(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return undefined;
  }
  if (!UPGRADE_SURVIVOR_SCENARIOS.includes(value)) {
    throw new Error(
      `invalid published upgrade survivor scenario: ${JSON.stringify(
        value,
      )}. Expected one of: ${UPGRADE_SURVIVOR_SCENARIOS.join(", ")}, reported-issues.`,
    );
  }
  return value;
}

function parseUpgradeSurvivorScenarios(raw) {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      String(raw)
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .flatMap((token) => UPGRADE_SURVIVOR_SCENARIO_ALIASES.get(token) ?? [token])
        .map(normalizeUpgradeSurvivorScenario)
        .filter(Boolean),
    ),
  ];
}

function parsePublishedReleaseVersion(spec) {
  const match = /^openclaw@([0-9]{4})\.([0-9]+)\.([0-9]+)/u.exec(String(spec ?? ""));
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function comparePublishedReleaseVersion(a, b) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function supportsUpgradeSurvivorPluginDependencyCleanup(baselineSpec) {
  if (!baselineSpec) {
    return true;
  }
  const version = parsePublishedReleaseVersion(baselineSpec);
  if (!version) {
    return true;
  }
  return comparePublishedReleaseVersion(version, { year: 2026, month: 4, day: 23 }) >= 0;
}

function expandUpgradeSurvivorBaselineLanes(poolLanes, rawBaselineSpecs, rawScenarios = "") {
  const baselineSpecs = parseUpgradeSurvivorBaselineSpecs(rawBaselineSpecs);
  const scenarios = parseUpgradeSurvivorScenarios(rawScenarios);
  if (baselineSpecs.length === 0 && scenarios.length === 0) {
    return poolLanes;
  }
  return poolLanes.flatMap((poolLane) => {
    if (poolLane.name !== "published-upgrade-survivor" && poolLane.name !== "update-migration") {
      return [poolLane];
    }
    const matrixBaselines = baselineSpecs.length > 0 ? baselineSpecs : [undefined];
    const matrixScenarios = scenarios.length > 0 ? scenarios : [undefined];
    return matrixBaselines.flatMap((baselineSpec) =>
      matrixScenarios
        .filter(
          (scenario) =>
            scenario !== "plugin-deps-cleanup" ||
            supportsUpgradeSurvivorPluginDependencyCleanup(baselineSpec),
        )
        .map((scenario) => {
          const suffixParts = [
            baselineSpec ? sanitizeLaneNameSuffix(baselineSpec) : "",
            scenario && scenario !== "base" ? sanitizeLaneNameSuffix(scenario) : "",
          ].filter(Boolean);
          const suffix = suffixParts.join("-");
          const name = suffix ? `${poolLane.name}-${suffix}` : poolLane.name;
          const commandPrefix = [
            `OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/${name}"`,
            baselineSpec
              ? `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=${shellQuote(baselineSpec)}`
              : "",
            scenario ? `OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=${shellQuote(scenario)}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return Object.assign({}, poolLane, {
            cacheKey: poolLane.cacheKey
              ? suffix
                ? `${poolLane.cacheKey}-${suffix}`
                : poolLane.cacheKey
              : name,
            command: commandPrefix ? `${commandPrefix} ${poolLane.command}` : poolLane.command,
            name,
          });
        }),
    );
  });
}

function dedupeLanes(poolLanes) {
  const byName = new Map();
  for (const poolLane of poolLanes) {
    if (!byName.has(poolLane.name)) {
      byName.set(poolLane.name, poolLane);
    }
  }
  return [...byName.values()];
}

function selectNamedLanes(poolLanes, selectedNames, label) {
  const byName = new Map(poolLanes.map((poolLane) => [poolLane.name, poolLane]));
  const missing = selectedNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${label} unknown lane(s): ${missing.join(", ")}. Available lanes: ${[...byName.keys()]
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}`,
    );
  }
  return selectedNames.map((name) => byName.get(name));
}

export function parseLiveMode(raw) {
  const mode = raw || "all";
  if (mode === "all" || mode === "skip" || mode === "only") {
    return mode;
  }
  throw new Error(
    `OPENCLAW_DOCKER_ALL_LIVE_MODE must be one of: all, skip, only. Got: ${JSON.stringify(raw)}`,
  );
}

export function parseProfile(raw) {
  const profile = raw || DEFAULT_PROFILE;
  if (profile === DEFAULT_PROFILE || profile === RELEASE_PATH_PROFILE) {
    return profile;
  }
  throw new Error(
    `OPENCLAW_DOCKER_ALL_PROFILE must be one of: ${DEFAULT_PROFILE}, ${RELEASE_PATH_PROFILE}. Got: ${JSON.stringify(raw)}`,
  );
}

function applyLiveMode(poolLanes, mode) {
  if (mode === "all") {
    return poolLanes;
  }
  return poolLanes.filter((poolLane) => (mode === "only" ? poolLane.live : !poolLane.live));
}

function applyLiveRetries(poolLanes, retries) {
  return poolLanes.map((poolLane) => (poolLane.live ? { ...poolLane, retries } : poolLane));
}

export function laneWeight(poolLane) {
  return Math.max(1, poolLane.weight ?? 1);
}

export function laneResources(poolLane) {
  return ["docker", ...(poolLane.resources ?? [])];
}

export function laneSummary(poolLane) {
  const resources = laneResources(poolLane).join(",");
  const timeout = poolLane.timeoutMs ? ` timeout=${Math.round(poolLane.timeoutMs / 1000)}s` : "";
  const noOutputTimeout = poolLane.noOutputTimeoutMs
    ? ` no-output=${Math.round(poolLane.noOutputTimeoutMs / 1000)}s`
    : "";
  const retries = poolLane.retries > 0 ? ` retries=${poolLane.retries}` : "";
  const cache = poolLane.cacheKey ? ` cache=${poolLane.cacheKey}` : "";
  const image = poolLane.e2eImageKind ? ` image=${poolLane.e2eImageKind}` : "";
  const state = poolLane.stateScenario ? ` state=${poolLane.stateScenario}` : "";
  return `${poolLane.name}(w=${laneWeight(poolLane)} r=${resources}${timeout}${noOutputTimeout}${retries}${cache}${image}${state})`;
}

export function lanesNeedE2eImageKind(poolLanes, kind) {
  return poolLanes.some((poolLane) => poolLane.e2eImageKind === kind);
}

export function lanesNeedOpenClawPackage(poolLanes) {
  return poolLanes.some((poolLane) => poolLane.e2eImageKind);
}

export function findLaneByName(name) {
  return dedupeLanes(
    expandUpgradeSurvivorBaselineLanes(
      [...allReleasePathLanes({ includeOpenWebUI: true }), ...mainLanes, ...tailLanes],
      process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS,
      process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
    ),
  ).find((poolLane) => poolLane.name === name);
}

function laneCredentialRequirements(poolLane) {
  const credentials = [];
  if (poolLane.name === "install-e2e-openai") {
    credentials.push("openai");
  }
  if (poolLane.name === "install-e2e-anthropic") {
    credentials.push("anthropic");
  }
  if (
    poolLane.name === "openwebui" ||
    poolLane.name === "openai-web-search-minimal" ||
    poolLane.name === "live-codex-npm-plugin"
  ) {
    credentials.push("openai");
  }
  return credentials;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildPlanJson(params) {
  const scheduledLanes = [...params.orderedLanes, ...params.orderedTailLanes];
  const imageKinds = unique(scheduledLanes.map((poolLane) => poolLane.e2eImageKind)).toSorted(
    (a, b) => a.localeCompare(b),
  );
  return {
    chunk: params.releaseChunk || undefined,
    credentials: unique(scheduledLanes.flatMap(laneCredentialRequirements)).toSorted((a, b) =>
      a.localeCompare(b),
    ),
    imageKinds,
    includeOpenWebUI: params.includeOpenWebUI,
    lanes: scheduledLanes.map((poolLane) => ({
      command: poolLane.command,
      imageKind: poolLane.e2eImageKind,
      live: poolLane.live,
      name: poolLane.name,
      noOutputTimeoutMs: poolLane.noOutputTimeoutMs,
      resources: laneResources(poolLane),
      stateScenario: poolLane.stateScenario,
      timeoutMs: poolLane.timeoutMs,
      weight: laneWeight(poolLane),
    })),
    mainLanes: params.orderedLanes.map((poolLane) => poolLane.name),
    needs: {
      bareImage: imageKinds.includes("bare"),
      e2eImage: imageKinds.length > 0,
      functionalImage: imageKinds.includes("functional"),
      liveImage: scheduledLanes.some((poolLane) => poolLane.live),
      package: lanesNeedOpenClawPackage(scheduledLanes),
    },
    profile: params.profile,
    selectedLanes: params.selectedLaneNames,
    tailLanes: params.orderedTailLanes.map((poolLane) => poolLane.name),
    version: 1,
  };
}

export function resolveDockerE2ePlan(options) {
  const retriedMainLanes = applyLiveRetries(mainLanes, options.liveRetries);
  const retriedTailLanes = applyLiveRetries(tailLanes, options.liveRetries);
  const upgradeSurvivorBaselines = options.upgradeSurvivorBaselines ?? "";
  const upgradeSurvivorScenarios = options.upgradeSurvivorScenarios ?? "";
  const unexpandedSelectableLanes = dedupeLanes([
    ...allReleasePathLanes({ includeOpenWebUI: options.includeOpenWebUI }),
    ...retriedMainLanes,
    ...retriedTailLanes,
  ]);
  const selectableLanes = dedupeLanes(
    expandUpgradeSurvivorBaselineLanes(
      unexpandedSelectableLanes,
      upgradeSurvivorBaselines,
      upgradeSurvivorScenarios,
    ),
  );
  const releaseLanes =
    options.selectedLaneNames.length === 0 && options.profile === RELEASE_PATH_PROFILE
      ? options.planReleaseAll
        ? expandUpgradeSurvivorBaselineLanes(
            allReleasePathLanes({ includeOpenWebUI: options.includeOpenWebUI }),
            upgradeSurvivorBaselines,
            upgradeSurvivorScenarios,
          )
        : expandUpgradeSurvivorBaselineLanes(
            releasePathChunkLanes(options.releaseChunk, {
              includeOpenWebUI: options.includeOpenWebUI,
            }),
            upgradeSurvivorBaselines,
            upgradeSurvivorScenarios,
          )
      : undefined;
  const selectedLanes =
    options.selectedLaneNames.length > 0
      ? options.selectedLaneNames.flatMap((selectedName) => {
          const expandedLane = selectableLanes.find((poolLane) => poolLane.name === selectedName);
          if (expandedLane) {
            return [expandedLane];
          }
          const unexpandedLane = unexpandedSelectableLanes.find(
            (poolLane) => poolLane.name === selectedName,
          );
          if (unexpandedLane) {
            return expandUpgradeSurvivorBaselineLanes(
              [unexpandedLane],
              upgradeSurvivorBaselines,
              upgradeSurvivorScenarios,
            );
          }
          selectNamedLanes(selectableLanes, [selectedName], "OPENCLAW_DOCKER_ALL_LANES");
          return [];
        })
      : undefined;
  const configuredLanes = selectedLanes
    ? selectedLanes
    : releaseLanes
      ? releaseLanes
      : options.liveMode === "only"
        ? applyLiveMode([...retriedMainLanes, ...retriedTailLanes], options.liveMode)
        : applyLiveMode(retriedMainLanes, options.liveMode);
  const configuredTailLanes =
    selectedLanes || releaseLanes
      ? []
      : options.liveMode === "only"
        ? []
        : applyLiveMode(retriedTailLanes, options.liveMode);
  const orderedLanes = options.orderLanes(configuredLanes, options.timingStore);
  const orderedTailLanes = options.orderLanes(configuredTailLanes, options.timingStore);
  return {
    orderedLanes,
    orderedTailLanes,
    plan: buildPlanJson({
      includeOpenWebUI: options.includeOpenWebUI,
      orderedLanes,
      orderedTailLanes,
      profile: options.profile,
      releaseChunk: options.releaseChunk,
      selectedLaneNames: options.selectedLaneNames,
    }),
    scheduledLanes: [...orderedLanes, ...orderedTailLanes],
  };
}
