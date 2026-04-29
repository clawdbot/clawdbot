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
    ["bundled-channel-deps", ["bundled-channel-deps-compat"]],
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

export function dedupeLanes(poolLanes) {
  const byName = new Map();
  for (const poolLane of poolLanes) {
    if (!byName.has(poolLane.name)) {
      byName.set(poolLane.name, poolLane);
    }
  }
  return [...byName.values()];
}

export function selectNamedLanes(poolLanes, selectedNames, label) {
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

export function applyLiveMode(poolLanes, mode) {
  if (mode === "all") {
    return poolLanes;
  }
  return poolLanes.filter((poolLane) => (mode === "only" ? poolLane.live : !poolLane.live));
}

export function applyLiveRetries(poolLanes, retries) {
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
  return dedupeLanes([
    ...allReleasePathLanes({ includeOpenWebUI: true }),
    ...mainLanes,
    ...tailLanes,
  ]).find((poolLane) => poolLane.name === name);
}

export function laneCredentialRequirements(poolLane) {
  const credentials = [];
  if (poolLane.name === "install-e2e-openai") {
    credentials.push("openai");
  }
  if (poolLane.name === "install-e2e-anthropic") {
    credentials.push("anthropic");
  }
  if (poolLane.name === "openwebui" || poolLane.name === "openai-web-search-minimal") {
    credentials.push("openai");
  }
  return credentials;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function buildPlanJson(params) {
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
  const releaseLanes =
    options.selectedLaneNames.length === 0 && options.profile === RELEASE_PATH_PROFILE
      ? options.planReleaseAll
        ? allReleasePathLanes({ includeOpenWebUI: options.includeOpenWebUI })
        : releasePathChunkLanes(options.releaseChunk, {
            includeOpenWebUI: options.includeOpenWebUI,
          })
      : undefined;
  const selectedLanes =
    options.selectedLaneNames.length > 0
      ? selectNamedLanes(
          dedupeLanes([
            ...allReleasePathLanes({ includeOpenWebUI: options.includeOpenWebUI }),
            ...retriedMainLanes,
            ...retriedTailLanes,
          ]),
          options.selectedLaneNames,
          "OPENCLAW_DOCKER_ALL_LANES",
        )
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
