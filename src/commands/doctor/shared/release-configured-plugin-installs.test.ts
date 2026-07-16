// Release configured plugin install tests cover doctor checks for release-time plugin installs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeRunConfiguredPluginInstallReleaseStep } from "./release-configured-plugin-installs.js";

const mocks = vi.hoisted(() => ({
  detectPluginAutoEnableCandidates: vi.fn(),
  getOfficialExternalPluginCatalogEntry: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
  resolveProviderInstallCatalogEntries: vi.fn(),
}));

type AutoEnableDetectionCall = {
  config: {
    agents?: {
      defaults?: {
        model?: string;
        agentRuntime?: { id?: string };
      };
    };
  };
};

type MissingPluginInstallRepairCall = {
  pluginIds: string[];
  channelIds?: string[];
  env?: NodeJS.ProcessEnv;
};

function readOnlyAutoEnableDetectionCall(): AutoEnableDetectionCall {
  expect(mocks.detectPluginAutoEnableCandidates).toHaveBeenCalledOnce();
  const calls = mocks.detectPluginAutoEnableCandidates.mock.calls as unknown as Array<
    [AutoEnableDetectionCall]
  >;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected auto-enable detection call");
  }
  return call;
}

function readOnlyMissingPluginInstallRepairCall(): MissingPluginInstallRepairCall {
  expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledOnce();
  const calls = mocks.repairMissingPluginInstallsForIds.mock.calls as unknown as Array<
    [MissingPluginInstallRepairCall]
  >;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected missing plugin install repair call");
  }
  return call;
}

async function shouldRunConfiguredPluginInstallReleaseStepThroughDoctor(params: {
  currentVersion?: string | null;
  touchedVersion?: string | null;
}): Promise<boolean> {
  const result = await maybeRunConfiguredPluginInstallReleaseStep({
    cfg: {},
    env: {},
    ...params,
  });
  return result.completed;
}

