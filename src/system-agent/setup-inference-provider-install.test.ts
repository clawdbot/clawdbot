import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginEnable from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { buildTestPlan } from "./setup-inference-plan.js";
import { retainSetupProviderInstall } from "./setup-inference-provider-install.js";

const install = vi.hoisted(() =>
  vi.fn<
    typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled
  >(),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: install,
}));

afterEach(() => {
  vi.restoreAllMocks();
  install.mockReset();
});

function fixture(
  options: {
    declined?: boolean;
    cancelBeforeCommit?: boolean;
    capabilityRemoved?: boolean;
    denied?: boolean;
  } = {},
) {
  let installed = false;
  const controller = new AbortController();
  const choice: ProviderAuthChoiceMetadata = {
    pluginId: "fixture-provider",
    providerId: "fixture",
    methodId: "api-key",
    choiceId: "fixture-key",
    choiceLabel: "Fixture API key",
    appGuidedSecret: true,
    onboardingScopes: ["text-inference"],
  };
  const catalog: ProviderInstallCatalogEntry = {
    ...choice,
    label: "Fixture",
    origin: "bundled",
    install: { npmSpec: "@openclaw/fixture-provider", defaultChoice: "npm" },
  };
  const config: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    ...(options.denied ? { plugins: { deny: [choice.pluginId] } } : {}),
  };
  const record = {
    source: "npm" as const,
    spec: "@openclaw/fixture-provider",
    installPath: "/fixture/provider",
  };
  const run = vi.fn<ProviderPlugin["auth"][number]["run"]>(async (ctx) => ({
    profiles: [
      {
        profileId: "fixture:default",
        credential: { type: "api_key", provider: "fixture", key: ctx.opts?.token ?? "missing" },
      },
    ],
    defaultModel: "fixture/model",
  }));
  const provider: ProviderPlugin = {
    id: "fixture",
    pluginId: choice.pluginId,
    label: "Fixture",
    auth: [{ id: "api-key", label: "API key", kind: "api_key", run }],
  };
  const resolvePluginProviders = vi.fn(() => [provider]);
  const markRetainedManagedNpmInstall = vi.fn(async () => true);
  vi.spyOn(pluginEnable, "enablePluginWithCapabilityConsent").mockImplementation(async (cfg, id) =>
    pluginEnable.enablePluginInConfig(cfg, id),
  );
  install.mockImplementation(async (params) => {
    if (options.declined) {
      return { cfg: params.cfg, installed: false, pluginId: choice.pluginId, status: "skipped" };
    }
    if (options.cancelBeforeCommit) {
      controller.abort();
    }
    await params.beforePersistentEffect?.();
    installed = true;
    return {
      cfg: {
        ...pluginEnable.enablePluginInConfig(params.cfg, choice.pluginId).config,
        plugins: {
          entries: { [choice.pluginId]: { enabled: true } },
          installs: { [choice.pluginId]: record },
        },
      },
      installed: true,
      pluginId: choice.pluginId,
      status: "installed",
    };
  });
  const prepare = () =>
    buildTestPlan({
      kind: "api-key",
      authChoice: choice.choiceId,
      apiKey: "entered-fixture-key",
      cfg: config,
      sourceCfg: config,
      workspaceDir: "/fixture/probe",
      pluginWorkspaceDir: "/fixture/workspace",
      agentDir: "/fixture/agent",
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
      signal: controller.signal,
      deps: {
        resolveManifestProviderAuthChoice: () =>
          installed ? { ...choice, appGuidedSecret: !options.capabilityRemoved } : undefined,
        resolveProviderInstallCatalogEntry: () => catalog,
        resolvePluginProviders,
        resolvePluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
        markRetainedManagedNpmInstall,
      },
    });
  return { prepare, run, resolvePluginProviders, markRetainedManagedNpmInstall, config, record };
}

describe("cold provider setup activation", () => {
  it("refuses matching install readback after lifecycle ownership is lost", async () => {
    const record = { source: "npm" as const, installPath: "/fixture/provider" };
    const markRetainedManagedNpmInstall = vi.fn(async () => true);
    const retained = await retainSetupProviderInstall({
      pluginId: "fixture-provider",
      record,
      verifyOwnership: true,
      deps: {
        readPersistedInstalledPluginIndexInstallRecords: async () =>
          withPluginLifecycleLease({}, async (lease) => {
            vi.spyOn(lease, "assertOwned").mockImplementation(() => {
              throw new Error("Lifecycle ownership lost during readback");
            });
            return { "fixture-provider": record };
          }),
        markRetainedManagedNpmInstall,
      },
    });
    expect(retained).toBe(false);
    expect(markRetainedManagedNpmInstall).not.toHaveBeenCalled();
  });

  it("keeps ownership verification and retention inside the same lifecycle lease", async () => {
    let assertOwned: (() => void) | undefined;
    const retained = await retainSetupProviderInstall({
      pluginId: "fixture-provider",
      record: { source: "npm", installPath: "/fixture/provider" },
      verifyOwnership: true,
      deps: {
        readPersistedInstalledPluginIndexInstallRecords: async () =>
          withPluginLifecycleLease({}, async (lease) => {
            assertOwned = () => lease.assertOwned();
            return {};
          }),
        markRetainedManagedNpmInstall: async () => {
          if (!assertOwned) {
            throw new Error("Ownership was not verified");
          }
          assertOwned();
          return true;
        },
      },
    });
    expect(retained).toBe(true);
  });

  it("installs the selected catalog owner, revalidates its manifest, and stages the exact entered key without selecting a default", async () => {
    const test = fixture();
    const plan = await test.prepare();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          pluginId: "fixture-provider",
          trustedSourceLinkedOfficialInstall: true,
        }),
      }),
    );
    expect(test.markRetainedManagedNpmInstall).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "fixture-provider", packageDir: "/fixture/provider" }),
    );
    expect(plan).toMatchObject({
      modelRef: "fixture/model",
      installedProviderPlugin: "fixture-provider",
      manualAuth: {
        profiles: [
          expect.objectContaining({
            credential: { type: "api_key", provider: "fixture", key: "entered-fixture-key" },
          }),
        ],
      },
    });
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.authProfileId).toMatch(/^fixture:setup-/);
    expect(plan.config.plugins?.installs?.["fixture-provider"]).toEqual(test.record);
    expect(plan.config.agents?.defaults?.model).toBeUndefined();
    expect(test.config).toEqual({ agents: { entries: { main: { default: true } } } });
    expect(test.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["fixture-provider"] }),
    );
  });

  it.each([{ declined: true }, { denied: true }, { capabilityRemoved: true }])(
    "never executes auth when setup is declined, blocked, or no longer supported: %j",
    async (options) => {
      const test = fixture(options);
      expect(await test.prepare()).toHaveProperty("error");
      expect(test.run).not.toHaveBeenCalled();
      expect(test.resolvePluginProviders).not.toHaveBeenCalled();
      if (options.denied) {
        expect(install).not.toHaveBeenCalled();
      }
    },
  );

  it("checks cancellation before the installer commits artifacts", async () => {
    const test = fixture({ cancelBeforeCommit: true });
    await expect(test.prepare()).rejects.toThrow(/cancelled|aborted/);
    expect(test.markRetainedManagedNpmInstall).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.resolvePluginProviders).not.toHaveBeenCalled();
  });
});
