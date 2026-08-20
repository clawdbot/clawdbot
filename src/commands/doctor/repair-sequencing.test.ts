// Doctor repair sequencing tests cover ordered repair execution and dependency handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  materializePluginAutoEnableCandidates: vi.fn(),
  collectChannelDoctorCompatibilityMutations: vi.fn(),
  collectOpenAICodexAuthProfileStoreIdMap: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  evaluateStoredCredentialEligibility: vi.fn(),
  getInstalledPluginRecord: vi.fn(),
  isInstalledPluginEnabled: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  maybeRepairGroupAllowFromFallback: vi.fn(),
  maybeRepairPluginOpenClawHostLinks: vi.fn(),
  maybeRepairLegacyOAuthSidecarProfiles: vi.fn(),
  migrateLegacyOnboardingRecommendationsScope: vi.fn(),
  migrateLegacyTailscaleProfileIdentities: vi.fn(),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn(),
  maybeRepairOpenAICodexAuthConfig: vi.fn(),
  maybeRepairOpenPolicyAllowFrom: vi.fn(),
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(),
  maybeRepairStaleConfiguredAuthOrders: vi.fn(),
  maybeRepairStalePluginConfig: vi.fn(),
  repairStaleOAuthProfileShadows: vi.fn(),
  repairMissingConfiguredPluginInstalls: vi.fn(),
  repairStaleAgentModelRefs: vi.fn(),
  resolveConfigWidePluginManifestRegistry: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveProviderInstallCatalogEntries: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
  materializePluginAutoEnableCandidates: mocks.materializePluginAutoEnableCandidates,
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: mocks.resolveConfigWidePluginManifestRegistry,
}));

vi.mock("../doctor-plugin-host-links.js", () => ({
  maybeRepairPluginOpenClawHostLinks: mocks.maybeRepairPluginOpenClawHostLinks,
}));

vi.mock("../doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: mocks.maybeRepairStaleManagedNpmBundledPlugins,
}));

vi.mock("../doctor-auth-oauth-sidecar.js", () => ({
  maybeRepairLegacyOAuthSidecarProfiles: mocks.maybeRepairLegacyOAuthSidecarProfiles,
}));

vi.mock("../../infra/state-migrations.onboarding-recommendations.js", () => ({
  migrateLegacyOnboardingRecommendationsScope: mocks.migrateLegacyOnboardingRecommendationsScope,
}));

vi.mock("../../state/user-profiles-tailscale-migration.js", () => ({
  migrateLegacyTailscaleProfileIdentities: mocks.migrateLegacyTailscaleProfileIdentities,
}));

vi.mock("../doctor-auth-flat-profiles.js", () => ({
  collectOpenAICodexAuthProfileStoreIdMap: mocks.collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite: mocks.maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig: mocks.maybeRepairOpenAICodexAuthConfig,
}));

vi.mock("./shared/missing-configured-plugin-install.js", () => ({
  repairMissingConfiguredPluginInstalls: mocks.repairMissingConfiguredPluginInstalls,
}));