async function collectReleaseConfiguredPluginIdsThroughDoctor(params: {
  cfg: Parameters<typeof maybeRunConfiguredPluginInstallReleaseStep>[0]["cfg"];
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginIds: string[]; channelIds: string[] }> {
  mocks.repairMissingPluginInstallsForIds.mockClear();
  await maybeRunConfiguredPluginInstallReleaseStep({
    ...params,
    currentVersion: "2026.5.2",
    touchedVersion: "2026.5.1",
  });
  const calls = mocks.repairMissingPluginInstallsForIds.mock.calls as unknown as Array<
    [MissingPluginInstallRepairCall]
  >;
  const call = calls[0]?.[0];
  return {
    pluginIds: call?.pluginIds ?? [],
    channelIds: call?.channelIds ?? [],
  };
}

vi.mock("../../../config/plugin-auto-enable.js", () => ({
  detectPluginAutoEnableCandidates: mocks.detectPluginAutoEnableCandidates,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock(import("../../../plugins/official-external-plugin-catalog.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOfficialExternalPluginCatalogEntry: mocks.getOfficialExternalPluginCatalogEntry,
  };
});

vi.mock("./missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

describe("configured plugin install release step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectPluginAutoEnableCandidates.mockReturnValue([]);
    mocks.getOfficialExternalPluginCatalogEntry.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: [],
    });
  });

  it("runs only for configs last touched before 2026.5.2", async () => {
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.1",
        touchedVersion: "2026.4.30",
      }),
    ).toBe(false);
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.2-beta.1",
        touchedVersion: "2026.5.1",
      }),
    ).toBe(true);
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.2",
        touchedVersion: "2026.5.1",
      }),
    ).toBe(true);
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.2",
        touchedVersion: "2026.5.2",
      }),
    ).toBe(false);
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.3",
        touchedVersion: "2026.5.3",
      }),
    ).toBe(false);
    expect(
      await shouldRunConfiguredPluginInstallReleaseStepThroughDoctor({
        currentVersion: "2026.5.2",
        touchedVersion: "not-a-version",
      }),
    ).toBe(true);
  });

  it("collects used plugin ids without treating allow-only entries as usage", async () => {
    mocks.detectPluginAutoEnableCandidates.mockReturnValue([
      { pluginId: "matrix", kind: "channel-configured", channelId: "matrix" },
      { pluginId: "denied", kind: "setup-auto-enable", reason: "test" },
      { pluginId: "disabled-entry", kind: "setup-auto-enable", reason: "test" },
    ]);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "anthropic-provider",
        providerId: "anthropic",
      },
      {
        pluginId: "unused-provider",
        providerId: "unused",
      },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        auth: {
          profiles: {
            work: {
              provider: "anthropic",
              mode: "api_key",
            },
          },
        },
        channels: {
          wecom: { enabled: true },
          off: { enabled: false },
        },
        plugins: {
          allow: ["allow-only"],
          deny: ["denied"],
          slots: {
            memory: "memory-lancedb",
            contextEngine: "none",
          },
          entries: {
            configured: { config: { nested: true } },
            "disabled-entry": { enabled: false, config: { nested: true } },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual([
      "anthropic-provider",
      "configured",
      "matrix",
      "memory-lancedb",
    ]);
    expect(result.channelIds).toEqual(["wecom"]);
  });

  it("collects Codex from the configured agent runtime even without integration discovery", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            agentRuntime: { id: "codex" },
          },
        },
      },
      env: {},
    });

    const detectionCall = readOnlyAutoEnableDetectionCall();
    expect(detectionCall.config.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(detectionCall.config.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.pluginIds).toEqual(["codex"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects provider plugins from channel-only model overrides", async () => {
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "anthropic-provider",
        providerId: "anthropic",
      },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        channels: {
          modelByChannel: {
            discord: {
              default: "anthropic/claude-opus-4-7",
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["anthropic-provider"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects provider plugins from provider-keyed channel model aliases", async () => {
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "anthropic-provider",
        providerId: "anthropic",
      },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        channels: {
          modelByChannel: {
            anthropic: {
              discord: "claude-opus-4-7",
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["anthropic-provider"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects external speech and web-fetch plugins selected by config", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: {
          defaults: {
            model: "groq/llama-3.3-70b-versatile",
          },
        },
        messages: {
          tts: {
            provider: "gradium",
            providers: {
              inworld: {},
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["firecrawl", "gradium", "groq", "inworld"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects an external media-understanding plugin selected only by media config", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "groq", model: "whisper-large-v3-turbo" }],
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["groq"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects an external speech plugin selected only by voiceModel", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: {
          defaults: {
            voiceModel: { primary: "gradium/tts-default" },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["gradium"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects env-only web provider plugins before auto-detection", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {},
      env: {
        EXA_API_KEY: "exa-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
      },
    });

    expect(result.pluginIds).toEqual(["exa", "firecrawl"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("does not collect env-only web provider plugins when search is disabled", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        tools: {
          web: {
            search: {
              enabled: false,
            },
            fetch: {
              enabled: false,
            },
          },
        },
      },
      env: {
        EXA_API_KEY: "exa-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
      },
    });

    expect(result.pluginIds).toEqual([]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects Firecrawl for env-only web fetch when search is disabled", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        tools: {
          web: {
            search: {
              enabled: false,
            },
          },
        },
      },
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key",
      },
    });

    expect(result.pluginIds).toEqual(["firecrawl"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects env-only external provider plugins before model discovery", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {},
      env: {
        GROQ_API_KEY: "groq-key",
        MODELSTUDIO_API_KEY: "qwen-key",
      },
    });

    expect(result.pluginIds).toEqual(["groq", "qwen"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects provider plugins from documented external provider aliases", async () => {
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "gmi",
        providerId: "gmi",
        providerAliases: ["gmi-cloud", "gmicloud"],
      },
    ]);
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: {
          defaults: {
            model: "gmi-cloud/google/gemini-3.1-flash-lite",
          },
        },
        auth: {
          profiles: {
            gmi: {
              provider: "gmi-cloud",
              mode: "api_key",
            },
          },
        },
        models: {
          providers: {
            gmicloud: {
              baseUrl: "https://api.gmi-serving.com/v1",
              models: [],
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["gmi"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects Codex from selectable OpenAI agent models even without integration discovery", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["codex"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("collects external web search and ACP runtime plugins from config-only usage", async () => {
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        acp: {
          enabled: true,
          backend: "acpx",
        },
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["acpx", "brave"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("does not collect channel ids when the matching plugin id is blocked", async () => {
    expect(
      (
        await collectReleaseConfiguredPluginIdsThroughDoctor({
          cfg: {
            channels: {
              matrix: { accessToken: "test" },
            },
            plugins: {
              deny: ["matrix"],
            },
          },
          env: {},
        })
      ).channelIds,
    ).toStrictEqual([]);

    expect(
      (
        await collectReleaseConfiguredPluginIdsThroughDoctor({
          cfg: {
            channels: {
              matrix: { accessToken: "test" },
            },
            plugins: {
              entries: {
                matrix: { enabled: false },
              },
            },
          },
          env: {},
        })
      ).channelIds,
    ).toStrictEqual([]);
  });

  it("marks the release step complete when there is nothing to install", async () => {
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {},
      currentVersion: "2026.5.2",
      touchedVersion: "2026.5.1",
      env: {},
    });

    expect(mocks.repairMissingPluginInstallsForIds).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [],
      warnings: [],
      completed: true,
      touchedConfig: true,
    });
  });

  it("repairs used plugin installs and touches config only on success", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "codex".'],
      warnings: [],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            agentRuntime: { id: "codex" },
          },
        },
      },
      currentVersion: "2026.5.2-beta.1",
      touchedVersion: "2026.5.1",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toEqual(["codex"]);
    expect(repairCall.channelIds).toEqual([]);
    expect(repairCall.env).toEqual({});
    expect(result.touchedConfig).toBe(true);
    expect(result.completed).toBe(true);
  });

  it("surfaces non-fatal repair notices without blocking release repair completion", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "codex".'],
      warnings: [],
      notices: [reviewNotice],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            agentRuntime: { id: "codex" },
          },
        },
      },
      currentVersion: "2026.5.2-beta.1",
      touchedVersion: "2026.5.1",
      env: {},
    });

    expect(result).toEqual({
      changes: ['Installed missing configured plugin "codex".'],
      warnings: [reviewNotice],
      completed: true,
      touchedConfig: true,
    });
  });

  it("does not stamp config during update-time deferred install repair", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [
        'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      deferredRepairDetails: [
        'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            agentRuntime: { id: "codex" },
          },
        },
      },
      currentVersion: "2026.5.2-beta.1",
      touchedVersion: "2026.5.1",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toEqual(["codex"]);
    expect(repairCall.env).toEqual({
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
    });
    expect(result).toEqual({
      changes: [
        'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      completed: false,
      touchedConfig: false,
      postInstallDoctorResult: {
        status: "advisory",
        advisory: expect.objectContaining({
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          details: [
            'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
          ],
        }),
      },
    });
  });

  it("does not report an advisory for update-time repair changes that were not deferred", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Removed stale managed install record for bundled plugin "matrix".'],
      warnings: [],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        plugins: {
          entries: {
            matrix: { enabled: true },
          },
        },
      },
      currentVersion: "2026.5.2-beta.1",
      touchedVersion: "2026.5.1",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "matrix".'],
      warnings: [],
      completed: false,
      touchedConfig: false,
    });
  });

  it("defers package-manager plugin release completion for writable legacy parents", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      deferredRepairDetails: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      currentVersion: "2026.5.2-beta.1",
      touchedVersion: "2026.5.1",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    });

    expect(readOnlyMissingPluginInstallRepairCall().env).toEqual({
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    });
    expect(result).toEqual({
      changes: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      completed: false,
      touchedConfig: false,
      postInstallDoctorResult: {
        status: "advisory",
        advisory: expect.objectContaining({
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          details: [
            'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
          ],
        }),
      },
    });
  });

  it("repairs missing configured installs even when a prior update doctor touched config", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "discord".'],
      warnings: [],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      currentVersion: "2026.5.3-beta.1",
      touchedVersion: "2026.5.3-beta.1",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toEqual(["discord"]);
    expect(repairCall.channelIds).toEqual([]);
    expect(repairCall.env).toEqual({});
    expect(result).toEqual({
      changes: ['Installed missing configured plugin "discord".'],
      warnings: [],
      completed: true,
      touchedConfig: false,
    });
  });

  it("repairs same-id externalized channel installs from channel config after prior update writes", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured channel plugin "whatsapp".'],
      warnings: [],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
      },
      currentVersion: "2026.5.12",
      touchedVersion: "2026.5.12",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toEqual([]);
    expect(repairCall.channelIds).toEqual(["whatsapp"]);
    expect(result).toEqual({
      changes: ['Installed missing configured channel plugin "whatsapp".'],
      warnings: [],
      completed: true,
      touchedConfig: false,
    });
  });

  it("does not touch config when install repair warns", async () => {
    mocks.detectPluginAutoEnableCandidates.mockReturnValue([
      { pluginId: "matrix", kind: "channel-configured", channelId: "matrix" },
    ]);
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: ["install failed"],
    });
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: {},
      currentVersion: "2026.5.2",
      touchedVersion: "2026.5.1",
      env: {},
    });

    expect(result).toEqual({
      changes: [],
      warnings: ["install failed"],
      completed: false,
      touchedConfig: false,
    });
  });

  it("includes allow-only official plugin ids in the repair set", async () => {
    mocks.getOfficialExternalPluginCatalogEntry.mockImplementation((pluginId: string) => {
      if (pluginId === "lobster") {
        return { name: "@openclaw/lobster" };
      }
      return undefined;
    });
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        plugins: {
          allow: ["lobster", "unofficial-custom"],
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["lobster"]);
    expect(result.channelIds).toStrictEqual([]);
  });

  it("skips allow-only plugin ids that already have material plugin entries", async () => {
    mocks.getOfficialExternalPluginCatalogEntry.mockImplementation((pluginId: string) => {
      if (pluginId === "lobster") {
        return { name: "@openclaw/lobster" };
      }
      return undefined;
    });
    const result = await collectReleaseConfiguredPluginIdsThroughDoctor({
      cfg: {
        plugins: {
          allow: ["lobster"],
          entries: {
            lobster: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["lobster"]);
    expect(mocks.getOfficialExternalPluginCatalogEntry).not.toHaveBeenCalledWith("lobster");
  });
});
