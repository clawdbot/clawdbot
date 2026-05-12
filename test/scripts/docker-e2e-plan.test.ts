import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_RETRIES,
  RELEASE_PATH_PROFILE,
  parseLaneSelection,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mjs";
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "../../scripts/lib/docker-e2e-scenarios.mjs";

const orderLanes = <T>(lanes: T[]) => lanes;
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

function planFor(
  overrides: Partial<Parameters<typeof resolveDockerE2ePlan>[0]> = {},
): ReturnType<typeof resolveDockerE2ePlan>["plan"] {
  return resolveDockerE2ePlan({
    includeOpenWebUI: false,
    liveMode: "all",
    liveRetries: DEFAULT_LIVE_RETRIES,
    orderLanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: [],
    timingStore: undefined,
    ...overrides,
  }).plan;
}

function requireFirstLane(plan: ReturnType<typeof planFor>) {
  const [lane] = plan.lanes;
  if (!lane) {
    throw new Error("Expected at least one Docker E2E lane");
  }
  return lane;
}

function summarizeLane(lane: ReturnType<typeof planFor>["lanes"][number]) {
  return {
    command: lane.command,
    imageKind: lane.imageKind,
    live: lane.live,
    name: lane.name,
    resources: lane.resources,
    ...(lane.stateScenario ? { stateScenario: lane.stateScenario } : {}),
    ...(lane.timeoutMs !== undefined ? { timeoutMs: lane.timeoutMs } : {}),
    weight: lane.weight,
  };
}

function publishedUpgradeSurvivorLane(
  name: string,
  baselineSpec: string,
  scenario?: string,
): ReturnType<typeof summarizeLane> {
  return {
    command: `OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/${name}" OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='${baselineSpec}' ${
      scenario ? `OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='${scenario}' ` : ""
    }OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:published-upgrade-survivor`,
    imageKind: "bare",
    live: false,
    name,
    resources: ["docker", "npm"],
    stateScenario: "upgrade-survivor",
    timeoutMs: 1_500_000,
    weight: 3,
  };
}

function updateMigrationLane(name: string, baselineSpec: string): ReturnType<typeof summarizeLane> {
  return {
    command: `OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/${name}" OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='${baselineSpec}' OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='plugin-deps-cleanup' OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-migration`,
    imageKind: "bare",
    live: false,
    name,
    resources: ["docker", "npm"],
    stateScenario: "upgrade-survivor",
    timeoutMs: 1_800_000,
    weight: 3,
  };
}

function bundledPluginSweepLane(index: number): ReturnType<typeof summarizeLane> {
  return {
    command: `OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL=24 OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=${index} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-plugin-install-uninstall`,
    imageKind: "functional",
    live: false,
    name: `bundled-plugin-install-uninstall-${index}`,
    resources: ["docker", "npm"],
    stateScenario: "empty",
    weight: 1,
  };
}

