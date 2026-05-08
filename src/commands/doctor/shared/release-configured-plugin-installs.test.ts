import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectPluginAutoEnableCandidates: vi.fn(),
  getOfficialExternalPluginCatalogEntry: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
  resolveProviderInstallCatalogEntries: vi.fn(),
}));

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
    const { shouldRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");

    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
        currentVersion: "2026.5.1",
        touchedVersion: "2026.4.30",
      }),
    ).toBe(false);
    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
        currentVersion: "2026.5.2-beta.1",
        touchedVersion: "2026.5.1",
      }),
    ).toBe(true);
    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
        currentVersion: "2026.5.2",
        touchedVersion: "2026.5.1",
      }),
    ).toBe(true);
    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
        currentVersion: "2026.5.2",
        touchedVersion: "2026.5.2",
      }),
    ).toBe(false);
    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
        currentVersion: "2026.5.3",
        touchedVersion: "2026.5.3",
      }),
    ).toBe(false);
    expect(
      shouldRunConfiguredPluginInstallReleaseStep({
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

    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");
    const result = collectReleaseConfiguredPluginIds({
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
    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");
    const result = collectReleaseConfiguredPluginIds({
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

    expect(mocks.detectPluginAutoEnableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: "openai/gpt-5.4",
              agentRuntime: { id: "codex" },
            }),
          }),
        }),
      }),
    );
    expect(result.pluginIds).toEqual(["codex"]);
    expect(result.channelIds).toEqual([]);
  });

  it("collects external web search and ACP runtime plugins from config-only usage", async () => {
    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");
    const result = collectReleaseConfiguredPluginIds({
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
    expect(result.channelIds).toEqual([]);
  });

  it("does not collect channel ids when the matching plugin id is blocked", async () => {
    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");

    expect(
      collectReleaseConfiguredPluginIds({
        cfg: {
          channels: {
            matrix: { accessToken: "test" },
          },
          plugins: {
            deny: ["matrix"],
          },
        },
        env: {},
      }).channelIds,
    ).toEqual([]);

    expect(
      collectReleaseConfiguredPluginIds({
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
      }).channelIds,
    ).toEqual([]);
  });

  it("marks the release step complete when there is nothing to install", async () => {
    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");
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

    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");
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

    expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["codex"],
        channelIds: [],
        env: {},
      }),
    );
    expect(result.touchedConfig).toBe(true);
    expect(result.completed).toBe(true);
  });

  it("does not stamp config during update-time deferred install repair", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [
        'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
    });

    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");
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
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });

    expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["codex"],
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      }),
    );
    expect(result).toEqual({
      changes: [
        'Skipped package-manager repair for configured plugin "codex" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      completed: false,
      touchedConfig: false,
    });
  });

  it("repairs missing configured installs even when a prior update doctor touched config", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "discord".'],
      warnings: [],
    });

    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");
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

    expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["discord"],
        channelIds: [],
        env: {},
      }),
    );
    expect(result).toEqual({
      changes: ['Installed missing configured plugin "discord".'],
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

    const { maybeRunConfiguredPluginInstallReleaseStep } =
      await import("./release-configured-plugin-installs.js");
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

    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");
    const result = collectReleaseConfiguredPluginIds({
      cfg: {
        plugins: {
          allow: ["lobster", "unofficial-custom"],
        },
      },
      env: {},
    });

    expect(result.pluginIds).toEqual(["lobster"]);
    expect(result.channelIds).toEqual([]);
  });

  it("skips allow-only plugin ids that already have material plugin entries", async () => {
    mocks.getOfficialExternalPluginCatalogEntry.mockImplementation((pluginId: string) => {
      if (pluginId === "lobster") {
        return { name: "@openclaw/lobster" };
      }
      return undefined;
    });

    const { collectReleaseConfiguredPluginIds } =
      await import("./release-configured-plugin-installs.js");
    const result = collectReleaseConfiguredPluginIds({
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
