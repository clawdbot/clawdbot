// Docker E2E scheduler planning helpers.
// This module turns the scenario catalog plus env-driven inputs into a concrete
// lane plan. It intentionally does not define scenario commands.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveUpgradeSurvivorConfigStepsForBaseline } from "../e2e/lib/upgrade-survivor/config-recipe.mts";
import {
  BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS,
  DEFAULT_LIVE_RETRIES,
  allReleasePathLanes,
  fleetCacheLane,
  mainLanes,
  normalizeReleaseProfile,
  publicInstallerLanes,
  releasePathChunkLanes,
  tailLanes,
  type DockerE2eImageKind,
  type DockerE2eLane,
  type DockerE2eReleaseProfile,
  type DockerE2eReleaseProfileInput,
} from "./docker-e2e-scenarios.mts";
import officialExternalChannelCatalog from "./official-external-channel-catalog.json" with { type: "json" };
import {
  isTrustedHarnessOwnedUpgradeSurvivorScenario,
  normalizeUpgradeSurvivorBaselineSpec,
  parseUpgradeSurvivorBaselineSpecs,
  parseUpgradeSurvivorScenarios,
  supportsUpgradeSurvivorScenarioAtBaseline,
} from "./upgrade-survivor-policy.mjs";

export { DEFAULT_LIVE_RETRIES };
export { normalizeReleaseProfile };
export { normalizeUpgradeSurvivorBaselineSpec };

export const DEFAULT_E2E_BARE_IMAGE = "openclaw-docker-e2e-bare:local";
export const DEFAULT_E2E_FUNCTIONAL_IMAGE = "openclaw-docker-e2e-functional:local";
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