describe("scripts/lib/docker-e2e-plan", () => {
  it("plans the full release path against package-backed e2e images", () => {
    const plan = planFor({
      includeOpenWebUI: false,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });

    expect(plan.needs).toEqual({
      bareImage: true,
      e2eImage: true,
      functionalImage: true,
      liveImage: true,
      package: true,
    });
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-openai");
    expect(plan.lanes.map((lane) => lane.name)).toContain("openai-chat-tools");
    expect(plan.lanes.map((lane) => lane.name)).toContain("codex-on-demand");
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-anthropic");
    expect(plan.lanes.map((lane) => lane.name)).toContain("mcp-channels");
    expect(plan.lanes.map((lane) => lane.name)).toContain("live-plugin-tool");
    expect(plan.lanes.map((lane) => lane.name)).toContain("commitments-safety");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-0");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-23");
    const countLane = (name: string) =>
      plan.lanes.reduce((count, lane) => count + (lane.name === name ? 1 : 0), 0);
    expect(countLane("install-e2e-openai")).toBe(1);
    expect(countLane("bundled-plugin-install-uninstall-0")).toBe(1);
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("bundled-plugin-install-uninstall");
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("bundled-channel-deps");
    expect(plan.lanes.map((lane) => lane.name)).not.toContain("openwebui");
  });

  it("plans Open WebUI only when release-path coverage requests it", () => {
    const withoutOpenWebUI = planFor({
      includeOpenWebUI: false,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });
    const withOpenWebUI = planFor({
      includeOpenWebUI: true,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });

    expect(withoutOpenWebUI.lanes.map((lane) => lane.name)).not.toContain("openwebui");
    expect(withOpenWebUI.lanes.map((lane) => lane.name)).toContain("openwebui");
  });

  it("keeps beta release-path coverage to install, provider, and update proof lanes", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
      releaseProfile: "beta",
    });

    const laneNames = plan.lanes.map((lane) => lane.name);
    expect(plan.releaseProfile).toBe("beta");
    expect(laneNames).toContain("install-e2e-openai");
    expect(laneNames).toContain("openai-chat-tools");
    expect(laneNames).toContain("install-e2e-anthropic");
    expect(laneNames).toContain("update-channel-switch");
    expect(laneNames).not.toContain("plugins");
    expect(laneNames).not.toContain("live-plugin-tool");
    expect(laneNames).not.toContain("bundled-plugin-install-uninstall-0");
    expect(laneNames).not.toContain("openwebui");
  });

  it("still allows explicit selected lanes outside the beta release profile", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseProfile: "beta",
      selectedLaneNames: ["live-plugin-tool"],
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual(["live-plugin-tool"]);
  });

  it("splits release-path package and plugin chunks across shorter CI jobs", () => {
    const packageInstallOpenAi = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "package-update-openai",
    });
    const packageInstallAnthropic = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "package-update-anthropic",
    });
    const packageUpdateCore = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "package-update-core",
    });
    const pluginsRuntimePlugins = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-plugins",
    });
    const pluginsRuntimeServices = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-services",
    });
    const pluginsRuntimeInstallA = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-a",
    });
    const pluginsRuntimeInstallB = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-b",
    });
    const pluginsRuntimeInstallC = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-c",
    });
    const pluginsRuntimeInstallD = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-d",
    });
    const pluginsRuntimeInstallE = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-e",
    });
    const pluginsRuntimeInstallF = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-f",
    });
    const pluginsRuntimeInstallG = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-g",
    });
    const pluginsRuntimeInstallH = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime-install-h",
    });

    expect(packageInstallOpenAi.lanes.map((lane) => lane.name)).toEqual([
      "install-e2e-openai",
      "openai-chat-tools",
      "codex-on-demand",
    ]);
    expect(packageInstallAnthropic.lanes.map((lane) => lane.name)).toEqual([
      "install-e2e-anthropic",
    ]);
    expect(packageUpdateCore.lanes.map(summarizeLane)).toEqual([
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
        imageKind: "bare",
        live: false,
        name: "npm-onboard-channel-agent",
        resources: ["docker", "npm", "service"],
        stateScenario: "empty",
        weight: 3,
      },
      {
        command:
          "OPENCLAW_NPM_ONBOARD_CHANNEL=discord OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
        imageKind: "bare",
        live: false,
        name: "npm-onboard-discord-channel-agent",
        resources: ["docker", "npm", "service"],
        stateScenario: "empty",
        weight: 3,
      },
      {
        command:
          "OPENCLAW_NPM_ONBOARD_CHANNEL=slack OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
        imageKind: "bare",
        live: false,
        name: "npm-onboard-slack-channel-agent",
        resources: ["docker", "npm", "service"],
        stateScenario: "empty",
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch",
        imageKind: "bare",
        live: false,
        name: "doctor-switch",
        resources: ["docker", "npm"],
        stateScenario: "empty",
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-channel-switch",
        imageKind: "bare",
        live: false,
        name: "update-channel-switch",
        resources: ["docker", "npm"],
        stateScenario: "update-stable",
        timeoutMs: 1_800_000,
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:skill-install",
        imageKind: "bare",
        live: false,
        name: "skill-install",
        resources: ["docker", "npm"],
        stateScenario: "empty",
        timeoutMs: 600_000,
        weight: 2,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:upgrade-survivor",
        imageKind: "bare",
        live: false,
        name: "upgrade-survivor",
        resources: ["docker", "npm"],
        stateScenario: "upgrade-survivor",
        timeoutMs: 1_200_000,
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:published-upgrade-survivor",
        imageKind: "bare",
        live: false,
        name: "published-upgrade-survivor",
        resources: ["docker", "npm"],
        stateScenario: "upgrade-survivor",
        timeoutMs: 1_500_000,
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-restart-auth",
        imageKind: "bare",
        live: false,
        name: "update-restart-auth",
        resources: ["docker", "npm"],
        stateScenario: "upgrade-survivor",
        timeoutMs: 1_500_000,
        weight: 3,
      },
    ]);
    expect(pluginsRuntimePlugins.lanes.map((lane) => lane.name)).toEqual(["plugins"]);
    expect(pluginsRuntimeServices.lanes.map(summarizeLane)).toEqual([
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
        imageKind: "functional",
        live: false,
        name: "cron-mcp-cleanup",
        resources: ["docker", "service", "npm"],
        stateScenario: "empty",
        weight: 3,
      },
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
        imageKind: "functional",
        live: false,
        name: "openai-web-search-minimal",
        resources: ["docker", "service"],
        stateScenario: "empty",
        timeoutMs: 480_000,
        weight: 2,
      },
      {
        command:
          "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-plugin-tool",
        imageKind: "bare",
        live: true,
        name: "live-plugin-tool",
        resources: ["docker", "live", "live:openai", "npm"],
        stateScenario: "empty",
        timeoutMs: 1_200_000,
        weight: 3,
      },
      {
        command:
          "OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini OPENWEBUI_SMOKE_MODE=models OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui",
        imageKind: "functional",
        live: true,
        name: "openwebui",
        resources: ["docker", "live", "live:openai", "service"],
        timeoutMs: 1_200_000,
        weight: 5,
      },
    ]);
    expect(pluginsRuntimePlugins.lanes.map((lane) => lane.name)).not.toContain(
      "bundled-plugin-install-uninstall-0",
    );
    expect(pluginsRuntimeInstallA.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-0",
      "bundled-plugin-install-uninstall-1",
      "bundled-plugin-install-uninstall-2",
    ]);
    expect(pluginsRuntimeInstallB.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-3",
      "bundled-plugin-install-uninstall-4",
      "bundled-plugin-install-uninstall-5",
    ]);
    expect(pluginsRuntimeInstallC.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-6",
      "bundled-plugin-install-uninstall-7",
      "bundled-plugin-install-uninstall-8",
    ]);
    expect(pluginsRuntimeInstallD.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-9",
      "bundled-plugin-install-uninstall-10",
      "bundled-plugin-install-uninstall-11",
    ]);
    expect(pluginsRuntimeInstallE.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-12",
      "bundled-plugin-install-uninstall-13",
      "bundled-plugin-install-uninstall-14",
    ]);
    expect(pluginsRuntimeInstallF.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-15",
      "bundled-plugin-install-uninstall-16",
      "bundled-plugin-install-uninstall-17",
    ]);
    expect(pluginsRuntimeInstallG.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-18",
      "bundled-plugin-install-uninstall-19",
      "bundled-plugin-install-uninstall-20",
    ]);
    expect(pluginsRuntimeInstallH.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-21",
      "bundled-plugin-install-uninstall-22",
      "bundled-plugin-install-uninstall-23",
    ]);
  });

  it("keeps planned pnpm docker lanes backed by package scripts", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });
    const scripts = packageJson.scripts ?? {};
    const missing = plan.lanes
      .flatMap((lane) =>
        Array.from(lane.command.matchAll(/\bpnpm\s+(test:docker:[\w:-]+)/gu), (match) => ({
          lane: lane.name,
          script: match[1],
        })),
      )
      .filter(({ script }) => !scripts[script]);

    expect(missing).toStrictEqual([]);
  });

  it("keeps legacy release chunk names as aggregate aliases", () => {
    const packageUpdate = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "package-update",
    });
    const pluginsRuntime = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-runtime",
    });
    const legacy = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "plugins-integrations",
    });

    const bundledPluginSweepLanes = Array.from(
      { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
      (_, index) => `bundled-plugin-install-uninstall-${index}`,
    );

    expect(packageUpdate.lanes.map((lane) => lane.name)).toEqual([
      "install-e2e-openai",
      "openai-chat-tools",
      "codex-on-demand",
      "install-e2e-anthropic",
      "npm-onboard-channel-agent",
      "npm-onboard-discord-channel-agent",
      "npm-onboard-slack-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "skill-install",
      "upgrade-survivor",
      "published-upgrade-survivor",
      "update-restart-auth",
    ]);
    expect(pluginsRuntime.lanes.map((lane) => lane.name)).toEqual([
      "plugins",
      ...bundledPluginSweepLanes,
      "cron-mcp-cleanup",
      "openai-web-search-minimal",
      "live-plugin-tool",
      "openwebui",
    ]);
    expect(legacy.lanes.map((lane) => lane.name)).toEqual([
      "plugins",
      ...bundledPluginSweepLanes,
      "cron-mcp-cleanup",
      "openai-web-search-minimal",
      "live-plugin-tool",
      "plugin-update",
      "openwebui",
    ]);
  });

  it("expands the published upgrade survivor lane across deduped baselines", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines:
        "openclaw@2026.4.29 2026.4.23 openclaw@2026.4.23 openclaw@2026.3.13-1",
    });

    expect(plan.lanes.map(summarizeLane)).toEqual([
      publishedUpgradeSurvivorLane("published-upgrade-survivor-2026.4.29", "openclaw@2026.4.29"),
      publishedUpgradeSurvivorLane("published-upgrade-survivor-2026.4.23", "openclaw@2026.4.23"),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.3.13-1",
        "openclaw@2026.3.13-1",
      ),
    ]);
  });

  it("expands the published upgrade survivor lane across scenarios", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.4.29 2026.4.23",
      upgradeSurvivorScenarios: "base feishu-channel tilde-log-path",
    });

    expect(plan.lanes.map(summarizeLane)).toEqual([
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.29",
        "openclaw@2026.4.29",
        "base",
      ),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.29-feishu-channel",
        "openclaw@2026.4.29",
        "feishu-channel",
      ),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.29-tilde-log-path",
        "openclaw@2026.4.29",
        "tilde-log-path",
      ),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.23",
        "openclaw@2026.4.23",
        "base",
      ),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.23-feishu-channel",
        "openclaw@2026.4.23",
        "feishu-channel",
      ),
      publishedUpgradeSurvivorLane(
        "published-upgrade-survivor-2026.4.23-tilde-log-path",
        "openclaw@2026.4.23",
        "tilde-log-path",
      ),
    ]);
  });

  it("expands reported upgrade issue scenarios", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.4.29",
      upgradeSurvivorScenarios: "reported-issues",
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "published-upgrade-survivor-2026.4.29",
      "published-upgrade-survivor-2026.4.29-feishu-channel",
      "published-upgrade-survivor-2026.4.29-bootstrap-persona",
      "published-upgrade-survivor-2026.4.29-plugin-deps-cleanup",
      "published-upgrade-survivor-2026.4.29-configured-plugin-installs",
      "published-upgrade-survivor-2026.4.29-stale-source-plugin-shadow",
      "published-upgrade-survivor-2026.4.29-tilde-log-path",
      "published-upgrade-survivor-2026.4.29-versioned-runtime-deps",
    ]);
  });

  it("skips plugin dependency cleanup for baselines without packaged plugin dirs", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.4.29 2026.3.13",
      upgradeSurvivorScenarios: "reported-issues",
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "published-upgrade-survivor-2026.4.29",
      "published-upgrade-survivor-2026.4.29-feishu-channel",
      "published-upgrade-survivor-2026.4.29-bootstrap-persona",
      "published-upgrade-survivor-2026.4.29-plugin-deps-cleanup",
      "published-upgrade-survivor-2026.4.29-configured-plugin-installs",
      "published-upgrade-survivor-2026.4.29-stale-source-plugin-shadow",
      "published-upgrade-survivor-2026.4.29-tilde-log-path",
      "published-upgrade-survivor-2026.4.29-versioned-runtime-deps",
      "published-upgrade-survivor-2026.3.13",
      "published-upgrade-survivor-2026.3.13-feishu-channel",
      "published-upgrade-survivor-2026.3.13-bootstrap-persona",
      "published-upgrade-survivor-2026.3.13-configured-plugin-installs",
      "published-upgrade-survivor-2026.3.13-stale-source-plugin-shadow",
      "published-upgrade-survivor-2026.3.13-tilde-log-path",
      "published-upgrade-survivor-2026.3.13-versioned-runtime-deps",
    ]);
  });

  it("expands update migration across baselines and cleanup scenarios", () => {
    const plan = planFor({
      selectedLaneNames: ["update-migration"],
      upgradeSurvivorBaselines: "2026.4.29 2026.4.23",
      upgradeSurvivorScenarios: "plugin-deps-cleanup",
    });

    expect(plan.lanes.map(summarizeLane)).toEqual([
      updateMigrationLane("update-migration-2026.4.29-plugin-deps-cleanup", "openclaw@2026.4.29"),
      updateMigrationLane("update-migration-2026.4.23-plugin-deps-cleanup", "openclaw@2026.4.23"),
    ]);
  });

  it("plans a live-only selected lane without package e2e images", () => {
    const plan = planFor({ selectedLaneNames: ["live-models"] });

    expect(plan.lanes.map((lane) => lane.name)).toEqual(["live-models"]);
    expect(plan.needs).toEqual({
      bareImage: false,
      e2eImage: false,
      functionalImage: false,
      liveImage: true,
      package: false,
    });
  });

  it("plans the Codex npm plugin live lane as package-backed OpenAI proof", () => {
    const plan = planFor({ selectedLaneNames: ["live-codex-npm-plugin"] });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes.map(summarizeLane)).toEqual([
      {
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-npm-plugin",
        imageKind: "bare",
        live: true,
        name: "live-codex-npm-plugin",
        resources: ["docker", "live", "live:openai", "npm"],
        stateScenario: "empty",
        timeoutMs: 1_800_000,
        weight: 3,
      },
    ]);
    expect(plan.needs).toEqual({
      bareImage: true,
      e2eImage: true,
      functionalImage: false,
      liveImage: true,
      package: true,
    });
  });

  it("plans the Codex on-demand onboarding lane as package-backed npm proof", () => {
    const plan = planFor({ selectedLaneNames: ["codex-on-demand"] });

    expect(plan.lanes).toHaveLength(1);
    const lane = requireFirstLane(plan);
    expect(lane.command).toBe("OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:codex-on-demand");
    expect(lane.imageKind).toBe("bare");
    expect(lane.live).toBe(false);
    expect(lane.name).toBe("codex-on-demand");
    expect(lane.resources).toEqual(["docker", "npm", "service"]);
    expect(lane.stateScenario).toBe("empty");
    expect(lane.timeoutMs).toBe(1_800_000);
    expect(plan.needs.bareImage).toBe(true);
    expect(plan.needs.package).toBe(true);
  });

  it("plans the live plugin tool lane as package-backed OpenAI proof", () => {
    const plan = planFor({ selectedLaneNames: ["live-plugin-tool"] });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes).toHaveLength(1);
    const lane = requireFirstLane(plan);
    expect(lane.command).toBe(
      "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-plugin-tool",
    );
    expect(lane.imageKind).toBe("bare");
    expect(lane.live).toBe(true);
    expect(lane.name).toBe("live-plugin-tool");
    expect(lane.resources).toEqual(["docker", "live", "live:openai", "npm"]);
    expect(lane.stateScenario).toBe("empty");
    expect(plan.needs.bareImage).toBe(true);
    expect(plan.needs.liveImage).toBe(true);
    expect(plan.needs.package).toBe(true);
  });

  it("plans Open WebUI as a live-auth functional image lane", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      selectedLaneNames: ["openwebui"],
    });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes.map(summarizeLane)).toEqual([
      {
        command:
          "OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini OPENWEBUI_SMOKE_MODE=models OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui",
        imageKind: "functional",
        live: true,
        name: "openwebui",
        resources: ["docker", "live", "live:openai", "service"],
        timeoutMs: 1_200_000,
        weight: 5,
      },
    ]);
    expect(plan.needs).toEqual({
      bareImage: false,
      e2eImage: true,
      functionalImage: true,
      liveImage: false,
      package: true,
    });
  });

  it("excludes Open WebUI from skip-live Docker all plans", () => {
    const plan = planFor({
      liveMode: "skip",
    });

    expect(plan.lanes.map((lane) => lane.name)).not.toContain("openwebui");
  });

  it("surfaces Docker lane test-state scenarios in plan JSON", () => {
    const plan = planFor({
      selectedLaneNames: [
        "onboard",
        "agents-delete-shared-workspace",
        "doctor-switch",
        "openai-image-auth",
        "openai-web-search-minimal",
        "mcp-channels",
        "cron-mcp-cleanup",
        "pi-bundle-mcp-tools",
        "crestodian-first-run",
        "crestodian-planner",
        "crestodian-rescue",
        "config-reload",
        "plugin-update",
        "plugins",
        "kitchen-sink-plugin",
        "bundled-plugin-install-uninstall-0",
        "commitments-safety",
        "update-channel-switch",
        "skill-install",
        "upgrade-survivor",
      ],
    });

    expect(
      plan.lanes.map((lane) => ({ name: lane.name, stateScenario: lane.stateScenario })),
    ).toEqual([
      { name: "onboard", stateScenario: "empty" },
      { name: "agents-delete-shared-workspace", stateScenario: "empty" },
      { name: "doctor-switch", stateScenario: "empty" },
      { name: "openai-image-auth", stateScenario: "empty" },
      { name: "openai-web-search-minimal", stateScenario: "empty" },
      { name: "mcp-channels", stateScenario: "empty" },
      { name: "cron-mcp-cleanup", stateScenario: "empty" },
      { name: "pi-bundle-mcp-tools", stateScenario: "empty" },
      { name: "crestodian-first-run", stateScenario: "empty" },
      { name: "crestodian-planner", stateScenario: "empty" },
      { name: "crestodian-rescue", stateScenario: "empty" },
      { name: "config-reload", stateScenario: "empty" },
      { name: "plugin-update", stateScenario: "empty" },
      { name: "plugins", stateScenario: "empty" },
      { name: "kitchen-sink-plugin", stateScenario: "empty" },
      { name: "bundled-plugin-install-uninstall-0", stateScenario: "empty" },
      { name: "commitments-safety", stateScenario: "empty" },
      { name: "update-channel-switch", stateScenario: "update-stable" },
      { name: "skill-install", stateScenario: "empty" },
      { name: "upgrade-survivor", stateScenario: "upgrade-survivor" },
    ]);
  });

  it("maps installer E2E to provider-specific package install lanes", () => {
    const selectedLaneNames = parseLaneSelection("install-e2e");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["install-e2e-openai", "install-e2e-anthropic"]);
    expect(plan.lanes.map(summarizeLane)).toEqual([
      {
        command:
          "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE=0 OPENCLAW_INSTALL_E2E_OPENAI_MODEL=openai/gpt-5.4-mini OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS=120 OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS=120 pnpm test:install:e2e",
        imageKind: "bare",
        live: false,
        name: "install-e2e-openai",
        resources: ["docker", "npm", "service"],
        timeoutMs: 900_000,
        weight: 3,
      },
      {
        command:
          "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local pnpm test:install:e2e",
        imageKind: "bare",
        live: false,
        name: "install-e2e-anthropic",
        resources: ["docker", "npm", "service"],
        weight: 3,
      },
    ]);
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
  });

  it("maps bundled plugin install/uninstall to package-backed shards", () => {
    const selectedLaneNames = parseLaneSelection("bundled-plugin-install-uninstall");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(
      Array.from(
        { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
        (_, index) => `bundled-plugin-install-uninstall-${index}`,
      ),
    );
    expect(plan.lanes).toHaveLength(BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS);
    const firstLane = plan.lanes[0];
    const lastLane = plan.lanes[23];
    if (!firstLane || !lastLane) {
      throw new Error("Expected bundled plugin sweep boundary lanes");
    }
    expect(summarizeLane(firstLane)).toEqual(bundledPluginSweepLane(0));
    expect(summarizeLane(lastLane)).toEqual(bundledPluginSweepLane(23));
    expect(plan.needs).toEqual({
      bareImage: false,
      e2eImage: true,
      functionalImage: true,
      liveImage: false,
      package: true,
    });
  });

  it("rejects unknown selected lanes with the available lane names", () => {
    expect(() => planFor({ selectedLaneNames: ["missing-lane"] })).toThrow(
      /OPENCLAW_DOCKER_ALL_LANES unknown lane\(s\): missing-lane/u,
    );
  });
});
