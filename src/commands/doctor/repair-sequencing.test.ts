import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  evaluateStoredCredentialEligibility: vi.fn(),
  getInstalledPluginRecord: vi.fn(),
  isInstalledPluginEnabled: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  maybeRepairGroupAllowFromFallback: vi.fn(),
  maybeRepairManagedNpmOpenClawPeerLinks: vi.fn(),
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn(),
  maybeRepairOpenPolicyAllowFrom: vi.fn(),
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(),
  maybeRepairStalePluginConfig: vi.fn(),
  repairStaleOAuthProfileShadows: vi.fn(),
  repairMissingConfiguredPluginInstalls: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../doctor-plugin-registry.js", () => ({
  maybeRepairManagedNpmOpenClawPeerLinks: mocks.maybeRepairManagedNpmOpenClawPeerLinks,
  maybeRepairStaleManagedNpmBundledPlugins: mocks.maybeRepairStaleManagedNpmBundledPlugins,
}));

vi.mock("../doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: mocks.maybeRepairLegacyOAuthSidecarProfiles,
}));

vi.mock("./shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index.js")>()),
  getInstalledPluginRecord: mocks.getInstalledPluginRecord,
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

vi.mock("./shared/channel-doctor.js", () => ({
  collectChannelDoctorRepairMutations: ({ cfg }: { cfg: OpenClawConfig }) => {
    const allowFrom = cfg.channels?.discord?.allowFrom as unknown[] | undefined;
    if (allowFrom?.[0] === 123) {
      return [
        {
          config: {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: {
                ...cfg.channels?.discord,
                allowFrom: ["123"],
              },
            },
          },
          changes: ["channels.discord.allowFrom: converted 1 numeric ID to strings"],
        },
      ];
    }
    if (allowFrom?.[0] === 106232522769186816) {
      return [
        {
          config: cfg,
          changes: [],
          warnings: [
            "channels.discord.allowFrom[0] cannot be auto-repaired because it is not a safe integer",
          ],
        },
      ];
    }
    return [];
  },
  createChannelDoctorEmptyAllowlistPolicyHooks: () => ({
    extraWarningsForAccount: () => [],
    shouldSkipDefaultEmptyGroupAllowlistWarning: () => false,
  }),
}));

vi.mock("./shared/empty-allowlist-scan.js", () => ({
  scanEmptyAllowlistPolicyWarnings: (cfg: OpenClawConfig) =>
    cfg.channels?.signal
      ? ["channels.signal.accounts.ops\u001B[31m-team\u001B[0m\r\nnext.dmPolicy warning"]
      : [],
}));

