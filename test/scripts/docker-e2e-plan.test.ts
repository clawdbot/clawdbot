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

describe("scripts/lib/docker-e2e-plan", () => {
  it("plans the full release path against package-backed e2e images", () => {
    const plan = planFor({
      includeOpenWebUI: false,
      planReleaseAll: true,
      profile: RELEASE_PATH_PROFILE,
    });

    expect(plan.needs).toMatchObject({
      bareImage: true,
      e2eImage: true,
      functionalImage: true,
      liveImage: false,
      package: true,
    });
    expect(plan.credentials).toEqual(["anthropic", "openai"]);
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-openai");
    expect(plan.lanes.map((lane) => lane.name)).toContain("install-e2e-anthropic");
    expect(plan.lanes.map((lane) => lane.name)).toContain("mcp-channels");
    expect(plan.lanes.map((lane) => lane.name)).toContain("commitments-safety");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-0");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-23");
    expect(plan.lanes.filter((lane) => lane.name === "install-e2e-openai")).toHaveLength(1);
    expect(
      plan.lanes.filter((lane) => lane.name === "bundled-plugin-install-uninstall-0"),
    ).toHaveLength(1);
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

    expect(packageInstallOpenAi.lanes.map((lane) => lane.name)).toEqual(["install-e2e-openai"]);
    expect(packageInstallAnthropic.lanes.map((lane) => lane.name)).toEqual([
      "install-e2e-anthropic",
    ]);
    expect(packageUpdateCore.lanes.map((lane) => lane.name)).toEqual([
      "npm-onboard-channel-agent",
      "npm-onboard-discord-channel-agent",
      "npm-onboard-slack-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "upgrade-survivor",
      "published-upgrade-survivor",
      "update-restart-auth",
    ]);
    expect(packageUpdateCore.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "npm-onboard-channel-agent",
          stateScenario: "empty",
        }),
        expect.objectContaining({
          name: "npm-onboard-discord-channel-agent",
          stateScenario: "empty",
        }),
        expect.objectContaining({
          name: "npm-onboard-slack-channel-agent",
          stateScenario: "empty",
        }),
        expect.objectContaining({
          name: "doctor-switch",
          stateScenario: "empty",
        }),
        expect.objectContaining({
          name: "update-channel-switch",
          stateScenario: "update-stable",
        }),
        expect.objectContaining({
          name: "upgrade-survivor",
          command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:upgrade-survivor",
          stateScenario: "upgrade-survivor",
        }),
        expect.objectContaining({
          name: "published-upgrade-survivor",
          stateScenario: "upgrade-survivor",
        }),
        expect.objectContaining({
          name: "update-restart-auth",
          command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-restart-auth",
          stateScenario: "upgrade-survivor",
        }),
      ]),
    );
    expect(pluginsRuntimePlugins.lanes.map((lane) => lane.name)).toEqual(["plugins"]);
    expect(pluginsRuntimeServices.lanes.map((lane) => lane.name)).toEqual([
      "cron-mcp-cleanup",
      "openai-web-search-minimal",
      "openwebui",
    ]);
    expect(pluginsRuntimeServices.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "cron-mcp-cleanup",
          stateScenario: "empty",
        }),
      ]),
    );
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

    expect(missing).toEqual([]);
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

    expect(packageUpdate.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "install-e2e-openai",
        "install-e2e-anthropic",
        "update-channel-switch",
      ]),
    );
    expect(pluginsRuntime.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "plugins",
        "bundled-plugin-install-uninstall-0",
        "bundled-plugin-install-uninstall-23",
        "openwebui",
      ]),
    );
    expect(legacy.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining(["plugins", "bundled-plugin-install-uninstall-0", "openwebui"]),
    );
  });

  it("expands the published upgrade survivor lane across deduped baselines", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines:
        "openclaw@2026.4.29 2026.4.23 openclaw@2026.4.23 openclaw@2026.3.13-1",
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "published-upgrade-survivor-2026.4.29",
      "published-upgrade-survivor-2026.4.23",
      "published-upgrade-survivor-2026.3.13-1",
    ]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining(
          "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='openclaw@2026.4.29'",
        ),
        imageKind: "bare",
        stateScenario: "upgrade-survivor",
      }),
      expect.objectContaining({
        command: expect.stringContaining(
          "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='openclaw@2026.4.23'",
        ),
      }),
      expect.objectContaining({
        command: expect.stringContaining(
          "OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC='openclaw@2026.3.13-1'",
        ),
      }),
    ]);
    expect(plan.lanes[0]?.command).toContain(
      'OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/published-upgrade-survivor-2026.4.29"',
    );
  });

  it("expands the published upgrade survivor lane across scenarios", () => {
    const plan = planFor({
      selectedLaneNames: ["published-upgrade-survivor"],
      upgradeSurvivorBaselines: "2026.4.29 2026.4.23",
      upgradeSurvivorScenarios: "base feishu-channel tilde-log-path",
    });

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "published-upgrade-survivor-2026.4.29",
      "published-upgrade-survivor-2026.4.29-feishu-channel",
      "published-upgrade-survivor-2026.4.29-tilde-log-path",
      "published-upgrade-survivor-2026.4.23",
      "published-upgrade-survivor-2026.4.23-feishu-channel",
      "published-upgrade-survivor-2026.4.23-tilde-log-path",
    ]);
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='feishu-channel'"),
        }),
        expect.objectContaining({
          command: expect.stringContaining("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='tilde-log-path'"),
        }),
      ]),
    );
    expect(
      plan.lanes.find((lane) => lane.name === "published-upgrade-survivor-2026.4.29-tilde-log-path")
        ?.command,
    ).toContain(
      'OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR="$PWD/.artifacts/upgrade-survivor/published-upgrade-survivor-2026.4.29-tilde-log-path"',
    );
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

    expect(plan.lanes.map((lane) => lane.name)).toEqual([
      "update-migration-2026.4.29-plugin-deps-cleanup",
      "update-migration-2026.4.23-plugin-deps-cleanup",
    ]);
    expect(plan.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: expect.stringContaining("pnpm test:docker:update-migration"),
          imageKind: "bare",
          stateScenario: "upgrade-survivor",
        }),
        expect.objectContaining({
          command: expect.stringContaining(
            "OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='plugin-deps-cleanup'",
          ),
        }),
      ]),
    );
  });

  it("plans a live-only selected lane without package e2e images", () => {
    const plan = planFor({ selectedLaneNames: ["live-models"] });

    expect(plan.lanes.map((lane) => lane.name)).toEqual(["live-models"]);
    expect(plan.needs).toMatchObject({
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
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-npm-plugin",
        imageKind: "bare",
        live: true,
        name: "live-codex-npm-plugin",
        resources: ["docker", "live", "live:openai", "npm"],
        stateScenario: "empty",
      }),
    ]);
    expect(plan.needs).toMatchObject({
      bareImage: true,
      liveImage: true,
      package: true,
    });
  });

  it("plans Open WebUI as a live-auth functional image lane", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      selectedLaneNames: ["openwebui"],
    });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        imageKind: "functional",
        live: true,
        name: "openwebui",
        resources: expect.arrayContaining(["docker", "live", "live:openai", "service"]),
      }),
    ]);
    expect(plan.needs).toMatchObject({
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
        "upgrade-survivor",
      ],
    });

    expect(plan.lanes).toEqual([
      expect.objectContaining({
        name: "onboard",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "agents-delete-shared-workspace",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "doctor-switch",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "openai-image-auth",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "openai-web-search-minimal",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "mcp-channels",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "cron-mcp-cleanup",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "pi-bundle-mcp-tools",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "crestodian-first-run",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "crestodian-planner",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "crestodian-rescue",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "config-reload",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "plugin-update",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "plugins",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "kitchen-sink-plugin",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "bundled-plugin-install-uninstall-0",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "commitments-safety",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "update-channel-switch",
        stateScenario: "update-stable",
      }),
      expect.objectContaining({
        name: "upgrade-survivor",
        stateScenario: "upgrade-survivor",
      }),
    ]);
  });

  it("maps installer E2E to provider-specific package install lanes", () => {
    const selectedLaneNames = parseLaneSelection("install-e2e");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["install-e2e-openai", "install-e2e-anthropic"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_E2E_MODELS=openai"),
        name: "install-e2e-openai",
      }),
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_E2E_MODELS=anthropic"),
        name: "install-e2e-anthropic",
      }),
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
    expect(plan.lanes[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=0"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-0",
        resources: expect.arrayContaining(["docker", "npm"]),
      }),
    );
    expect(plan.lanes[23]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=23"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-23",
        resources: expect.arrayContaining(["docker", "npm"]),
      }),
    );
    expect(plan.needs).toMatchObject({
      functionalImage: true,
      package: true,
    });
  });

  it("rejects unknown selected lanes with the available lane names", () => {
    expect(() => planFor({ selectedLaneNames: ["missing-lane"] })).toThrow(
      /OPENCLAW_DOCKER_ALL_LANES unknown lane\(s\): missing-lane/u,
    );
  });
});
