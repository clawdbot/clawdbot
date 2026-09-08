import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import * as loader from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

const prepareProvider = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
  >(),
);
vi.mock("../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider: prepareProvider,
}));

afterEach(() => {
  vi.restoreAllMocks();
  prepareProvider.mockReset();
  resetPluginLoaderTestStateForTest();
});

it.each([false, true])(
  "binds a newly installed provider to its real artifact (replace during probe: %s)",
  async (replaceDuringProbe) => {
    await withOpenClawTestState(
      {
        label: "provider-install-owner",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const source: OpenClawConfig = {
          gateway: { mode: "local" },
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: { main: { default: true, workspace: state.workspaceDir } },
          },
          plugins: { entries: {} },
        };
        await state.writeConfig(source);
        const originalBytes = await fs.readFile(state.configPath, "utf8");
        const original = await readConfigFileSnapshot();
        const runningMetadata = resolvePluginMetadataSnapshot({
          config: original.runtimeConfig,
          workspaceDir: state.workspaceDir,
          env: process.env,
          allowCurrent: false,
        });
        const runningRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(runningRegistry);
        const loaded = vi.spyOn(loader, "loadPluginRegistryHandle");
        const projectRoot = state.statePath("npm", "projects", "fixture-provider");
        const pluginRoot = path.join(projectRoot, "node_modules", "@fixture", "provider");
        const pluginEntry = path.join(pluginRoot, "index.cjs");
        const pluginSource = `module.exports = {
        id: "fixture-provider", register(api) {
          api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [] });
        }
      };\n`;
        const integrity = "sha512-" + createHash("sha512").update(pluginSource).digest("base64");
        const resolvedAuth = {
          apiKey: "synthetic-owner-key",
          source: "config",
          mode: "api-key" as const,
        };
        const authFingerprint = fingerprintResolvedProviderAuth(resolvedAuth);
        if (!authFingerprint) {
          throw new Error("Synthetic credential has no fingerprint");
        }
        let trustedRecord: PluginInstallRecord | undefined;
        prepareProvider.mockImplementation(async (params) => {
          // Acquisition and auth are synthetic. Discovery, runtime registration,
          // owner fingerprints, activation checks, and final promotion are real.
          await fs.mkdir(pluginRoot, { recursive: true });
          await fs.writeFile(
            path.join(projectRoot, "package.json"),
            JSON.stringify({
              private: true,
              dependencies: { "@fixture/provider": "1.0.0" },
            }),
          );
          await fs.writeFile(
            path.join(pluginRoot, "package.json"),
            JSON.stringify({
              name: "@fixture/provider",
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          await fs.writeFile(
            path.join(pluginRoot, "openclaw.plugin.json"),
            JSON.stringify({
              id: "fixture-provider",
              providers: ["fixture-provider"],
              configSchema: { type: "object", properties: {}, additionalProperties: false },
            }),
          );
          await fs.writeFile(pluginEntry, pluginSource);
          const config: OpenClawConfig = {
            ...params.config,
            plugins: {
              ...params.config.plugins,
              entries: { ...params.config.plugins?.entries, "fixture-provider": { enabled: true } },
            },
            models: {
              providers: {
                "fixture-provider": {
                  baseUrl: "https://provider.example/v1",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          };
          const acceptedSurface = resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, {
            config,
          });
          trustedRecord = {
            source: "npm",
            spec: "@fixture/provider@1.0.0",
            installPath: pluginRoot,
            resolvedName: "@fixture/provider",
            resolvedVersion: "1.0.0",
            integrity,
            acceptedSurface,
            acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
            acceptedSurfaceAt: "2026-09-06T00:00:00.000Z",
            acceptedSurfaceIntegrity: integrity,
          };
          return {
            config,
            agentModelOverride: "fixture-provider/fixture-model",
            authProfiles: [],
            pendingPluginInstalls: { "fixture-provider": trustedRecord },
            persistAuthProfiles: async () => {},
            provider: { id: "fixture-provider", label: "Fixture", auth: [] },
          };
        });
        const capture = vi.fn(captureSystemAgentOwnerPluginArtifacts);
        const runEmbeddedAgent = vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(
          async (params) => {
            expect(onPreparationComplete).toHaveBeenCalledOnce();
            params.onSuccessfulAuthBinding?.({
              authFingerprint,
              agentHarnessId: "openclaw",
              modelId: "fixture-model",
              modelApi: "openai-completions",
            });
            if (replaceDuringProbe) {
              await fs.writeFile(pluginEntry, pluginSource + "// Replaced artifact.\n");
            }
            return {
              meta: {
                durationMs: 1,
                finalAssistantVisibleText: "OK",
                executionTrace: {
                  winnerProvider: "fixture-provider",
                  winnerModel: "fixture-model",
                },
              },
            };
          },
        );
        const onPreparationComplete = vi.fn(() => {
          expect(capture).toHaveBeenCalledOnce();
          expect(trustedRecord).toBeDefined();
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
        });
        await withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: runningMetadata,
            pluginRegistry: runningRegistry,
          },
          async () => {
            const result = await activateSetupInference({
              kind: "provider-auth",
              authChoice: "fixture-provider-key",
              agentId: "main",
              workspace: state.workspaceDir,
              surface: "gateway",
              recordSetupAudit: false,
              runtime: createNonExitingRuntime(),
              onPreparationComplete,
              prompter: createWizardPrompter(),
              deps: {
                resolveManifestProviderAuthChoice: () => ({
                  pluginId: "fixture-provider",
                  providerId: "fixture-provider",
                  methodId: "key",
                  choiceId: "fixture-provider-key",
                  choiceLabel: "Fixture",
                  appGuidedSecret: true,
                }),
                captureSystemAgentOwnerPluginArtifacts: capture,
                resolveApiKeyForProvider: async () => resolvedAuth,
                runEmbeddedAgent,
              },
            });
            expect(onPreparationComplete).toHaveBeenCalledOnce();
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(capture).toHaveBeenCalledOnce();
            const staged = capture.mock.results[0]?.value;
            expect(staged?.ownerPluginIds).toEqual(["fixture-provider"]);
            expect(staged?.ownerPluginArtifacts).toEqual([
              {
                pluginId: "fixture-provider",
                fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
              },
            ]);
            expect(
              loaded.mock.calls.some(
                ([options]) =>
                  options?.installRecords?.["fixture-provider"]?.acceptedSurfaceIntegrity ===
                  integrity,
              ),
            ).toBe(true);
            if (replaceDuringProbe) {
              expect(result).toMatchObject({ ok: false, status: "auth" });
              if (result.ok) {
                throw new Error("Replaced provider artifact was accepted");
              }
              expect(result.error).toContain("owner plugin runtime changed");
              expect(await fs.readFile(state.configPath, "utf8")).toBe(originalBytes);
            } else {
              expect(result).toMatchObject({
                ok: true,
                modelRef: "fixture-provider/fixture-model",
              });
              // The running generation intentionally retains its pre-install cache.
              const records = await withPluginLifecycleLease({}, () =>
                readPersistedInstalledPluginIndexInstallRecords({ stateDir: state.stateDir }),
              );
              if (!trustedRecord) {
                throw new Error("Installer did not prepare a trusted record");
              }
              expect(records?.["fixture-provider"]).toMatchObject(trustedRecord);
            }
            expect(getActivePluginRegistry()).toBe(runningRegistry);
            expect(getCurrentPluginMetadataSnapshot({ config: original.runtimeConfig })).toBe(
              runningMetadata,
            );
            expect(runningMetadata.byPluginId.has("fixture-provider")).toBe(false);
          },
        );
      },
    );
  },
);
