// Docker E2E scheduler planning helpers.
// This module turns the scenario catalog plus env-driven inputs into a concrete
// lane plan. It intentionally does not define scenario commands.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS,
  DEFAULT_LIVE_RETRIES,
  allReleasePathLanes,
  mainLanes,
  normalizeReleaseProfile,
  releasePathChunkLanes,
  tailLanes,
} from "./docker-e2e-scenarios.mjs";

export { DEFAULT_LIVE_RETRIES };
export { normalizeReleaseProfile };

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
  "live:openai": 1,
  "live:telegram": 1,
  npm: 5,
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
  "acpx-openclaw-tools-bridge",
  "feishu-channel",
  "bootstrap-persona",
  "channel-post-core-restore",
  "plugin-deps-cleanup",
  "configured-plugin-installs",
  "stale-source-plugin-shadow",
  "tilde-log-path",
  "versioned-runtime-deps",
];

const UPGRADE_SURVIVOR_SCENARIO_ALIASES = new Map([
  ["reported-issues", UPGRADE_SURVIVOR_SCENARIOS],
  ["far-reaching", UPGRADE_SURVIVOR_SCENARIOS],
]);

// Pre-protocol catalogs are content-addressed. Unknown legacy blocks fail
// closed instead of requiring a dependency or reimplementing a JavaScript parser.
const LEGACY_UPGRADE_SURVIVOR_SCENARIO_CATALOGS = new Map([
  [
    "755557a6ea609e5b9d9fe9d61beb7e75651641e26a3f0ef2fe1fc3a973b398c8",
    "base feishu-channel bootstrap-persona channel-post-core-restore plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path versioned-runtime-deps",
  ],
  [
    "2657b5cc7b94cf46b9900f9259ee4cef0033837ee71a673e6ed09e7ee36684e8",
    "base feishu-channel bootstrap-persona tilde-log-path versioned-runtime-deps",
  ],
  [
    "0fefb170b4131932c7403f7f0dcdd1371e300cdcc1c033b9bd2bd6513e08d5e4",
    "base feishu-channel bootstrap-persona plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path versioned-runtime-deps",
  ],
  [
    "5a2c3a6e3d2a7166025333d4f1a77de0576847f9da7e902055160d0e5f20d4c5",
    "base feishu-channel bootstrap-persona plugin-deps-cleanup configured-plugin-installs tilde-log-path versioned-runtime-deps",
  ],
  [
    "f226c05636dfb4e759558b5127d1c684d28a609292f4e110ff656c0e4f95ad06",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path versioned-runtime-deps",
  ],
  [
    "d9c9edcb27aca88a0b11c72e85592001cba732cf0f96bb8a73c1c0243c8f3678",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path versioned-runtime-deps",
  ],
  [
    "8ac0113158bfe1ebde77272fb1ffb740c281378a170fbc1e9e281d4e44677f02",
    "base feishu-channel bootstrap-persona plugin-deps-cleanup tilde-log-path versioned-runtime-deps",
  ],
]);

function readLegacyFrozenScenarioContract(assertionsFile) {
  const source = readFileSync(assertionsFile, "utf8");
  const startMarker = "const SCENARIOS = new Set([";
  const start = source.indexOf(startMarker);
  if (start < 0 || source.lastIndexOf(startMarker) !== start) {
    return undefined;
  }
  const end = source.indexOf("\n]);", start + startMarker.length);
  if (end < 0) {
    return undefined;
  }
  const block = source.slice(start, end + 4);
  const digest = createHash("sha256").update(block).digest("hex");
  return LEGACY_UPGRADE_SURVIVOR_SCENARIO_CATALOGS.get(digest)?.split(" ");
}