vi.mock("./shared/allowlist-policy-repair.js", () => ({
  maybeRepairAllowlistPolicyAllowFrom: async (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/allowfrom-fallback-migration.js", () => ({
  maybeRepairGroupAllowFromFallback: mocks.maybeRepairGroupAllowFromFallback,
}));

vi.mock("./shared/bundled-plugin-load-paths.js", () => ({
  maybeRepairBundledPluginLoadPaths: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/open-policy-allowfrom.js", () => ({
  maybeRepairOpenPolicyAllowFrom: mocks.maybeRepairOpenPolicyAllowFrom,
}));

vi.mock("./shared/stale-plugin-config.js", () => ({
  maybeRepairStalePluginConfig: mocks.maybeRepairStalePluginConfig,
}));

vi.mock("./shared/stale-oauth-profile-shadows.js", () => ({
  repairStaleOAuthProfileShadows: mocks.repairStaleOAuthProfileShadows,
}));

vi.mock("./shared/invalid-plugin-config.js", () => ({
  maybeRepairInvalidPluginConfig: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/legacy-tools-by-sender.js", () => ({
  maybeRepairLegacyToolsBySenderKeys: (cfg: OpenClawConfig) => {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const tools = channels?.tools as
      | { exec?: { toolsBySender?: Record<string, unknown> } }
      | undefined;
    const bySender = tools?.exec?.toolsBySender;
    const rawKey = bySender
      ? Object.keys(bySender).find((key) => !key.startsWith("id:"))
      : undefined;
    if (!bySender || !rawKey) {
      return { config: cfg, changes: [] };
    }
    const targetKey = `id:${rawKey.trim()}`;
    return {
      config: {
        ...cfg,
        channels: {
          ...cfg.channels,
          tools: {
            ...(channels?.tools as Record<string, unknown> | undefined),
            exec: {
              ...tools?.exec,
              toolsBySender: {
                [targetKey]: bySender[rawKey],
              },
            },
          },
        },
      },
      changes: [
        `channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries (${rawKey} -> ${targetKey})`,
      ],
    };
  },
}));

vi.mock("./shared/exec-safe-bins.js", () => ({
  maybeRepairExecSafeBinProfiles: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("./shared/plugin-dependency-cleanup.js", () => ({
  cleanupLegacyPluginDependencyState: async () => ({
    changes: [],
    warnings: [],
  }),
}));

describe("doctor repair sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyPluginAutoEnable.mockImplementation((params: { config: OpenClawConfig }) => ({
      config: params.config,
      changes: [],
    }));
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {},
      usageStats: {},
    });
    mocks.evaluateStoredCredentialEligibility.mockReturnValue({
      eligible: true,
      reasonCode: "ok",
    });
    mocks.getInstalledPluginRecord.mockReturnValue(undefined);
    mocks.isInstalledPluginEnabled.mockReturnValue(false);
    mocks.loadInstalledPluginIndex.mockReturnValue({ plugins: [] });
    mocks.maybeRepairGroupAllowFromFallback.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
    mocks.maybeRepairManagedNpmOpenClawPeerLinks.mockResolvedValue(false);
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockResolvedValue({
      detected: [],
      changes: [],
      warnings: [],
    });
    mocks.maybeRepairOpenPolicyAllowFrom.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockReturnValue(false);
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.repairStaleOAuthProfileShadows.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);
    mocks.maybeRepairStalePluginConfig.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
  });

  it("applies ordered repairs and sanitizes empty-allowlist warnings", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.changeNotes).toStrictEqual([
      "channels.discord.allowFrom: converted 1 numeric ID to strings",
      "channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries (bad-keynext -> id:bad-keynext)",
    ]);
    expect(result.changeNotes.join("\n")).not.toContain("\u001B");
    expect(result.changeNotes.join("\n")).not.toContain("\r");
    expect(result.warningNotes).toStrictEqual([
      "channels.signal.accounts.ops-teamnext.dmPolicy warning",
    ]);
    expect(result.warningNotes.join("\n")).not.toContain("\u001B");
    expect(result.warningNotes.join("\n")).not.toContain("\r");
  });

  it("repairs managed npm plugin drift before missing plugin install repair", async () => {
    const events: string[] = [];
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockImplementation(() => {
      events.push("bundled-shadow-cleanup");
      return true;
    });
    mocks.maybeRepairManagedNpmOpenClawPeerLinks.mockImplementation(async () => {
      events.push("openclaw-peer-links");
      return true;
    });
    mocks.repairMissingConfiguredPluginInstalls.mockImplementation(async () => {
      events.push("missing-installs");
      return { changes: [], warnings: [] };
    });

    await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            entries: {
              "google-meet": { enabled: true },
            },
          },
        } as OpenClawConfig,
        candidate: {
          plugins: {
            entries: {
              "google-meet": { enabled: true },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(events).toEqual(["bundled-shadow-cleanup", "openclaw-peer-links", "missing-installs"]);
    expect(mocks.maybeRepairStaleManagedNpmBundledPlugins).toHaveBeenCalledOnce();
    const cleanupCall = mocks.maybeRepairStaleManagedNpmBundledPlugins.mock.calls[0]?.[0];
    expect(cleanupCall?.config.plugins?.entries?.["google-meet"]).toEqual({ enabled: true });
    expect(cleanupCall?.prompter).toEqual({ shouldRepair: true });
    expect(mocks.maybeRepairManagedNpmOpenClawPeerLinks).toHaveBeenCalledOnce();
    const peerLinkCall = mocks.maybeRepairManagedNpmOpenClawPeerLinks.mock.calls[0]?.[0];
    expect(peerLinkCall?.config.plugins?.entries?.["google-meet"]).toEqual({ enabled: true });
    expect(peerLinkCall?.prompter).toEqual({ shouldRepair: true });
    expect(peerLinkCall?.env).toBe(process.env);
  });

  it("migrates legacy OAuth sidecars before stale OAuth shadow cleanup", async () => {
    const events: string[] = [];
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockImplementationOnce(async () => {
      events.push("sidecar-oauth");
      return {
        detected: ["auth-profiles.json"],
        changes: ["Migrated 1 sidecar-backed Codex OAuth profile."],
        warnings: ["Sidecar warning"],
      };
    });
    mocks.repairStaleOAuthProfileShadows.mockImplementationOnce(async () => {
      events.push("stale-oauth-shadows");
      return {
        changes: ["Removed stale OAuth auth profile shadow openai-codex."],
        warnings: [],
      };
    });

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {} as OpenClawConfig,
        candidate: {} as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(events).toEqual(["sidecar-oauth", "stale-oauth-shadows"]);
    expect(mocks.maybeRepairLegacyOAuthSidecarProfiles).toHaveBeenCalledWith({
      cfg: {},
      prompter: { confirmAutoFix: expect.any(Function) },
      emitNotes: false,
      env: process.env,
    });
    expect(result.changeNotes).toEqual([
      "Migrated 1 sidecar-backed Codex OAuth profile.",
      "Removed stale OAuth auth profile shadow openai-codex.",
    ]);
    expect(result.warningNotes).toEqual(["Sidecar warning"]);
  });

  it("emits Discord warnings when unsafe numeric ids block repair", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changeNotes).toStrictEqual([]);
    expect(result.warningNotes).toStrictEqual([
      "channels.discord.allowFrom[0] cannot be auto-repaired because it is not a safe integer",
    ]);
    expect(result.state.pendingChanges).toBe(false);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual([106232522769186816]);
  });

  it("auto-enables newly installed configured plugins after doctor repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "brave" from @openclaw/brave-plugin.'],
      warnings: [],
    });
    mocks.applyPluginAutoEnable.mockImplementationOnce((params: { config: OpenClawConfig }) => ({
      config: {
        ...params.config,
        plugins: {
          ...params.config.plugins,
          allow: ["telegram", "brave"],
          entries: {
            ...params.config.plugins?.entries,
            brave: { enabled: true },
          },
        },
      },
      changes: ["brave web search provider selected, enabled automatically."],
    }));

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          tools: { web: { search: { provider: "brave" } } },
          plugins: { allow: ["telegram"] },
        } as OpenClawConfig,
        candidate: {
          tools: { web: { search: { provider: "brave" } } },
          plugins: { allow: ["telegram"] },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.allow).toEqual(["telegram", "brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.changeNotes).toStrictEqual([
      'Installed missing configured plugin "brave" from @openclaw/brave-plugin.',
      "brave web search provider selected, enabled automatically.",
    ]);
  });

  it("moves legacy Codex routes to canonical OpenAI before missing plugin install repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(
      async (params: { cfg: OpenClawConfig }) => {
        expect(params.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
        expect(params.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
        return {
          changes: [],
          warnings: [],
        };
      },
    );

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          agents: {
            defaults: {
              model: "openai-codex/gpt-5.5",
            },
          },
        } as OpenClawConfig,
        candidate: {
          agents: {
            defaults: {
              model: "openai-codex/gpt-5.5",
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.state.candidate.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.changeNotes).toStrictEqual([
      'Repaired Codex model routes:- agents.defaults.model: openai-codex/gpt-5.5 -> openai/gpt-5.5.\nSet agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
  });

  it("runs group allowFrom fallback migration after open-policy allowFrom repair", async () => {
    const events: string[] = [];
    mocks.maybeRepairOpenPolicyAllowFrom.mockImplementationOnce((cfg: OpenClawConfig) => {
      events.push("open-policy");
      return {
        config: {
          ...cfg,
          channels: {
            ...cfg.channels,
            signal: {
              ...cfg.channels?.signal,
              allowFrom: ["*"],
            },
          },
        },
        changes: ['channels.signal.allowFrom: set to ["*"]'],
      };
    });
    mocks.maybeRepairGroupAllowFromFallback.mockImplementationOnce((cfg: OpenClawConfig) => {
      events.push("group-fallback");
      expect(cfg.channels?.signal?.allowFrom).toEqual(["*"]);
      return {
        config: {
          ...cfg,
          channels: {
            ...cfg.channels,
            signal: {
              ...cfg.channels?.signal,
              groupAllowFrom: ["*"],
            },
          },
        },
        changes: ["channels.signal.groupAllowFrom: copied 1 sender entry from allowFrom"],
      };
    });

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            signal: {
              dmPolicy: "open",
            },
          },
        } as OpenClawConfig,
        candidate: {
          channels: {
            signal: {
              dmPolicy: "open",
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(events).toEqual(["open-policy", "group-fallback"]);
    expect(result.state.candidate.channels?.signal?.groupAllowFrom).toEqual(["*"]);
    expect(result.changeNotes).toContain('channels.signal.allowFrom: set to ["*"]');
    expect(result.changeNotes).toContain(
      "channels.signal.groupAllowFrom: copied 1 sender entry from allowFrom",
    );
  });

  it("does not remove deferred configured plugins during the package update doctor pass", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [
        'Skipped package-manager repair for configured plugin "brave" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
    });
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            allow: ["brave"],
            entries: {
              brave: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "BRAVE_API_KEY",
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        candidate: {
          plugins: {
            allow: ["brave"],
            entries: {
              brave: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "BRAVE_API_KEY",
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      },
    });

    expect(mocks.maybeRepairStalePluginConfig).not.toHaveBeenCalled();
    expect(result.state.candidate.plugins?.allow).toEqual(["brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.changeNotes).toStrictEqual([
      'Skipped package-manager repair for configured plugin "brave" during package update; rerun "openclaw doctor --fix" after the update completes.',
    ]);
  });

  it("preserves configured plugins when their install repair fails", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "brave" from @openclaw/brave-plugin: package install failed',
      ],
      failedPluginIds: ["brave"],
    });
    mocks.maybeRepairStalePluginConfig.mockImplementationOnce(
      (
        cfg: OpenClawConfig,
        _env: NodeJS.ProcessEnv | undefined,
        params: { preservePluginIds?: string[] },
      ) => {
        expect(params.preservePluginIds).toEqual(["brave"]);
        return {
          config: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              allow: ["brave"],
              entries: {
                brave: cfg.plugins?.entries?.brave,
              },
            },
          },
          changes: ["plugins.entries: removed 1 stale plugin entry (old-plugin)"],
        };
      },
    );

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            allow: ["brave"],
            entries: {
              brave: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "BRAVE_API_KEY",
                    },
                  },
                },
              },
              "old-plugin": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        candidate: {
          plugins: {
            allow: ["brave"],
            entries: {
              brave: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "BRAVE_API_KEY",
                    },
                  },
                },
              },
              "old-plugin": {
                enabled: true,
              },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.candidate.plugins?.allow).toEqual(["brave"]);
    expect(result.state.candidate.plugins?.entries?.brave?.enabled).toBe(true);
    expect(result.state.candidate.plugins?.entries?.["old-plugin"]).toBeUndefined();
    expect(result.state.pendingChanges).toBe(true);
    expect(result.changeNotes).toContain(
      "plugins.entries: removed 1 stale plugin entry (old-plugin)",
    );
    expect(result.warningNotes).toStrictEqual([
      'Failed to install missing configured plugin "brave" from @openclaw/brave-plugin: package install failed',
    ]);
  });

  it("preserves configured channels when their install repair fails", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [
        'Failed to install missing configured channel plugin "whatsapp" from @openclaw/whatsapp: package install failed',
      ],
      failedPluginIds: ["whatsapp"],
    });
    mocks.maybeRepairStalePluginConfig.mockImplementationOnce(
      (
        cfg: OpenClawConfig,
        _env: NodeJS.ProcessEnv | undefined,
        params: { preservePluginIds?: string[] },
      ) => {
        expect(params.preservePluginIds).toEqual(["whatsapp"]);
        return {
          config: cfg,
          changes: [],
        };
      },
    );

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            whatsapp: {
              allowFrom: ["+15555550123"],
            },
          },
        } as OpenClawConfig,
        candidate: {
          channels: {
            whatsapp: {
              allowFrom: ["+15555550123"],
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.maybeRepairStalePluginConfig).toHaveBeenCalledOnce();
    expect(result.state.candidate.channels?.whatsapp).toEqual({
      allowFrom: ["+15555550123"],
    });
    expect(result.warningNotes).toStrictEqual([
      'Failed to install missing configured channel plugin "whatsapp" from @openclaw/whatsapp: package install failed',
    ]);
  });
});
