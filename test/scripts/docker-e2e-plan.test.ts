import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_RETRIES,
  RELEASE_PATH_PROFILE,
  parseLaneSelection,
  resolveDockerE2ePlan,
} from "../../scripts/lib/docker-e2e-plan.mjs";

const orderLanes = <T>(lanes: T[]) => lanes;

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
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-channel-feishu");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-channel-update-acpx");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-0");
    expect(plan.lanes.map((lane) => lane.name)).toContain("bundled-plugin-install-uninstall-7");
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
    const bundledChannelsCore = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-core",
    });
    const bundledChannelsUpdateA = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-update-a",
    });
    const bundledChannelsUpdateDiscord = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-update-discord",
    });
    const bundledChannelsUpdateB = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-update-b",
    });
    const bundledChannelsContracts = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-contracts",
    });

    expect(packageInstallOpenAi.lanes.map((lane) => lane.name)).toEqual(["install-e2e-openai"]);
    expect(packageInstallAnthropic.lanes.map((lane) => lane.name)).toEqual([
      "install-e2e-anthropic",
    ]);
    expect(packageUpdateCore.lanes.map((lane) => lane.name)).toEqual([
      "npm-onboard-channel-agent",
      "doctor-switch",
      "update-channel-switch",
    ]);
    expect(packageUpdateCore.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "npm-onboard-channel-agent",
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
    ]);
    expect(pluginsRuntimeInstallB.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-2",
      "bundled-plugin-install-uninstall-3",
    ]);
    expect(pluginsRuntimeInstallC.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-4",
      "bundled-plugin-install-uninstall-5",
    ]);
    expect(pluginsRuntimeInstallD.lanes.map((lane) => lane.name)).toEqual([
      "bundled-plugin-install-uninstall-6",
      "bundled-plugin-install-uninstall-7",
    ]);
    expect(bundledChannelsCore.lanes.map((lane) => lane.name)).toEqual([
      "plugin-update",
      "bundled-channel-telegram",
      "bundled-channel-discord",
      "bundled-channel-slack",
      "bundled-channel-feishu",
      "bundled-channel-memory-lancedb",
    ]);
    expect(bundledChannelsCore.lanes[0]).toMatchObject({
      name: "plugin-update",
      stateScenario: "empty",
    });
    expect(bundledChannelsUpdateA.lanes.map((lane) => lane.name)).toEqual([
      "bundled-channel-update-telegram",
      "bundled-channel-update-memory-lancedb",
    ]);
    expect(bundledChannelsUpdateDiscord.lanes.map((lane) => lane.name)).toEqual([
      "bundled-channel-update-discord",
    ]);
    expect(bundledChannelsUpdateDiscord.lanes[0]).toMatchObject({
      noOutputTimeoutMs: 4 * 60 * 1000,
      timeoutMs: 6 * 60 * 1000,
    });
    expect(bundledChannelsUpdateB.lanes.map((lane) => lane.name)).toEqual([
      "bundled-channel-update-slack",
      "bundled-channel-update-feishu",
      "bundled-channel-update-acpx",
    ]);
    expect(bundledChannelsContracts.lanes.map((lane) => lane.name)).toEqual([
      "bundled-channel-root-owned",
      "bundled-channel-setup-entry",
      "bundled-channel-load-failure",
      "bundled-channel-disabled-config",
    ]);
    expect(bundledChannelsCore.lanes.map((lane) => lane.name)).not.toContain("plugins");
    expect(bundledChannelsUpdateA.lanes.map((lane) => lane.name)).not.toContain("openwebui");
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
    const bundledChannelsUpdateALegacy = planFor({
      includeOpenWebUI: true,
      profile: RELEASE_PATH_PROFILE,
      releaseChunk: "bundled-channels-update-a-legacy",
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
        "bundled-plugin-install-uninstall-7",
        "openwebui",
      ]),
    );
    expect(bundledChannelsUpdateALegacy.lanes.map((lane) => lane.name)).toEqual([
      "bundled-channel-update-telegram",
      "bundled-channel-update-discord",
      "bundled-channel-update-memory-lancedb",
    ]);
    expect(legacy.lanes.map((lane) => lane.name)).toEqual(
      expect.arrayContaining([
        "plugins",
        "bundled-plugin-install-uninstall-0",
        "plugin-update",
        "bundled-channel-update-acpx",
        "openwebui",
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

  it("plans Open WebUI as a functional-image lane with OpenAI credentials", () => {
    const plan = planFor({
      includeOpenWebUI: true,
      selectedLaneNames: ["openwebui"],
    });

    expect(plan.credentials).toEqual(["openai"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        imageKind: "functional",
        live: false,
        name: "openwebui",
      }),
    ]);
    expect(plan.needs).toMatchObject({
      functionalImage: true,
      package: true,
    });
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
        "bundled-channel-deps-compat",
        "bundled-channel-setup-entry",
        "bundled-plugin-install-uninstall-0",
        "update-channel-switch",
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
        name: "bundled-channel-deps-compat",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "bundled-channel-setup-entry",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "bundled-plugin-install-uninstall-0",
        stateScenario: "empty",
      }),
      expect.objectContaining({
        name: "update-channel-switch",
        stateScenario: "update-stable",
      }),
    ]);
  });

  it("maps the legacy bundled channel deps lane to the split compat lane", () => {
    const selectedLaneNames = parseLaneSelection("bundled-channel-deps");
    const plan = planFor({ selectedLaneNames });

    expect(selectedLaneNames).toEqual(["bundled-channel-deps-compat"]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        imageKind: "bare",
        name: "bundled-channel-deps-compat",
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
      Array.from({ length: 8 }, (_, index) => `bundled-plugin-install-uninstall-${index}`),
    );
    expect(plan.lanes).toHaveLength(8);
    expect(plan.lanes[0]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=0"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-0",
        resources: expect.arrayContaining(["docker", "npm"]),
      }),
    );
    expect(plan.lanes[7]).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=7"),
        imageKind: "functional",
        live: false,
        name: "bundled-plugin-install-uninstall-7",
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
