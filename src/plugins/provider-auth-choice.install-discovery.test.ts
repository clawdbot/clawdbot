import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-reader.js";
import { recordPluginInstall } from "./installs.js";
import * as loader from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { prepareAuthChoiceLoadedPluginProvider } from "./provider-auth-choice.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const install = vi.hoisted(() =>
  vi.fn<
    typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled
  >(),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: install,
}));
vi.mock("../commands/runtime-plugin-install.js", () => ({
  ensureModelSelectionRuntimePlugins: async ({ cfg }: { cfg: OpenClawConfig }) => ({
    ok: true,
    cfg,
    codexInstalled: false,
  }),
}));
vi.mock("./provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: () => ({
    pluginId: "installed-provider",
    providerId: "installed-provider",
    methodId: "selected",
    choiceId: "installed-provider-key",
    choiceLabel: "Installed provider",
    label: "Installed provider",
    origin: "bundled",
    install: { npmSpec: "@fixture/installed-provider", defaultChoice: "npm" },
  }),
}));

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  install.mockReset();
  resetPluginLoaderTestStateForTest();
  cleanupTrackedTempDirs(tempDirs);
});

it.each([false, true])(
  "continues installed-provider auth and model hooks without replacing the running registry (default %s)",
  async (setDefaultModel) => {
    const root = fs.realpathSync(makeTrackedTempDir("onboarding-installed-provider", tempDirs));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const projectRoot = path.join(stateDir, "npm", "projects", "installed-provider");
    const pluginRoot = path.join(projectRoot, "node_modules", "@fixture", "installed-provider");
    const config: OpenClawConfig = { gateway: { mode: "local" } };
    const acceptedSurface = {
      channels: [],
      providers: ["installed-provider"],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    };
    const trustedRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@fixture/installed-provider@1.0.0",
      installPath: pluginRoot,
      resolvedName: "@fixture/installed-provider",
      resolvedVersion: "1.0.0",
      integrity: "sha512-fixture-artifact",
      acceptedSurface,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
      acceptedSurfaceAt: "2026-09-05T00:00:00.000Z",
      acceptedSurfaceIntegrity: "sha512-fixture-artifact",
    };
    fs.mkdirSync(workspaceDir, { recursive: true });
    await withEnvAsync(
      {
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
      async () => {
        const env = { ...process.env };
        const runningMetadata = loadPluginMetadataSnapshot({
          config,
          workspaceDir,
          env,
          allowCurrent: false,
        });
        const runningRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(runningRegistry);
        const loaded = vi.spyOn(loader, "loadOpenClawPlugins");
        install.mockImplementation(async (params) => {
          // The initial provider lookup has already populated its lease's metadata
          // cache. Package acquisition and execution-runtime preparation are stubbed;
          // discovery, import, authentication, and model-hook dispatch remain real.
          fs.mkdirSync(pluginRoot, { recursive: true });
          fs.writeFileSync(
            path.join(projectRoot, "package.json"),
            JSON.stringify({
              private: true,
              dependencies: { "@fixture/installed-provider": "1.0.0" },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "package.json"),
            JSON.stringify({
              name: "@fixture/installed-provider",
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "openclaw.plugin.json"),
            JSON.stringify({
              id: "installed-provider",
              providers: ["installed-provider"],
              configSchema: { type: "object", properties: {}, additionalProperties: false },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "index.cjs"),
            `module.exports = {
        id: "installed-provider",
        register(api) {
          api.registerProvider({ id: "installed-provider", label: "Installed provider", auth: [
            { id: "unselected", label: "Other method", kind: "api_key",
              async run() { throw new Error("Unselected auth method ran"); } },
            { id: "selected", label: "Selected method", kind: "api_key",
              wizard: { choiceId: "installed-provider-key" },
              async run(ctx) {
                await ctx.prompter.text({ message: "Selected provider credential" });
                return { profiles: [], defaultModel: "installed-provider/fixture-model", configPatch: { plugins: { installs: {
                  "installed-provider": { source: "path", installPath: "/untrusted/provider-patch" }
                } } } };
              } }
          ], onModelSelected: async ({ model, prompter }) => {
            await prompter.note(model, "Installed provider model hook");
          } });
        }
      };`,
          );
          clearLoadInstalledPluginIndexInstallRecordsCache();
          const enabled = enableExplicitlySelectedPluginInConfig(params.cfg, "installed-provider");
          return {
            cfg: recordPluginInstall(enabled.config, {
              pluginId: "installed-provider",
              ...trustedRecord,
            }),
            pluginId: "installed-provider",
            installed: true,
            status: "installed",
          };
        });
        const prompter = createWizardPrompter();
        await withPluginRuntimeGenerationScope(
          { metadataSnapshot: runningMetadata, pluginRegistry: runningRegistry },
          async () => {
            const prepared = await prepareAuthChoiceLoadedPluginProvider({
              authChoice: "installed-provider-key",
              config,
              env,
              workspaceDir,
              agentDir: path.join(stateDir, "agents", "main", "agent"),
              agentId: "main",
              prompter,
              runtime: createNonExitingRuntime(),
              setDefaultModel,
            });
            expect(install).toHaveBeenCalledOnce();
            expect(prepared?.retrySelection).not.toBe(true);
            expect(prepared?.provider?.id).toBe("installed-provider");
            expect(prompter.text).toHaveBeenCalledWith({ message: "Selected provider credential" });
            if (setDefaultModel) {
              expect(prompter.note).toHaveBeenCalledWith(
                "installed-provider/fixture-model",
                "Installed provider model hook",
              );
              expect(prepared?.config.agents?.defaults?.model).toEqual({
                primary: "installed-provider/fixture-model",
              });
            } else {
              expect(prompter.note).not.toHaveBeenCalledWith(
                "installed-provider/fixture-model",
                "Installed provider model hook",
              );
              expect(prepared?.agentModelOverride).toBe("installed-provider/fixture-model");
            }
            const trusted = prepared?.pendingPluginInstalls?.["installed-provider"];
            expect(trusted).toMatchObject(trustedRecord);
            expect(
              loaded.mock.calls.some(
                ([options]) =>
                  options?.installRecords?.["installed-provider"]?.acceptedSurfaceIntegrity ===
                  trustedRecord.integrity,
              ),
            ).toBe(true);
            expect(getActivePluginRegistry()).toBe(runningRegistry);
            expect(getCurrentPluginMetadataSnapshot({ config, env, workspaceDir })).toBe(
              runningMetadata,
            );
            expect(runningMetadata.byPluginId.has("installed-provider")).toBe(false);
          },
        );
      },
    );
  },
);