vi.mock("./shared/stale-agent-model-ref-repair.js", () => ({
  repairStaleAgentModelRefs: mocks.repairStaleAgentModelRefs,
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

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("./shared/channel-doctor.js", () => ({
  collectChannelDoctorCompatibilityMutations: mocks.collectChannelDoctorCompatibilityMutations,
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

vi.mock("./shared/stale-auth-order.js", () => ({
  maybeRepairStaleConfiguredAuthOrders: mocks.maybeRepairStaleConfiguredAuthOrders,
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
    mocks.materializePluginAutoEnableCandidates.mockImplementation(
      (params: { config: OpenClawConfig }) => ({
        config: params.config,
        changes: [],
      }),
    );
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
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    mocks.maybeRepairGroupAllowFromFallback.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
    mocks.maybeRepairPluginOpenClawHostLinks.mockResolvedValue(false);
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockResolvedValue({
      detected: [],
      changes: [],
      warnings: [],
    });
    mocks.migrateLegacyOnboardingRecommendationsScope.mockReturnValue({
      changes: [],
      warnings: [],
    });
    mocks.migrateLegacyTailscaleProfileIdentities.mockReturnValue({ changes: [], warnings: [] });
    mocks.collectOpenAICodexAuthProfileStoreIdMap.mockReturnValue(new Map());
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockResolvedValue({
      detected: [],
      changes: [],
      warnings: [],
    });
    mocks.maybeRepairOpenAICodexAuthConfig.mockImplementation((cfg: OpenClawConfig) => ({
      changes: [],
      config: cfg,
      warnings: [],
    }));
    mocks.maybeRepairOpenPolicyAllowFrom.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockReturnValue(null);
    mocks.maybeRepairStaleConfiguredAuthOrders.mockImplementation(
      ({ cfg }: { cfg: OpenClawConfig }) => ({ config: cfg, changes: [] }),
    );
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.repairStaleAgentModelRefs.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
      warnings: [],
    }));
    mocks.repairStaleOAuthProfileShadows.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.collectChannelDoctorCompatibilityMutations.mockReturnValue([]);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);
    mocks.maybeRepairStalePluginConfig.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
  });

  it("runs the doctor-only onboarding recommendation scope migration", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-test" };
    const candidate = {} as OpenClawConfig;
    mocks.migrateLegacyOnboardingRecommendationsScope.mockReturnValue({
      changes: ["Migrated onboarding recommendation state."],
      warnings: ["Migration warning."],
    });

    const result = await runDoctorRepairSequence({
      state: {
        cfg: candidate,
        candidate,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      env,
    });

    expect(mocks.migrateLegacyOnboardingRecommendationsScope).toHaveBeenCalledWith({
      cfg: candidate,
      env,
    });
    expect(result.changeNotes).toContain("Migrated onboarding recommendation state.");
    expect(result.warningNotes).toContain("Migration warning.");
  });

  it("runs the doctor-only Tailscale profile identity migration", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-test" };
    const candidate = {} as OpenClawConfig;
    mocks.migrateLegacyTailscaleProfileIdentities.mockReturnValue({
      changes: ["Migrated Tailscale profile identity."],
      warnings: ["Tailscale identity conflict."],
    });

    const result = await runDoctorRepairSequence({
      state: { cfg: candidate, candidate, pendingChanges: false, fixHints: [] },
      doctorFixCommand: "openclaw doctor --fix",
      env,
    });

    expect(mocks.migrateLegacyTailscaleProfileIdentities).toHaveBeenCalledWith({ env });
    expect(result.changeNotes).toContain("Migrated Tailscale profile identity.");
    expect(result.warningNotes).toContain("Tailscale identity conflict.");
  });

  it("retains the exact auth profile map after import for later session-owner repair", async () => {
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-test" };
    const candidate = {} as OpenClawConfig;
    const profileIdMap = new Map([["openai-codex:default", "openai:chatgpt-default"]]);
    mocks.collectOpenAICodexAuthProfileStoreIdMap.mockReturnValue(profileIdMap);
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockResolvedValue({
      detected: ["auth-profiles.json"],
      changes: ["Migrated auth profile JSON into SQLite."],
      warnings: [],
    });
    const result = await runDoctorRepairSequence({
      state: { cfg: candidate, candidate, pendingChanges: false, fixHints: [] },
      doctorFixCommand: "openclaw doctor --fix",
      env,
    });

    expect(mocks.maybeRepairOpenAICodexAuthConfig).toHaveBeenCalledWith(candidate, {
      profileIdMap,
    });
    expect(mocks.maybeMigrateAuthProfileJsonStoresToSqlite).toHaveBeenCalledWith({
      cfg: candidate,
      env,
      prompter: expect.objectContaining({ confirmAutoFix: expect.any(Function) }),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(result.openAICodexAuthProfileIdMap).toBe(profileIdMap);
    expect(mocks.maybeRepairOpenAICodexAuthConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mock.invocationCallOrder[0]!,
    );
  });

  it("sanitizes ordered plugin repair changes, warnings, notices, and migration notes", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ["Installed \u001B[31mplugin\u001B[0m\r\nnext."],
      warnings: ["Plugin \u001B[31mwarning\u001B[0m\r\nnext."],
      notices: ["Plugin \u001B[31mnotice\u001B[0m\r\nnext."],
    });
    mocks.migrateLegacyOnboardingRecommendationsScope.mockReturnValueOnce({
      changes: ["Migrated \u001B[31mrecommendations\u001B[0m\r\nnext."],
      warnings: ["Migration \u001B[31mwarning\u001B[0m\r\nnext."],
    });
    const candidate = {} as OpenClawConfig;

    const result = await runDoctorRepairSequence({
      state: { cfg: candidate, candidate, pendingChanges: false, fixHints: [] },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changeNotes).toEqual(["Installed pluginnext.", "Migrated recommendationsnext."]);
    expect(result.warningNotes).toEqual([
      "Plugin warningnext.",
      "Plugin noticenext.",
      "Migration warningnext.",
    ]);
    const emittedNotes = [...result.changeNotes, ...result.warningNotes].join("\n");
    expect(emittedNotes).not.toContain("\u001B");
    expect(emittedNotes).not.toContain("\r");
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
    expect(result.changeNotes).toStrictEqual([]);
    expect(result.configChangeNotes).toStrictEqual([
      "channels.discord.allowFrom: converted 1 numeric ID to strings",
      "channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries (bad-keynext -> id:bad-keynext)",
    ]);
    expect(result.configChangeNotes.join("\n")).not.toContain("\u001B");
    expect(result.configChangeNotes.join("\n")).not.toContain("\r");
    expect(result.warningNotes).toStrictEqual([
      "channels.signal.accounts.ops-teamnext.dmPolicy warning",
    ]);
    expect(result.warningNotes.join("\n")).not.toContain("\u001B");
    expect(result.warningNotes.join("\n")).not.toContain("\r");
  });

  it("applies stale configured auth-order repair", async () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:claude-cli"] } },
    } satisfies OpenClawConfig;
    mocks.maybeRepairStaleConfiguredAuthOrders.mockReturnValueOnce({
      config: {
        auth: { order: {} },
      },
      changes: [
        "auth.order.anthropic: removed 1 missing profile reference to restore automatic per-agent auth selection.",
      ],
    });

    const result = await runDoctorRepairSequence({
      state: {
        cfg,
        candidate: cfg,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.candidate.auth?.order?.anthropic).toBeUndefined();
    expect(result.configChangeNotes).toContain(
      "auth.order.anthropic: removed 1 missing profile reference to restore automatic per-agent auth selection.",
    );
    expect(result.authProfilesRepaired).toBe(false);
  });

  it("repairs managed npm plugin drift before missing plugin install repair", async () => {
    const events: string[] = [];
    const refreshedSnapshot = {
      manifestRegistry: { plugins: [], diagnostics: [] },
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValueOnce(refreshedSnapshot);
    mocks.maybeRepairStaleManagedNpmBundledPlugins.mockImplementation(() => {
      events.push("bundled-shadow-cleanup");
      return { installRecords: {}, removedPluginIds: ["google-meet"] };
    });
    mocks.maybeRepairPluginOpenClawHostLinks.mockImplementation(async () => {
      events.push("openclaw-peer-links");
      return true;
    });
    mocks.repairMissingConfiguredPluginInstalls.mockImplementation(async () => {
      events.push("missing-installs");
      return { changes: [], warnings: [] };
    });

    const result = await runDoctorRepairSequence({
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
    expect(mocks.maybeRepairPluginOpenClawHostLinks).toHaveBeenCalledOnce();
    expect(mocks.repairMissingConfiguredPluginInstalls).toHaveBeenCalledWith({
      cfg: {
        plugins: {
          entries: {
            "google-meet": { enabled: true },
          },
        },
      },
      env: process.env,
      baselineRecords: {},
    });
    const peerLinkCall = mocks.maybeRepairPluginOpenClawHostLinks.mock.calls[0]?.[0];
    expect(peerLinkCall?.prompter).toEqual({ shouldRepair: true });
    expect(peerLinkCall?.env).toBe(process.env);
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(result.pluginMetadataSnapshot).toMatchObject({
      manifestRegistry: refreshedSnapshot.manifestRegistry,
      plugins: [],
    });
  });

  it("repairs stale OAuth shadows before importing and removing auth JSON", async () => {
    const events: string[] = [];
    mocks.maybeRepairLegacyOAuthSidecarProfiles.mockImplementationOnce(async () => {
      events.push("sidecar-oauth");
      return {
        detected: ["auth-profiles.json"],
        changes: ["Migrated 1 legacy Codex OAuth profile."],
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
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockImplementationOnce(async () => {
      events.push("sqlite-migration");
      return {
        detected: ["auth-profiles.json"],
        changes: ["Migrated auth profile JSON into SQLite."],
        configChanged: true,
        warnings: [],
      };
    });
    mocks.maybeRepairStaleConfiguredAuthOrders.mockImplementationOnce(({ cfg }) => {
      events.push("stale-auth-order");
      return { config: cfg, changes: [] };
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

    expect(events).toEqual([
      "sidecar-oauth",
      "stale-oauth-shadows",
      "sqlite-migration",
      "stale-auth-order",
    ]);
    expect(mocks.maybeRepairLegacyOAuthSidecarProfiles).toHaveBeenCalledWith({
      cfg: {},
      prompter: { confirmAutoFix: expect.any(Function) },
      emitNotes: false,
      env: process.env,
    });
    expect(result.changeNotes).toEqual([
      "Migrated 1 legacy Codex OAuth profile.",
      "Removed stale OAuth auth profile shadow openai-codex.",
      "Migrated auth profile JSON into SQLite.",
    ]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.warningNotes).toEqual(["Sidecar warning"]);
    expect(result.authProfilesRepaired).toBe(true);
  });

  it("reports receipt-owned OpenAI auth-provider migration as an auth repair", async () => {
    mocks.maybeMigrateAuthProfileJsonStoresToSqlite.mockResolvedValueOnce({
      changes: ["Migrated OpenAI Codex auth-provider profile openai-codex."],
      warnings: [],
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

    expect(result.changeNotes).toEqual([
      "Migrated OpenAI Codex auth-provider profile openai-codex.",
    ]);
    expect(result.authProfilesRepaired).toBe(true);
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
    ]);
    expect(result.configChangeNotes).toStrictEqual([
      "brave web search provider selected, enabled automatically.",
    ]);
  });

  it("uses plugins from every agent workspace after inventory repair", async () => {
    const researchPlugin = {
      id: "research-channel",
      source: "/srv/research/.openclaw/extensions/research-channel/openclaw.plugin.json",
    };
    const manifestRegistry = { plugins: [researchPlugin], diagnostics: [] };
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(manifestRegistry);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [],
      diagnostics: [],
      byPluginId: new Map(),
    });
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "research-channel".'],
      warnings: [],
      pluginInventoryChanged: true,
    });

    await runDoctorRepairSequence({
      state: {
        cfg: {
          agents: {
            ownership: "explicit",
            entries: {
              ops: { workspace: "/srv/ops" },
              research: { workspace: "/srv/research" },
            },
          },
        } as OpenClawConfig,
        candidate: {
          agents: {
            ownership: "explicit",
            entries: {
              ops: { workspace: "/srv/ops" },
              research: { workspace: "/srv/research" },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith(
      expect.objectContaining({ manifestRegistry }),
    );
  });

  it("installs an external provider before validating configured model references", async () => {
    let mistralInstalled = false;
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(async () => {
      mistralInstalled = true;
      return {
        changes: ['Installed missing configured plugin "mistral" from @openclaw/mistral-provider.'],
        warnings: [],
        repairedPluginIds: ["mistral"],
        pluginInventoryChanged: true,
      };
    });
    mocks.repairStaleAgentModelRefs.mockImplementationOnce((cfg: OpenClawConfig) => ({
      config: mistralInstalled
        ? cfg
        : {
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: {
                ...cfg.agents?.defaults,
                model: { primary: "openai/gpt-5.6-sol" },
              },
            },
          },
      changes: mistralInstalled ? [] : ["replaced Mistral model before plugin repair"],
      warnings: [],
    }));
    const config = {
      plugins: {
        allow: ["mistral"],
        entries: { mistral: { enabled: true } },
      },
      agents: {
        defaults: { model: { primary: "mistral/mistral-large-latest" } },
      },
      memory: { search: { provider: "mistral" } },
    } as OpenClawConfig;

    const result = await runDoctorRepairSequence({
      state: {
        cfg: config,
        candidate: config,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.repairMissingConfiguredPluginInstalls.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repairStaleAgentModelRefs.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.state.candidate.plugins?.allow).toEqual(["mistral"]);
    expect(result.state.candidate.plugins?.entries?.mistral?.enabled).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toEqual({
      primary: "mistral/mistral-large-latest",
    });
    expect(result.state.candidate.memory?.search?.provider).toBe("mistral");
  });

  it("preserves external provider model references when plugin install repair fails", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: [],
      warnings: [
        'Failed to install missing configured plugin "mistral" from @openclaw/mistral-provider: package install failed',
      ],
      failedPluginIds: ["mistral"],
    });
    const config = {
      plugins: {
        allow: ["mistral"],
        entries: { mistral: { enabled: true } },
      },
      agents: {
        defaults: { model: { primary: "mistral/mistral-large-latest" } },
      },
      memory: { search: { provider: "mistral" } },
    } as OpenClawConfig;

    const result = await runDoctorRepairSequence({
      state: {
        cfg: config,
        candidate: config,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.repairStaleAgentModelRefs).not.toHaveBeenCalled();
    expect(result.state.candidate.plugins?.allow).toEqual(["mistral"]);
    expect(result.state.candidate.plugins?.entries?.mistral?.enabled).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toEqual({
      primary: "mistral/mistral-large-latest",
    });
    expect(result.state.candidate.memory?.search?.provider).toBe("mistral");
  });

  it("applies doctor contracts exposed by newly installed plugins", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "discord" from @openclaw/discord.'],
      warnings: [],
      repairedPluginIds: ["discord"],
      pluginInventoryChanged: true,
    });
    mocks.materializePluginAutoEnableCandidates.mockImplementationOnce(
      (params: { config: OpenClawConfig }) => ({
        config: {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            entries: {
              ...params.config.plugins?.entries,
              discord: { enabled: true },
            },
          },
        },
        changes: ["discord installed for existing configuration, enabled automatically."],
      }),
    );
    mocks.collectChannelDoctorCompatibilityMutations.mockImplementationOnce(
      (cfg: OpenClawConfig) => [
        {
          config: {
            ...cfg,
            channels: {
              ...cfg.channels,
              discord: {
                ...cfg.channels?.discord,
                dmPolicy: "allowlist",
                allowFrom: [123],
                dm: { enabled: true },
              },
            },
          },
          changes: [
            "Moved channels.discord.dm.policy → channels.discord.dmPolicy.",
            "Moved channels.discord.dm.allowFrom → channels.discord.allowFrom.",
          ],
        },
      ],
    );

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              dm: { enabled: true, policy: "allowlist", allowFrom: [123] },
            },
          },
        } as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              dm: { enabled: true, policy: "allowlist", allowFrom: [123] },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.collectChannelDoctorCompatibilityMutations).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: { entries: { discord: { enabled: true } } },
      }),
      { env: process.env },
    );
    expect(result.state.candidate.channels?.discord).toEqual({
      dmPolicy: "allowlist",
      allowFrom: ["123"],
      dm: { enabled: true },
    });
    expect(result.changeNotes).toStrictEqual([
      'Installed missing configured plugin "discord" from @openclaw/discord.',
    ]);
    expect(result.configChangeNotes).toStrictEqual([
      "discord installed for existing configuration, enabled automatically.",
      "Moved channels.discord.dm.policy → channels.discord.dmPolicy.\nMoved channels.discord.dm.allowFrom → channels.discord.allowFrom.",
      "channels.discord.allowFrom: converted 1 numeric ID to strings",
    ]);
  });

  it("explicitly enables plugins repaired from env-only configuration", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "exa" from @openclaw/exa-plugin.'],
      warnings: [],
      repairedPluginIds: ["exa"],
      pluginInventoryChanged: true,
    });
    mocks.materializePluginAutoEnableCandidates.mockImplementationOnce(
      (params: { config: OpenClawConfig }) => ({
        config: {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            entries: {
              ...params.config.plugins?.entries,
              exa: { enabled: true },
            },
          },
        },
        changes: ["exa installed for existing configuration, enabled automatically."],
      }),
    );

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {} as OpenClawConfig,
        candidate: {} as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(mocks.materializePluginAutoEnableCandidates).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      manifestRegistry: { plugins: [], diagnostics: [] },
      candidates: [{ pluginId: "exa", kind: "configured-plugin-repaired" }],
    });
    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(result.state.candidate.plugins?.entries?.exa).toEqual({ enabled: true });
    expect(result.changeNotes).toStrictEqual([
      'Installed missing configured plugin "exa" from @openclaw/exa-plugin.',
    ]);
    expect(result.configChangeNotes).toStrictEqual([
      "exa installed for existing configuration, enabled automatically.",
    ]);
  });

  it("refreshes retained default-workspace metadata after cleanup-only inventory repairs", async () => {
    const workspaceDir = "/tmp/openclaw-doctor-workspace";
    const workspaceProvider = "workspace-provider";
    const staleSnapshot = {
      manifestRegistry: {
        plugins: [{ id: "google-meet" }],
        diagnostics: [],
      },
    };
    const createRefreshedSnapshot = (includeWorkspaceProvider: boolean) =>
      ({
        diagnostics: [],
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: {
          providers: new Map(
            includeWorkspaceProvider ? [[workspaceProvider, ["workspace-plugin"]]] : [],
          ),
          modelCatalogProviders: new Map(),
          setupProviders: new Map(),
          cliBackends: new Map(),
        },
      }) as unknown as PluginMetadataSnapshot;
    const refreshedSnapshot = createRefreshedSnapshot(true);
    const configWideManifestRegistry = {
      plugins: [
        {
          id: "workspace-plugin",
          source:
            "/tmp/openclaw-doctor-workspace/.openclaw/extensions/workspace-plugin/openclaw.plugin.json",
          providers: [workspaceProvider],
        },
      ],
      diagnostics: [],
    };
    mocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(configWideManifestRegistry);
    mocks.loadPluginMetadataSnapshot.mockImplementationOnce((params: { workspaceDir?: string }) =>
      params.workspaceDir === workspaceDir ? refreshedSnapshot : createRefreshedSnapshot(false),
    );
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warnings: [],
      pluginInventoryChanged: true,
    });
    const { repairStaleAgentModelRefs: repairStaleAgentModelRefsActual } = await vi.importActual<
      typeof import("./shared/stale-agent-model-ref-repair.js")
    >("./shared/stale-agent-model-ref-repair.js");
    mocks.repairStaleAgentModelRefs.mockImplementationOnce(
      (
        cfg: OpenClawConfig,
        options: NonNullable<Parameters<typeof repairStaleAgentModelRefsActual>[1]>,
      ) =>
        repairStaleAgentModelRefsActual(cfg, {
          ...options,
          persistedProviderIdsByAgentId: new Map([["main", new Set()]]),
        }),
    );
    const pluginMetadataSnapshotState = {
      current: staleSnapshot as unknown as PluginMetadataSnapshot,
    };
    const scopedSnapshots: Array<PluginMetadataSnapshot | undefined> = [];
    const runWithPluginMetadataSnapshot = <T>(
      _scope: { config: OpenClawConfig; workspaceDir?: string },
      run: () => T,
    ): T => {
      scopedSnapshots.push(pluginMetadataSnapshotState.current);
      return run();
    };

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          agents: {
            defaults: {
              model: `${workspaceProvider}/model`,
              workspace: workspaceDir,
            },
          },
        } as OpenClawConfig,
        candidate: {
          agents: {
            defaults: {
              model: `${workspaceProvider}/model`,
              workspace: workspaceDir,
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      pluginMetadataSnapshotState,
      runWithPluginMetadataSnapshot,
    });

    expect(mocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {
        agents: {
          defaults: {
            model: `${workspaceProvider}/model`,
            workspace: workspaceDir,
          },
        },
      },
      env: process.env,
      workspaceDir,
    });
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {
        agents: {
          defaults: {
            model: `${workspaceProvider}/model`,
            workspace: workspaceDir,
          },
        },
      },
      env: process.env,
      manifestRegistry: configWideManifestRegistry,
    });
    const currentPluginMetadataSnapshot = pluginMetadataSnapshotState.current;
    expect(mocks.repairStaleAgentModelRefs).toHaveBeenCalledWith(
      {
        agents: {
          defaults: {
            model: `${workspaceProvider}/model`,
            workspace: workspaceDir,
          },
        },
      },
      {
        env: process.env,
        pluginMetadataSnapshot: currentPluginMetadataSnapshot,
      },
    );
    expect(currentPluginMetadataSnapshot).toMatchObject({
      manifestRegistry: configWideManifestRegistry,
      plugins: configWideManifestRegistry.plugins,
      owners: {
        providers: new Map([[workspaceProvider, ["workspace-plugin"]]]),
      },
    });
    expect(scopedSnapshots[0]).toBe(staleSnapshot);
    expect(scopedSnapshots).toContain(currentPluginMetadataSnapshot);
    expect(result.pluginMetadataSnapshot).toBe(currentPluginMetadataSnapshot);
    expect(result.state.candidate.agents?.defaults?.model).toBe(`${workspaceProvider}/model`);
    expect(result.changeNotes).not.toContain(
      expect.stringContaining(`provider "${workspaceProvider}" is unavailable`),
    );
  });

  it("surfaces ClawHub notices from successful missing configured plugin repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockResolvedValueOnce({
      changes: ['Installed missing configured plugin "brave" from @openclaw/brave-plugin.'],
      warnings: [],
      notices: [
        'ClawHub trust warning for "@openclaw/brave-plugin@1.2.3": scan=pending; reasons=pending.',
      ],
    });
    mocks.maybeRepairStalePluginConfig.mockImplementationOnce((cfg: OpenClawConfig) => ({
      config: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          allow: [],
          entries: {},
        },
      },
      changes: ["- plugins.entries: removed 1 stale plugin entry (brave)"],
    }));

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            allow: ["brave"],
            entries: {
              brave: {
                enabled: true,
                source: "clawhub",
                package: "@openclaw/brave-plugin",
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
                source: "clawhub",
                package: "@openclaw/brave-plugin",
              },
            },
          },
        } as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changeNotes).toStrictEqual([
      'Installed missing configured plugin "brave" from @openclaw/brave-plugin.',
    ]);
    expect(result.configChangeNotes).toStrictEqual([
      "- plugins.entries: removed 1 stale plugin entry (brave)",
    ]);
    expect(result.warningNotes).toStrictEqual([
      'ClawHub trust warning for "@openclaw/brave-plugin@1.2.3": scan=pending; reasons=pending.',
    ]);
    expect(mocks.maybeRepairStalePluginConfig).toHaveBeenCalledOnce();
    expect(result.state.pendingChanges).toBe(true);
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
    expect(result.changeNotes).toStrictEqual([]);
    expect(result.configChangeNotes).toStrictEqual([
      'Repaired Codex model routes:- agents.defaults.model: openai-codex/gpt-5.5 -> openai/gpt-5.5.\nSet agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
  });

  it("repairs #94184 stale Codex model-map refs before missing plugin install repair", async () => {
    mocks.repairMissingConfiguredPluginInstalls.mockImplementationOnce(
      async (params: { cfg: OpenClawConfig }) => {
        expect(params.cfg.plugins?.entries?.codex?.enabled).toBe(true);
        expect(params.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
        expect(params.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
          id: "codex",
        });
        expect(params.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.5"]).toBeUndefined();
        return {
          changes: [],
          warnings: [],
        };
      },
    );

    const staleUpgradeConfig = {
      plugins: {
        allow: ["openai"],
        entries: {
          codex: { enabled: true },
        },
      },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          models: {
            "openai-codex/gpt-5.5": {
              params: { reasoning_effort: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await runDoctorRepairSequence({
      state: {
        cfg: staleUpgradeConfig,
        candidate: staleUpgradeConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      env: {},
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.allow).toEqual(["openai", "codex"]);
    expect(result.state.candidate.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.state.candidate.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(
      result.state.candidate.agents?.defaults?.models?.["openai-codex/gpt-5.5"],
    ).toBeUndefined();
    expect(result.state.candidate.agents?.defaults?.models?.["openai/gpt-5.5"]).toMatchObject({
      params: { reasoning_effort: "high" },
      agentRuntime: { id: "codex" },
    });
    const changeNotes = result.configChangeNotes.join("\n");
    expect(changeNotes).toContain("agents.defaults.model: openai-codex/gpt-5.5 -> openai/gpt-5.5");
    expect(changeNotes).toContain(
      "agents.defaults.models.openai-codex/gpt-5.5: openai-codex/gpt-5.5 -> openai/gpt-5.5",
    );
    expect(changeNotes).toContain(
      'Set agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex"',
    );
    expect(changeNotes).toContain("Added codex to plugins.allow");
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
    expect(result.configChangeNotes).toContain('channels.signal.allowFrom: set to ["*"]');
    expect(result.configChangeNotes).toContain(
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
        params: {
          preservePluginIds?: string[];
          surfacePreservePluginIds?: { allow?: string[]; deny?: string[]; entries?: string[] };
        },
      ) => {
        expect(params.preservePluginIds).toEqual(["brave"]);
        expect(params.surfacePreservePluginIds).toEqual({
          allow: new Set(["codex"]),
          deny: new Set(["codex"]),
          entries: new Set(["codex"]),
        });
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
    expect(result.configChangeNotes).toContain(
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
        params: {
          preservePluginIds?: string[];
          surfacePreservePluginIds?: { allow?: string[]; deny?: string[]; entries?: string[] };
        },
      ) => {
        expect(params.preservePluginIds).toEqual(["whatsapp"]);
        expect(params.surfacePreservePluginIds).toEqual({
          allow: new Set(["codex"]),
          deny: new Set(["codex"]),
          entries: new Set(["codex"]),
        });
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
