import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const ensureStandaloneMigrationProviderRegistryLoaded = vi.hoisted(() => vi.fn());
const resolvePluginMigrationProviders = vi.hoisted(() => vi.fn(() => [] as unknown[]));
vi.mock("../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded,
  resolvePluginMigrationProviders,
}));

const resolveManifestContractRuntimePluginResolution = vi.hoisted(() =>
  vi.fn((_params: { contract: string; value?: string }) => ({
    pluginIds: [] as string[],
    bundledCompatPluginIds: [] as string[],
  })),
);
vi.mock("../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution,
}));

const createMigrationLogger = vi.hoisted(() =>
  vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
);
vi.mock("../commands/migrate/context.js", () => ({ createMigrationLogger }));

const resolveStateDir = vi.hoisted(() => vi.fn(() => "/tmp/state"));
vi.mock("../config/paths.js", () => ({ resolveStateDir }));

const migrateDefaultCommand = vi.hoisted(() =>
  vi.fn(async (_runtime: unknown, _opts: { provider: string }) => undefined),
);
vi.mock("../commands/migrate.js", () => ({ migrateDefaultCommand }));

import { offerPostInstallMigrations } from "./setup.post-install-migration.js";

type ProviderMock = {
  id: string;
  label: string;
  detect: ReturnType<typeof vi.fn>;
};

function buildProvider(overrides: Partial<ProviderMock> = {}): ProviderMock {
  return {
    id: "codex",
    label: "Codex",
    detect: vi.fn(async () => ({ found: true, source: "/home/user/.codex" })),
    ...overrides,
  };
}

function setOwnership(providerId: string, owningPluginIds: string[]): void {
  resolveManifestContractRuntimePluginResolution.mockImplementation((params) => {
    if (params.value === providerId) {
      return { pluginIds: owningPluginIds, bundledCompatPluginIds: [] };
    }
    return { pluginIds: [], bundledCompatPluginIds: [] };
  });
}

function setProviders(providers: ProviderMock[]): void {
  resolvePluginMigrationProviders.mockReturnValue(providers as unknown[]);
}

function setTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
}

function buildBaseArgs(overrides: {
  config?: OpenClawConfig;
  prompter?: WizardPrompter;
  installedPluginIds?: readonly string[];
  nonInteractive?: boolean;
}) {
  return {
    config: overrides.config ?? ({} as OpenClawConfig),
    runtime: createNonExitingRuntime(),
    prompter: overrides.prompter ?? createWizardPrompter(),
    installedPluginIds: overrides.installedPluginIds ?? ["codex"],
    ...(overrides.nonInteractive === undefined ? {} : { nonInteractive: overrides.nonInteractive }),
  };
}