type LiveMode = "all" | "only" | "skip";
type DockerProfile = typeof DEFAULT_PROFILE | typeof RELEASE_PATH_PROFILE;
type UpgradeSurvivorExpansion = { lanes: DockerE2eLane[]; omittedLaneNames: string[] };
const UPDATE_FIRST_HOP_COMPAT_OUTPUTS = ["shared-DTaQo6Hi.js", "shared-Y6bNiw2w.js"];
const IOS_WATCH_RELAY_COMMANDS = ['"watch.status"', '"watch.notify"'];
type DockerE2ePlanOptions = {
  allowFrozenTargetScenarioOmissions?: boolean;
  includeOpenWebUI: boolean;
  liveMode: LiveMode;
  liveRetries: number;
  orderLanes: (lanes: DockerE2eLane[], timingStore?: unknown) => DockerE2eLane[];
  planReleaseAll: boolean;
  profile: string;
  releaseChunk: string;
  releaseProfile?: DockerE2eReleaseProfileInput;
  selectedLaneNames: string[];
  timingStore?: unknown;
  upgradeSurvivorBaselines?: string;
  upgradeSurvivorScenarios?: string;
  upgradeSurvivorTargetRoot?: string;
};
export function parseLaneSelection(raw: string | undefined): string[] {
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
      raw
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .flatMap((token) => laneAliases.get(token) ?? [token]),
    ),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeLaneNameSuffix(value: string): string {
  return (
    value
      .replace(/^openclaw@/u, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "baseline"
  );
}

// Upgrade recipes select an OpenAI model whose runtime is supplied by the
// version-matched Codex companion after the candidate replaces the baseline.
const UPGRADE_SURVIVOR_RUNTIME_COMPANION_PACKAGES = ["@openclaw/codex"];

// Pre-protocol catalogs are content-addressed. Unknown legacy blocks fail
// closed instead of requiring a dependency or reimplementing a JavaScript parser.
const LEGACY_UPGRADE_SURVIVOR_SCENARIO_CATALOGS = new Map([
  [
    "6b80d370ff2cad1c122700264ddecdf392fb9957112a3b107dc5c9c9731b6646",
    "base abandoned-update legacy-operator-state mobile-pairing-reconnect acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume recovery-cleanup auth-profile-v2026-7-2-beta-5 watchos-direct-node",
  ],
  [
    "9c3b79d2fc1317a9b8033f59cb6ae350aebf8bd6ec9575d9704ed8d4b34b210d",
    "base legacy-operator-state mobile-pairing-reconnect acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume recovery-cleanup auth-profile-v2026-7-2-beta-5 watchos-direct-node",
  ],
  [
    "28758bbf9d4069d9718fb3325c59ad66a3bc6880248c104aa71b0d7769c54ba3",
    "base mobile-pairing-reconnect acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume recovery-cleanup auth-profile-v2026-7-2-beta-5 watchos-direct-node",
  ],
  [
    "dd12482a81dc5cc82dbb23f1cf3128321ec97a2176673c34adecbeed18d00484",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume recovery-cleanup auth-profile-v2026-7-2-beta-5 watchos-direct-node",
  ],
  [
    "bb984a8abf8e4f5a5caaa0c6e10fc36efb6a05ca9f44fb960e4a6583cd52695d",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume recovery-cleanup auth-profile-v2026-7-2-beta-5",
  ],
  [
    "f886fb3ca6232eb97cdfe93a9ab7fc8e8cd4a39658c5518bfb736a2242d0c949",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow prerelease-plugin-registry tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume auth-profile-v2026-7-2-beta-5",
  ],
  [
    "0c5d3ce3533c035033890923aae7e210f4fdb24e7b8af32371930cdf12a00fd5",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority sqlite-volume auth-profile-v2026-7-2-beta-5",
  ],
  [
    "837ab1c89821d52519f385e0f3d2067e0b923f730e3a4791e67f578bf5d29f8e",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority auth-profile-v2026-7-2-beta-5",
  ],
  [
    "10ea475027d8b320d6a704cd6e4dd0f7e984c57a93b327048db229a7e0132c8a",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps cron-scheduled-authority",
  ],
  [
    "213e004a28814fe0f7bb33018ae59a709c2e6d6e13b273df82a0e7935fbaf5af",
    "base acpx-openclaw-tools-bridge feishu-channel bootstrap-persona channel-post-core-restore codex-allowlist-survival plugin-deps-cleanup configured-plugin-installs stale-source-plugin-shadow tilde-log-path meeting-transcripts-sqlite versioned-runtime-deps",
  ],
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

function readLegacyFrozenScenarioContract(assertionsFile: string): string[] | undefined {
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

function readFrozenScenarioContract(
  assertionsFile: string,
  targetRoot: string,
  allowExecutableContract: boolean,
): string[] {
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
  let parsed: unknown;
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

function filterUpgradeSurvivorScenariosForTarget(
  scenarios: string[],
  targetRoot: string | undefined,
  allowExecutableContract: boolean,
): string[] {
  if (!targetRoot) {
    return scenarios;
  }
  const targetOwnedScenarios = scenarios.filter(
    (scenario) => !isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario),
  );
  if (targetOwnedScenarios.length === 0) {
    return scenarios;
  }
  const assertionsFile = resolve(targetRoot, "scripts/e2e/lib/upgrade-survivor/assertions.mjs");
  if (!existsSync(assertionsFile)) {
    return scenarios.filter(isTrustedHarnessOwnedUpgradeSurvivorScenario);
  }
  const targetScenarios = readFrozenScenarioContract(
    assertionsFile,
    targetRoot,
    allowExecutableContract,
  );
  const supportedScenarios = new Set(targetScenarios);
  return scenarios.filter(
    (scenario) =>
      isTrustedHarnessOwnedUpgradeSurvivorScenario(scenario) || supportedScenarios.has(scenario),
  );
}

function supportsUpdateFirstHopCompatForTarget(targetRoot: string | undefined): boolean {
  if (!targetRoot) {
    return true;
  }
  const runtimePostbuild = resolve(targetRoot, "scripts/runtime-postbuild.mts");
  if (!existsSync(runtimePostbuild)) {
    return false;
  }
  const source = readFileSync(runtimePostbuild, "utf8");
  return UPDATE_FIRST_HOP_COMPAT_OUTPUTS.every((name) => source.includes(`dest: "dist/${name}"`));
}

function supportsMobilePairingReconnectForTarget(targetRoot: string | undefined): boolean {
  if (!targetRoot) {
    return true;
  }
  const policy = resolve(targetRoot, "src/gateway/node-command-policy.ts");
  if (!existsSync(policy)) {
    return false;
  }
  const source = readFileSync(policy, "utf8");
  return (
    IOS_WATCH_RELAY_COMMANDS.every((command) => source.includes(command)) &&
    source.includes('platformId === "ios"') &&
    source.includes('normalizeDeviceMetadataForPolicy(node?.deviceFamily) === "iphone"') &&
    source.includes("...watchRelayCommands")
  );
}

function expandedUpgradeSurvivorLaneName(
  poolLaneName: string,
  baselineSpec: string | undefined,
  scenario: string | undefined,
) {
  const suffixParts = [
    baselineSpec ? sanitizeLaneNameSuffix(baselineSpec) : "",
    scenario && scenario !== "base" ? sanitizeLaneNameSuffix(scenario) : "",
  ].filter(Boolean);
  const suffix = suffixParts.join("-");
  return suffix ? `${poolLaneName}-${suffix}` : poolLaneName;
}

function expandUpgradeSurvivorBaselineLanes(
  poolLanes: DockerE2eLane[],
  rawBaselineSpecs: string | undefined,
  targetRoot: string | undefined,
  rawScenarios = "",
  allowExecutableContract = false,
): UpgradeSurvivorExpansion {
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

function dedupeLanes(poolLanes: DockerE2eLane[]): DockerE2eLane[] {
  const byName = new Map<string, DockerE2eLane>();
  for (const poolLane of poolLanes) {
    if (!byName.has(poolLane.name)) {
      byName.set(poolLane.name, poolLane);
    }
  }
  return [...byName.values()];
}

function selectNamedLanes(
  poolLanes: DockerE2eLane[],
  selectedNames: string[],
  label: string,
): DockerE2eLane[] {
  const byName = new Map(poolLanes.map((poolLane) => [poolLane.name, poolLane]));
  const missing = selectedNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${label} unknown lane(s): ${missing.join(", ")}. Available lanes: ${[...byName.keys()]
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}`,
    );
  }
  return selectedNames.map((name) => byName.get(name)!);
}

export function parseLiveMode(raw: unknown): LiveMode {
  const mode = raw || "all";
  if (mode === "all" || mode === "skip" || mode === "only") {
    return mode;
  }
  throw new Error(
    `OPENCLAW_DOCKER_ALL_LIVE_MODE must be one of: all, skip, only. Got: ${JSON.stringify(raw)}`,
  );
}

export function parseProfile(raw: unknown): DockerProfile {
  const profile = raw || DEFAULT_PROFILE;
  if (profile === DEFAULT_PROFILE || profile === RELEASE_PATH_PROFILE) {
    return profile;
  }
  throw new Error(
    `OPENCLAW_DOCKER_ALL_PROFILE must be one of: ${DEFAULT_PROFILE}, ${RELEASE_PATH_PROFILE}. Got: ${JSON.stringify(raw)}`,
  );
}

function applyLiveMode(poolLanes: DockerE2eLane[], mode: LiveMode): DockerE2eLane[] {
  if (mode === "all") {
    return poolLanes;
  }
  return poolLanes.filter((poolLane) => (mode === "only" ? poolLane.live : !poolLane.live));
}

function applyLiveRetries(poolLanes: DockerE2eLane[], retries: number): DockerE2eLane[] {
  return poolLanes.map((poolLane) => (poolLane.live ? { ...poolLane, retries } : poolLane));
}

export function laneWeight(poolLane: DockerE2eLane): number {
  return Math.max(1, poolLane.weight ?? 1);
}

export function laneResources(poolLane: DockerE2eLane): string[] {
  return [...new Set(["docker", ...(poolLane.resources ?? [])])];
}

export function laneSummary(poolLane: DockerE2eLane): string {
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

export function lanesNeedE2eImageKind(
  poolLanes: DockerE2eLane[],
  kind: DockerE2eImageKind,
): boolean {
  return poolLanes.some((poolLane) => poolLane.e2eImageKind === kind);
}

export function lanesNeedOpenClawPackage(poolLanes: DockerE2eLane[]): boolean {
  return poolLanes.some((poolLane) => poolLane.needsPackage || poolLane.e2eImageKind);
}

export function findLaneByName(name: string): DockerE2eLane | undefined {
  return dedupeLanes(
    expandUpgradeSurvivorBaselineLanes(
      [
        ...allReleasePathLanes({ includeOpenWebUI: true }),
        ...publicInstallerLanes,
        fleetCacheLane,
        ...mainLanes,
        ...tailLanes,
      ],
      process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS,
      undefined,
      process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
    ).lanes,
  ).find((poolLane) => poolLane.name === name);
}

function laneCredentialRequirements(poolLane: DockerE2eLane): string[] {
  const resources = laneResources(poolLane);
  const credentials: string[] = [];
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

function unique<T>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value != null))];
}

function upgradeSurvivorScenarioForLane(poolLane: DockerE2eLane): string | undefined {
  if (!poolLane.upgradeSurvivorScenario) {
    return undefined;
  }
  const match = /(?:^|\s)OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=(?:'([^']+)'|"([^"]+)"|([^\s]+))/u.exec(
    poolLane.command,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? poolLane.upgradeSurvivorScenario;
}

function upgradeSurvivorBaselineVersionForLane(poolLane: DockerE2eLane): string | null {
  const match =
    /(?:^|\s)OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=(?:'([^']+)'|"([^"]+)"|([^\s]+))/u.exec(
      poolLane.command,
    );
  const spec = match?.[1] ?? match?.[2] ?? match?.[3];
  return /(?:^|\/|@)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(spec ?? "")?.[1] ?? null;
}

export function requiredPrepublishPluginPackagesForLanes(poolLanes: DockerE2eLane[]): string[] {
  const configuredChannelIds = new Set<string>();
  const requiredPackages = new Set<string>();
  for (const poolLane of poolLanes) {
    for (const packageName of poolLane.prepublishPluginPackages ?? []) {
      requiredPackages.add(packageName);
    }
    const scenario = upgradeSurvivorScenarioForLane(poolLane);
    if (!scenario || scenario === "abandoned-update") {
      continue;
    }
    if (scenario === "legacy-operator-state") {
      requiredPackages.add("@openclaw/discord");
      requiredPackages.add("@openclaw/duckduckgo-plugin");
      continue;
    }
    for (const packageName of UPGRADE_SURVIVOR_RUNTIME_COMPANION_PACKAGES) {
      requiredPackages.add(packageName);
    }
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline(
      scenario,
      upgradeSurvivorBaselineVersionForLane(poolLane),
    );
    for (const step of steps) {
      for (const packageName of step.prepublishPluginPackages ?? []) {
        requiredPackages.add(packageName);
      }
      if (step.argv[0] !== "config" || step.argv[1] !== "set") {
        continue;
      }
      const channelId = /^channels\.([a-z0-9][a-z0-9-]*)$/u.exec(step.argv[2] ?? "")?.[1];
      if (channelId) {
        configuredChannelIds.add(channelId);
      }
    }
  }
  for (const packageName of (officialExternalChannelCatalog.entries ?? [])
    .filter((entry) => {
      const channelId = entry.openclaw?.channel?.id;
      const install = entry.openclaw?.install;
      return (
        typeof entry.name === "string" &&
        configuredChannelIds.has(channelId) &&
        install?.npmSpec === entry.name
      );
    })
    .map((entry) => entry.name)) {
    requiredPackages.add(packageName);
  }
  return [...requiredPackages].toSorted((a, b) => a.localeCompare(b));
}

function buildPlanJson(params: {
  includeOpenWebUI: boolean;
  omittedUnsupportedLaneNames: string[];
  orderedLanes: DockerE2eLane[];
  orderedTailLanes: DockerE2eLane[];
  profile: string;
  releaseChunk: string;
  releaseProfile: DockerE2eReleaseProfile;
  selectedLaneNames: string[];
}) {
  const scheduledLanes = [...params.orderedLanes, ...params.orderedTailLanes];
  const imageKinds = unique(scheduledLanes.map((poolLane) => poolLane.e2eImageKind)).toSorted(
    (a, b) => a.localeCompare(b),
  );
  const requiredPrepublishPluginPackages = requiredPrepublishPluginPackagesForLanes(scheduledLanes);
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
    requiredPrepublishPluginPackages,
    needs: {
      bareImage: imageKinds.includes("bare"),
      e2eImage: imageKinds.length > 0,
      functionalImage: imageKinds.includes("functional"),
      liveImage: scheduledLanes.some((poolLane) => poolLane.needsLiveImage),
      package: lanesNeedOpenClawPackage(scheduledLanes),
      prepublishPluginRegistry: requiredPrepublishPluginPackages.length > 0,
    },
    profile: params.profile,
    releaseProfile: params.releaseProfile,
    selectedLanes: params.selectedLaneNames,
    tailLanes: params.orderedTailLanes.map((poolLane) => poolLane.name),
    version: 1,
  };
}

export function resolveDockerE2ePlan(options: DockerE2ePlanOptions) {
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
    ...publicInstallerLanes,
    fleetCacheLane,
    ...retriedMainLanes,
    ...retriedTailLanes,
  ]);
  const omittedUnsupportedLaneNames = new Set<string>();
  const expandRequestedSurvivorLanes = (poolLanes: DockerE2eLane[]) => {
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
  let configuredLanes = selectedLanes
    ? selectedLanes
    : releaseLanes
      ? applyLiveMode(releaseLanes, options.liveMode)
      : options.liveMode === "only"
        ? applyLiveMode([...retriedMainLanes, ...retriedTailLanes], options.liveMode)
        : applyLiveMode(retriedMainLanes, options.liveMode);
  if (
    options.allowFrozenTargetScenarioOmissions &&
    !supportsUpdateFirstHopCompatForTarget(options.upgradeSurvivorTargetRoot)
  ) {
    const filteredLanes = configuredLanes.filter((lane) => lane.name !== "update-first-hop-compat");
    if (filteredLanes.length !== configuredLanes.length) {
      omittedUnsupportedLaneNames.add("update-first-hop-compat");
      configuredLanes = filteredLanes;
    }
  }
  if (
    options.allowFrozenTargetScenarioOmissions &&
    !supportsMobilePairingReconnectForTarget(options.upgradeSurvivorTargetRoot)
  ) {
    const filteredLanes = configuredLanes.filter(
      (lane) => !lane.name.includes("mobile-pairing-reconnect"),
    );
    if (filteredLanes.length !== configuredLanes.length) {
      for (const lane of configuredLanes) {
        if (lane.name.includes("mobile-pairing-reconnect")) {
          omittedUnsupportedLaneNames.add(lane.name);
        }
      }
      configuredLanes = filteredLanes;
    }
  }
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