function readFrozenScenarioContract(assertionsFile, targetRoot, allowExecutableContract) {
  if (!allowExecutableContract) {
    const inertScenarios = readLegacyFrozenScenarioContract(assertionsFile);
    if (inertScenarios) {
      return inertScenarios;
    }
    throw new Error(
      `cannot read frozen upgrade-survivor scenarios from ${assertionsFile}: unrecognized scenario contract; require trusted workflow opt-in before executing target code`,
    );
  }
  // Canonical frozen refs may expose a dependency-free catalog command. Run it
  // only after the release workflow explicitly establishes the trust boundary.
  const result = spawnSync(process.execPath, [assertionsFile, "list-scenarios"], {
    cwd: targetRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const errorLines = result.stderr.trim().split("\n");
    if (result.stderr.includes("unknown upgrade-survivor assertion command: list-scenarios")) {
      const legacyScenarios = readLegacyFrozenScenarioContract(assertionsFile);
      if (legacyScenarios) {
        return legacyScenarios;
      }
    }
    const detail =
      errorLines.find((line) => line.startsWith("Error:")) ||
      errorLines.at(-1) ||
      "scenario command failed";
    throw new Error(
      `cannot read frozen upgrade-survivor scenarios from ${assertionsFile}: ${detail}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `cannot read frozen upgrade-survivor scenarios from ${assertionsFile}: list-scenarios did not return JSON`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some(
      (scenario) => typeof scenario !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(scenario),
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(
      `cannot read frozen upgrade-survivor scenarios from ${assertionsFile}: list-scenarios returned an invalid catalog`,
    );
  }
  return parsed;
}

function filterUpgradeSurvivorScenariosForTarget(scenarios, targetRoot, allowExecutableContract) {
  if (!targetRoot) {
    return scenarios;
  }
  const assertionsFile = resolve(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
  if (!existsSync(assertionsFile)) {
    return [];
  }
  const targetScenarios = readFrozenScenarioContract(
    assertionsFile,
    targetRoot,
    allowExecutableContract,
  );
  const supportedScenarios = new Set(targetScenarios);
  return scenarios.filter((scenario) => supportedScenarios.has(scenario));
}

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
      )}. Expected openclaw@latest, openclaw@beta, openclaw@alpha, or openclaw@YYYY.M.PATCH.`,
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

function supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec) {
  return (
    (scenario !== "plugin-deps-cleanup" ||
      supportsUpgradeSurvivorPluginDependencyCleanup(baselineSpec)) &&
    (scenario !== "acpx-openclaw-tools-bridge" ||
      supportsUpgradeSurvivorAcpToolsBridge(baselineSpec))
  );
}

function expandedUpgradeSurvivorLaneName(poolLaneName, baselineSpec, scenario) {
  const suffixParts = [
    baselineSpec ? sanitizeLaneNameSuffix(baselineSpec) : "",
    scenario && scenario !== "base" ? sanitizeLaneNameSuffix(scenario) : "",
  ].filter(Boolean);
  const suffix = suffixParts.join("-");
  return suffix ? `${poolLaneName}-${suffix}` : poolLaneName;
}

function expandUpgradeSurvivorBaselineLanes(
  poolLanes,
  rawBaselineSpecs,
  targetRoot,
  rawScenarios = "",
  allowExecutableContract = false,
) {
  const hasUpgradeSurvivorLane = poolLanes.some(
    (poolLane) =>
      poolLane.name === "published-upgrade-survivor" || poolLane.name === "update-migration",
  );
  if (!hasUpgradeSurvivorLane) {
    return { lanes: poolLanes, omittedLaneNames: [] };
  }
  const baselineSpecs = parseUpgradeSurvivorBaselineSpecs(rawBaselineSpecs);
  // Trusted-current planners may know scenarios that a frozen target's Docker
  // harness cannot seed or assert. Filter by the selected tree's concrete
  // harness contract so validation never schedules an impossible target lane.
  const configuredScenarios = parseUpgradeSurvivorScenarios(rawScenarios);
  const requestedScenarios = configuredScenarios.length > 0 ? configuredScenarios : ["base"];
  const supportedScenarios = filterUpgradeSurvivorScenariosForTarget(
    requestedScenarios,
    targetRoot,
    allowExecutableContract,
  );
  const supportedScenarioSet = new Set(supportedScenarios);
  const unsupportedScenarios = targetRoot
    ? requestedScenarios.filter((scenario) => !supportedScenarioSet.has(scenario))
    : [];
  const scenarios = configuredScenarios.length > 0 ? supportedScenarios : [];
  const matrixBaselines = baselineSpecs.length > 0 ? baselineSpecs : [undefined];
  const survivorLanes = poolLanes.filter(
    (poolLane) =>
      poolLane.name === "published-upgrade-survivor" || poolLane.name === "update-migration",
  );
  const omittedLaneNames = survivorLanes.flatMap((poolLane) =>
    matrixBaselines.flatMap((baselineSpec) =>
      unsupportedScenarios
        .filter((scenario) => supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec))
        .map((scenario) => expandedUpgradeSurvivorLaneName(poolLane.name, baselineSpec, scenario)),
    ),
  );
  if (supportedScenarios.length === 0 && unsupportedScenarios.length > 0) {
    return {
      lanes: poolLanes.filter(
        (poolLane) =>
          poolLane.name !== "published-upgrade-survivor" && poolLane.name !== "update-migration",
      ),
      omittedLaneNames,
    };
  }
  if (baselineSpecs.length === 0 && scenarios.length === 0) {
    return { lanes: poolLanes, omittedLaneNames };
  }
  return {
    lanes: poolLanes.flatMap((poolLane) => {
      if (poolLane.name !== "published-upgrade-survivor" && poolLane.name !== "update-migration") {
        return [poolLane];
      }
      const matrixScenarios = scenarios.length > 0 ? scenarios : [undefined];
      return matrixBaselines.flatMap((baselineSpec) =>
        matrixScenarios
          .filter((scenario) => supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec))
          .map((scenario) => {
            const name = expandedUpgradeSurvivorLaneName(poolLane.name, baselineSpec, scenario);
            const suffix = name.slice(poolLane.name.length + 1);
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
    }),
    omittedLaneNames,
  };
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
  return [...new Set(["docker", ...(poolLane.resources ?? [])])];
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
      undefined,
      process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
    ).lanes,
  ).find((poolLane) => poolLane.name === name);
}

function laneCredentialRequirements(poolLane) {
  const resources = laneResources(poolLane);
  const credentials = [];
  if (poolLane.name === "install-e2e-openai") {
    credentials.push("openai");
  }
  if (poolLane.name === "install-e2e-anthropic") {
    credentials.push("anthropic");
  }
  if (resources.includes("live:openai")) {
    credentials.push("openai");
  }
  if (resources.includes("live:codex")) {
    credentials.push("codex");
  }
  if (resources.includes("live:claude")) {
    credentials.push("anthropic");
  }
  if (resources.includes("live:droid")) {
    credentials.push("factory");
  }
  if (resources.includes("live:gemini")) {
    credentials.push("gemini");
  }
  if (resources.includes("live:opencode")) {
    credentials.push("opencode");
  }
  if (resources.includes("live:telegram")) {
    credentials.push("telegram");
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
    omittedUnsupportedLanes: params.omittedUnsupportedLaneNames,
    needs: {
      bareImage: imageKinds.includes("bare"),
      e2eImage: imageKinds.length > 0,
      functionalImage: imageKinds.includes("functional"),
      liveImage: scheduledLanes.some((poolLane) => poolLane.needsLiveImage),
      package: lanesNeedOpenClawPackage(scheduledLanes),
    },
    profile: params.profile,
    releaseProfile: params.releaseProfile,
    selectedLanes: params.selectedLaneNames,
    tailLanes: params.orderedTailLanes.map((poolLane) => poolLane.name),
    version: 1,
  };
}

export function resolveDockerE2ePlan(options) {
  const releaseProfile = normalizeReleaseProfile(options.releaseProfile);
  const retriedMainLanes = applyLiveRetries(mainLanes, options.liveRetries);
  const retriedTailLanes = applyLiveRetries(tailLanes, options.liveRetries);
  const upgradeSurvivorBaselines = options.upgradeSurvivorBaselines ?? "";
  const upgradeSurvivorScenarios = options.upgradeSurvivorScenarios ?? "";
  const unexpandedSelectableLanes = dedupeLanes([
    ...allReleasePathLanes({
      includeOpenWebUI: options.includeOpenWebUI,
      releaseProfile: "full",
    }),
    ...retriedMainLanes,
    ...retriedTailLanes,
  ]);
  const omittedUnsupportedLaneNames = new Set();
  const expandRequestedSurvivorLanes = (poolLanes) => {
    const expansion = expandUpgradeSurvivorBaselineLanes(
      poolLanes,
      upgradeSurvivorBaselines,
      options.upgradeSurvivorTargetRoot,
      upgradeSurvivorScenarios,
      options.allowFrozenTargetScenarioOmissions,
    );
    for (const laneName of expansion.omittedLaneNames) {
      omittedUnsupportedLaneNames.add(laneName);
    }
    return expansion.lanes;
  };
  const unfilteredSelectableLanes = dedupeLanes(
    expandUpgradeSurvivorBaselineLanes(
      unexpandedSelectableLanes,
      upgradeSurvivorBaselines,
      undefined,
      upgradeSurvivorScenarios,
    ).lanes,
  );
  // Selectable lanes are a target-agnostic lookup catalog. Frozen target
  // contracts are read only after a survivor lane is actually requested.
  const releaseLanes =
    options.selectedLaneNames.length === 0 && options.profile === RELEASE_PATH_PROFILE
      ? options.planReleaseAll
        ? expandRequestedSurvivorLanes(
            allReleasePathLanes({ includeOpenWebUI: options.includeOpenWebUI, releaseProfile }),
          )
        : expandRequestedSurvivorLanes(
            releasePathChunkLanes(options.releaseChunk, {
              includeOpenWebUI: options.includeOpenWebUI,
              releaseProfile,
            }),
          )
      : undefined;
  const selectedLanes =
    options.selectedLaneNames.length > 0
      ? options.selectedLaneNames.flatMap((selectedName) => {
          const unexpandedLane = unexpandedSelectableLanes.find(
            (poolLane) => poolLane.name === selectedName,
          );
          if (unexpandedLane) {
            return expandRequestedSurvivorLanes([unexpandedLane]);
          }
          const expandedLane = unfilteredSelectableLanes.find(
            (poolLane) => poolLane.name === selectedName,
          );
          if (expandedLane) {
            const survivorBaseLane = unexpandedSelectableLanes.find(
              (poolLane) =>
                (poolLane.name === "published-upgrade-survivor" ||
                  poolLane.name === "update-migration") &&
                selectedName.startsWith(`${poolLane.name}-`),
            );
            if (!survivorBaseLane) {
              return [expandedLane];
            }
            const targetExpansion = expandUpgradeSurvivorBaselineLanes(
              [survivorBaseLane],
              upgradeSurvivorBaselines,
              options.upgradeSurvivorTargetRoot,
              upgradeSurvivorScenarios,
              options.allowFrozenTargetScenarioOmissions,
            );
            const supportedLane = targetExpansion.lanes.find(
              (poolLane) => poolLane.name === selectedName,
            );
            if (supportedLane) {
              return [supportedLane];
            }
            omittedUnsupportedLaneNames.add(selectedName);
            return [];
          }
          selectNamedLanes(unfilteredSelectableLanes, [selectedName], "OPENCLAW_DOCKER_ALL_LANES");
          return [];
        })
      : undefined;
  const configuredLanes = selectedLanes
    ? selectedLanes
    : releaseLanes
      ? applyLiveMode(releaseLanes, options.liveMode)
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
    omittedUnsupportedLaneNames: [...omittedUnsupportedLaneNames],
    orderedLanes,
    orderedTailLanes,
    plan: buildPlanJson({
      includeOpenWebUI: options.includeOpenWebUI,
      omittedUnsupportedLaneNames: [...omittedUnsupportedLaneNames],
      orderedLanes,
      orderedTailLanes,
      profile: options.profile,
      releaseChunk: options.releaseChunk,
      releaseProfile,
      selectedLaneNames: options.selectedLaneNames,
    }),
    scheduledLanes: [...orderedLanes, ...orderedTailLanes],
  };
}