describe("offerPostInstallMigrations", () => {
  beforeEach(() => {
    // clearAllMocks only resets call history; reset the implementations each
    // test would customize so prior cases don't leak across this suite.
    ensureStandaloneMigrationProviderRegistryLoaded.mockReset();
    resolvePluginMigrationProviders.mockReset().mockReturnValue([]);
    resolveManifestContractRuntimePluginResolution.mockReset().mockReturnValue({
      pluginIds: [],
      bundledCompatPluginIds: [],
    });
    createMigrationLogger.mockReset().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
    resolveStateDir.mockReset().mockReturnValue("/tmp/state");
    migrateDefaultCommand.mockReset().mockResolvedValue(undefined);
    setTTY(true);
  });

  it("returns early when no plugins were installed in this onboarding step", async () => {
    const config = { plugins: { entries: { codex: { enabled: true } } } } as OpenClawConfig;
    const result = await offerPostInstallMigrations(
      buildBaseArgs({ config, installedPluginIds: [] }),
    );
    expect(resolvePluginMigrationProviders).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
    expect(result.config).toBe(config);
  });

  it("skips providers not owned by any plugin in installedPluginIds", async () => {
    const provider = buildProvider({ id: "codex" });
    setProviders([provider]);
    // Ownership map reports the provider lives on the "codex" plugin, but only
    // "diagnostics-otel" was installed in this run — so no offer should fire.
    setOwnership("codex", ["codex"]);

    await offerPostInstallMigrations(buildBaseArgs({ installedPluginIds: ["diagnostics-otel"] }));

    expect(provider.detect).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("skips providers whose detect reports nothing found", async () => {
    const provider = buildProvider({
      detect: vi.fn(async () => ({ found: false })),
    });
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter();

    await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(provider.detect).toHaveBeenCalledOnce();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("skips providers whose detect confidence is low", async () => {
    const provider = buildProvider({
      detect: vi.fn(async () => ({ found: true, confidence: "low" as const })),
    });
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter();

    await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("invokes migrateDefaultCommand when the user accepts in interactive mode", async () => {
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const confirm = vi.fn(async (_params: { message: string; initialValue?: boolean }) => true);
    const prompter = createWizardPrompter({
      confirm: confirm as WizardPrompter["confirm"],
    });

    const result = await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(migrateDefaultCommand).toHaveBeenCalledOnce();
    expect(migrateDefaultCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        configPatchMode: "return",
        suppressPlanLog: true,
      }),
    );
    expect(result.config).toEqual({});
  });

  it("returns config patched from migrated config items without mutating the input config", async () => {
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const inputConfig = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "workspace-write" },
            },
          },
        },
      },
    } as OpenClawConfig;
    migrateDefaultCommand.mockResolvedValueOnce({
      providerId: "codex",
      source: "/home/user/.codex",
      summary: {
        total: 1,
        planned: 0,
        migrated: 1,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "config:codex-plugins",
          kind: "config",
          action: "merge",
          status: "migrated",
          details: {
            path: ["plugins", "entries", "codex"],
            value: {
              enabled: true,
              config: {
                codexPlugins: {
                  enabled: true,
                  allow_destructive_actions: true,
                  plugins: {
                    gmail: {
                      enabled: true,
                      marketplaceName: "openai-curated",
                      pluginName: "gmail",
                    },
                  },
                },
              },
            },
          },
        },
      ],
    } as never);
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true) as WizardPrompter["confirm"],
    });

    const result = await offerPostInstallMigrations(
      buildBaseArgs({ config: inputConfig, prompter }),
    );

    expect(migrateDefaultCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        configOverride: inputConfig,
        configPatchMode: "return",
      }),
    );
    expect(result.config).not.toBe(inputConfig);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      appServer: { sandbox: "workspace-write" },
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: true,
        plugins: {
          gmail: {
            enabled: true,
            marketplaceName: "openai-curated",
            pluginName: "gmail",
          },
        },
      },
    });
    expect(inputConfig.plugins?.entries?.codex?.config).toEqual({
      appServer: { sandbox: "workspace-write" },
    });
  });

  it("does not invoke migrateDefaultCommand when the user declines", async () => {
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false) as WizardPrompter["confirm"],
    });

    await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("never prompts or applies in non-interactive mode", async () => {
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter();

    await offerPostInstallMigrations(buildBaseArgs({ prompter, nonInteractive: true }));

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("treats a non-TTY stdin as non-interactive even when nonInteractive flag is unset", async () => {
    setTTY(false);
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter();

    await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });

  it("swallows migrateDefaultCommand failures so onboarding can continue", async () => {
    const provider = buildProvider();
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    migrateDefaultCommand.mockRejectedValueOnce(new Error("boom"));
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true) as WizardPrompter["confirm"],
    });

    await expect(offerPostInstallMigrations(buildBaseArgs({ prompter }))).resolves.toEqual({
      config: {},
    });
    expect(migrateDefaultCommand).toHaveBeenCalledOnce();
  });

  it("falls back to a hint when detect throws", async () => {
    const provider = buildProvider({
      detect: vi.fn(async () => {
        throw new Error("detect failure");
      }),
    });
    setProviders([provider]);
    setOwnership("codex", ["codex"]);
    const prompter = createWizardPrompter();

    await offerPostInstallMigrations(buildBaseArgs({ prompter }));

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  });
});
