// Verifies provider runtime uses current plugin metadata snapshots.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { overlayExternalAuthProfiles } from "../agents/auth-profiles/external-auth.js";
import {
  listOwnedRuntimeAuthProfileStoreSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { FailoverError } from "../agents/failover-error.js";
import { isFallbackSummaryError } from "../agents/model-fallback-attempt.js";
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  makePluginMetadataIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import * as pluginLoader from "./loader.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

// Mock the persisted-registry loaders so direct metadata loads are observable.
// Provider hot paths should reuse a compatible current snapshot and only fall
// back to the loader when no compatible lifecycle-owned snapshot exists.
const loadPluginRegistrySnapshotWithMetadata = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (params: unknown) =>
      loadPluginRegistrySnapshotWithMetadata(params),
  };
});

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex: (params: unknown) =>
      loadPluginManifestRegistryForInstalledIndex(params),
  };
});

import { resolveExternalAuthProfilesWithPlugins } from "./provider-runtime.js";
import { isPluginProvidersLoadInFlight, resolvePluginProvidersCore } from "./providers.runtime.js";

const WORKSPACE = "/workspace/a";

function makeManifestRegistry(pluginId = "demo"): PluginManifestRegistry {
  const registry = makePluginMetadataManifestRegistry(pluginId);
  // Provider fixtures intentionally declare no command aliases.
  for (const plugin of registry.plugins) {
    plugin.commandAliases = [];
  }
  return registry;
}

// Build a snapshot from a provided index (no disk) and register it as the
// process-current snapshot, then clear the loader spies so later assertions only
// see calls triggered by the function under test.
function registerCurrentSnapshot(
  config: OpenClawConfig,
  workspaceDir = WORKSPACE,
  pluginId = "demo",
  env: NodeJS.ProcessEnv = {},
) {
  const index = makePluginMetadataIndex(pluginId);
  index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: index,
    diagnostics: [],
  });
  const snapshot = loadPluginMetadataSnapshot({ config, env, index, workspaceDir });
  setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
  loadPluginRegistrySnapshotWithMetadata.mockClear();
  loadPluginManifestRegistryForInstalledIndex.mockClear();
  return snapshot;
}

// Arm the loaders so a fallback disk load resolves to a usable snapshot.
function armFallbackLoad() {
  loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
    source: "runtime",
    snapshot: makePluginMetadataIndex(),
    diagnostics: [],
  });
}

describe("provider runtime consults the current plugin metadata snapshot", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    loadPluginRegistrySnapshotWithMetadata.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReset();
    loadPluginManifestRegistryForInstalledIndex.mockReturnValue(makeManifestRegistry());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  describe("isPluginProvidersLoadInFlight", () => {
    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      isPluginProvidersLoadInFlight({ config, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      isPluginProvidersLoadInFlight({ config: {}, env: {}, workspaceDir: WORKSPACE });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });

    it("falls back to a direct disk load when the workspace does not match", () => {
      registerCurrentSnapshot({}, WORKSPACE);
      armFallbackLoad();

      // allowWorkspaceScopedCurrent is intentionally not used, so a different
      // workspace misses the current snapshot and reloads.
      isPluginProvidersLoadInFlight({ config: {}, env: {}, workspaceDir: "/workspace/b" });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });

    it("keeps setup/doctor behavior on the direct disk load when no snapshot exists", () => {
      // Fresh setup/doctor CLI processes never register a current snapshot, so
      // consult-first resolves to the same fallback disk load as before.
      armFallbackLoad();

      isPluginProvidersLoadInFlight({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        mode: "setup",
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });

  describe("resolvePluginProvidersCore", () => {
    it.each([
      { source: "active", expectedLabels: ["Prepared demo"] },
      { source: "cached", expectedLabels: [] },
    ])(
      "rejects a same-ID provider from another source in the $source registry",
      ({ source, expectedLabels }) => {
        const config: OpenClawConfig = { plugins: { entries: { demo: { enabled: true } } } };
        const snapshot = registerCurrentSnapshot(config);
        const createRegistry = (rootDir: string, label: string) => {
          const registry = createEmptyPluginRegistry();
          registry.plugins.push(
            createPluginRecord({
              id: "demo",
              origin: "global",
              rootDir,
              source: `${rootDir}/index.js`,
              providerIds: ["demo"],
            }),
          );
          registry.providers.push({
            pluginId: "demo",
            rootDir,
            source: `${rootDir}/index.js`,
            provider: { id: "demo", label, auth: [] },
          });
          return registry;
        };
        const staleRegistry = createRegistry("/plugins/old-demo", "Stale demo");
        if (source === "active") {
          setActivePluginRegistry(staleRegistry, undefined, "default", WORKSPACE);
        }
        vi.spyOn(pluginLoader, "getRuntimePluginRegistryForLoadOptions").mockReturnValue(
          source === "active" ? createRegistry("/plugins/demo", "Prepared demo") : staleRegistry,
        );

        const providers = resolvePluginProvidersCore({
          config,
          env: {},
          workspaceDir: WORKSPACE,
          mode: "runtime",
          onlyPluginIds: ["demo"],
          pluginMetadataSnapshot: snapshot,
        });

        expect(providers.map((provider) => provider.label)).toEqual(expectedLabels);
        expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
        expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
      },
    );

    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      // onlyPluginIds:[] short-circuits provider materialization after the
      // snapshot is resolved, isolating the consult-first routing.
      const providers = resolvePluginProvidersCore({
        config,
        env: {},
        workspaceDir: WORKSPACE,
        mode: "runtime",
        onlyPluginIds: [],
      });

      expect(providers).toEqual([]);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      resolvePluginProvidersCore({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        mode: "runtime",
        onlyPluginIds: [],
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });

  describe("resolveExternalAuthProfilesWithPlugins", () => {
    it.each([
      "order",
      "locked profile",
      "exhaustion",
      "cron automatic pin",
      "cron user pin",
      "cron configured pin",
      "cron concurrent user pin",
    ] as const)("keeps captured auth aliases for %s", async (scenario) => {
      const previousStores = listOwnedRuntimeAuthProfileStoreSnapshots();
      onTestFinished(() => replaceOwnedRuntimeAuthProfileStoreSnapshots(previousStores));
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const models = ["one", "two"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          maxTokens: 1_024,
        }));
        const config: OpenClawConfig = {
          plugins: { entries: { captured: { enabled: true }, published: { enabled: true } } },
          models: {
            providers: {
              route: { baseUrl: "https://route.example/v1", models },
              backup: { baseUrl: "https://backup.example/v1", models },
            },
          },
        };
        const prepareAliases = (pluginId: string, workspaceDir: string) => {
          const manifestRegistry = makeManifestRegistry(pluginId);
          for (const plugin of manifestRegistry.plugins) {
            plugin.providerAuthAliases = { route: pluginId };
          }
          loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
          return registerCurrentSnapshot(config, workspaceDir, pluginId, process.env);
        };
        const pluginMetadataSnapshot = prepareAliases("captured", WORKSPACE);
        prepareAliases("published", "/workspace/b");
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            "captured:profile": { type: "api_key", provider: "captured", key: "fixture-a" },
            "published:profile": { type: "api_key", provider: "published", key: "fixture-b" },
            "backup:available": { type: "api_key", provider: "backup", key: "fixture-backup" },
          },
        };
        const capturedCooldown = Date.now() + 60_000;
        const publishedCooldown = capturedCooldown + 60_000;
        if (scenario === "order") {
          store.usageStats = {
            "captured:profile": { disabledUntil: capturedCooldown, disabledReason: "auth" },
          };
        } else if (scenario === "locked profile") {
          store.profiles["route:blocked"] = {
            type: "api_key",
            provider: "route",
            key: "fixture-blocked",
          };
          store.order = { route: ["route:blocked"] };
          store.usageStats = {
            "route:blocked": { disabledUntil: capturedCooldown, disabledReason: "auth" },
          };
        } else if (scenario === "exhaustion") {
          // Attempts start from prepared auth, then exhaustion must read the
          // newer persisted cooldowns through the same captured alias owner.
          saveAuthProfileStore(
            {
              ...store,
              usageStats: {
                "captured:profile": { disabledUntil: capturedCooldown, disabledReason: "auth" },
                "published:profile": { disabledUntil: publishedCooldown, disabledReason: "auth" },
              },
            },
            undefined,
            { filterExternalAuthProfiles: false, syncExternalCli: false },
          );
        }
        if (
          scenario === "cron automatic pin" ||
          scenario === "cron user pin" ||
          scenario === "cron configured pin" ||
          scenario === "cron concurrent user pin"
        ) {
          const agentId = "work";
          const sessionKey = "agent:work:cron:auth-context";
          const cronSession = resolveCronSession({
            cfg: config,
            sessionKey,
            agentId,
            nowMs: Date.now(),
            store: {},
          });
          const concurrentPin = scenario === "cron concurrent user pin";
          if (scenario !== "cron automatic pin") {
            cronSession.sessionEntry.authProfileOverride = "captured:profile";
            cronSession.sessionEntry.authProfileOverrideSource = concurrentPin ? "auto" : "user";
          }
          if (concurrentPin) {
            store.profiles["captured:manual"] = {
              type: "api_key",
              provider: "captured",
              key: "fixture-manual",
            };
            store.order = { route: ["captured:profile"] };
            store.usageStats = {
              "captured:profile": { disabledUntil: capturedCooldown, disabledReason: "auth" },
            };
          }
          const scope = { storePath: cronSession.storePath, sessionKey };
          const latestEntry = { ...cronSession.sessionEntry };
          if (concurrentPin) {
            latestEntry.authProfileOverride = "captured:manual";
            latestEntry.authProfileOverrideSource = "user";
          }
          await replaceSessionEntry(scope, latestEntry);
          const agentDir = state.agentDir(agentId);
          setRuntimeAuthProfileStoreSnapshot(store, agentDir);
          // The seed write initializes maintenance config before auth selection starts.
          const registryLoadsBeforeSelection =
            loadPluginRegistrySnapshotWithMetadata.mock.calls.length;
          const manifestLoadsBeforeSelection =
            loadPluginManifestRegistryForInstalledIndex.mock.calls.length;
          const selection = await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
            resolveSessionAuthSelection({
              cfg: config,
              provider: "route",
              modelId: "one",
              harnessRuntime: undefined,
              agentDir,
              workspaceDir: WORKSPACE,
              pluginMetadataSnapshot,
              configuredProfileId:
                scenario === "cron configured pin" ? "captured:profile" : undefined,
              sessionEntry: cronSession.sessionEntry,
              sessionStore: cronSession.store,
              storePath: cronSession.storePath,
              sessionKey,
              isNewSession: false,
            }),
          );
          const profileId = concurrentPin ? "captured:manual" : "captured:profile";
          const source = scenario === "cron automatic pin" ? "auto" : "user";
          expect(selection).toEqual({ profileId, source, routeRequirement: "api-key" });
          expect(loadPluginRegistrySnapshotWithMetadata.mock.calls.length).toBe(
            registryLoadsBeforeSelection,
          );
          expect(loadPluginManifestRegistryForInstalledIndex.mock.calls.length).toBe(
            manifestLoadsBeforeSelection,
          );
          expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
            authProfileOverride: profileId,
            authProfileOverrideSource: source,
          });
          return;
        }
        setRuntimeAuthProfileStoreSnapshot(store);
        const attempted: string[] = [];
        const result = withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
          runWithModelFallback({
            cfg: config,
            provider: "route",
            model: "one",
            workspaceDir: WORKSPACE,
            pluginMetadataSnapshot,
            fallbacksOverride: [scenario === "exhaustion" ? "route/two" : "backup/one"],
            ...(scenario === "locked profile"
              ? { userLockedAuthProfileId: "captured:profile" }
              : {}),
            run: async (provider, model) => {
              attempted.push(`${provider}/${model}`);
              if (scenario === "exhaustion") {
                throw new FailoverError("fixture auth failure", {
                  reason: "auth",
                  provider,
                  model,
                });
              }
              return provider;
            },
          }),
        );
        if (scenario === "exhaustion") {
          const failure = await result.catch((error: unknown) => error);
          expect(attempted).toEqual(["route/one", "route/two"]);
          expect(isFallbackSummaryError(failure) ? failure.soonestCooldownExpiry : undefined).toBe(
            capturedCooldown,
          );
        } else {
          const expectedProvider = scenario === "order" ? "backup" : "route";
          expect(await result).toMatchObject({
            outcome: "completed",
            result: expectedProvider,
            provider: expectedProvider,
            model: "one",
          });
        }
        expect(loadPluginRegistrySnapshotWithMetadata.mock.calls.length).toBe(0);
        expect(loadPluginManifestRegistryForInstalledIndex.mock.calls.length).toBe(0);
      });
    });

    it.each([
      {
        scope: "captured workspace",
        surface: "overlay",
        pluginIds: ["captured"],
        expected: ["captured:prepared"],
      },
      { scope: "explicit empty workspace", surface: "overlay", pluginIds: [], expected: [] },
      {
        scope: "captured workspace during fallback admission",
        surface: "fallback",
        pluginIds: ["captured"],
        expected: ["captured:prepared"],
      },
      {
        scope: "captured workspace during cron admission",
        surface: "cron",
        pluginIds: ["captured"],
        expected: ["captured:prepared"],
      },
      {
        scope: "captured workspace during configured-profile admission",
        surface: "configured",
        pluginIds: ["captured"],
        expected: ["captured:prepared"],
      },
    ])(
      "keeps external auth on the $scope after another workspace is published",
      async ({ surface, pluginIds, expected }) => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const env = surface === "overlay" ? {} : process.env;
          const configuredModel = {
            id: "model",
            name: "Fixture model",
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1_024,
          };
          const config: OpenClawConfig = {
            plugins: { entries: { captured: { enabled: true }, published: { enabled: true } } },
            ...(surface === "fallback"
              ? {
                  models: {
                    providers: {
                      captured: {
                        baseUrl: "https://captured.example/v1",
                        models: [configuredModel],
                      },
                      backup: {
                        baseUrl: "https://backup.example/v1",
                        models: [configuredModel],
                      },
                    },
                  },
                }
              : {}),
          };
          const prepareWorkspace = (pluginId: string, workspaceDir: string) => {
            const manifestRegistry = makeManifestRegistry(pluginId);
            for (const plugin of manifestRegistry.plugins) {
              plugin.contracts = { externalAuthProviders: [pluginId] };
            }
            loadPluginManifestRegistryForInstalledIndex.mockReturnValue(manifestRegistry);
            const snapshot = registerCurrentSnapshot(config, workspaceDir, pluginId, env);
            const registry = createEmptyPluginRegistry();
            const rootDir = `/plugins/${pluginId}`;
            registry.plugins.push(
              createPluginRecord({
                id: pluginId,
                origin: "global",
                rootDir,
                source: `${rootDir}/index.js`,
                providerIds: [pluginId],
              }),
            );
            registry.providers.push({
              pluginId,
              rootDir,
              source: `${rootDir}/index.js`,
              provider: {
                id: pluginId,
                label: pluginId,
                auth: [],
                resolveExternalAuthProfiles: (context) => [
                  {
                    profileId: `${pluginId}:${context.config === config && context.workspaceDir === workspaceDir ? "prepared" : "ambient"}`,
                    credential: {
                      type: "oauth",
                      provider: pluginId,
                      access: "fixture-access",
                      refresh: "fixture-refresh",
                      expires: Date.now() + 60_000,
                    },
                  },
                ],
              },
            });
            return { snapshot, registry };
          };
          const captured = prepareWorkspace("captured", WORKSPACE);
          const pluginMetadataSnapshot = projectPluginMetadataSnapshot(
            captured.snapshot,
            pluginIds,
          );
          const publishedWorkspace = "/workspace/b";
          const published = prepareWorkspace("published", publishedWorkspace);
          setActivePluginRegistry(published.registry, undefined, "default", publishedWorkspace);
          const overlayOptions = {
            config,
            workspaceDir: WORKSPACE,
            pluginMetadataSnapshot,
            env: {},
            allowKeychainPrompt: false,
          };

          if (surface === "cron" || surface === "configured") {
            const previousStores = listOwnedRuntimeAuthProfileStoreSnapshots();
            onTestFinished(() => replaceOwnedRuntimeAuthProfileStoreSnapshots(previousStores));
            const agentId = "work";
            const agentDir = state.agentDir(agentId);
            const sessionKey = "agent:work:cron:external-auth-context";
            const cronSession =
              surface === "cron"
                ? resolveCronSession({
                    cfg: config,
                    sessionKey,
                    agentId,
                    nowMs: Date.now(),
                    store: {},
                  })
                : undefined;
            if (cronSession) {
              cronSession.sessionEntry.authProfileOverride = "captured:prepared";
              cronSession.sessionEntry.authProfileOverrideSource = "user";
              await replaceSessionEntry(
                { storePath: cronSession.storePath, sessionKey },
                cronSession.sessionEntry,
              );
            }
            setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, agentDir);
            const registryLoadsBeforeSelection =
              loadPluginRegistrySnapshotWithMetadata.mock.calls.length;
            const manifestLoadsBeforeSelection =
              loadPluginManifestRegistryForInstalledIndex.mock.calls.length;
            const selection = await withPluginRuntimeRegistryScope(captured.registry, () =>
              resolveSessionAuthSelection({
                cfg: config,
                provider: "captured",
                modelId: "model",
                harnessRuntime: undefined,
                agentDir,
                workspaceDir: WORKSPACE,
                pluginMetadataSnapshot,
                ...(cronSession
                  ? {
                      sessionEntry: cronSession.sessionEntry,
                      sessionStore: cronSession.store,
                      storePath: cronSession.storePath,
                      sessionKey,
                    }
                  : { configuredProfileId: "captured:prepared" }),
                isNewSession: false,
              }),
            );
            expect(selection).toEqual({
              profileId: "captured:prepared",
              source: "user",
              routeRequirement: "subscription",
            });
            expect(loadPluginRegistrySnapshotWithMetadata.mock.calls.length).toBe(
              registryLoadsBeforeSelection,
            );
            expect(loadPluginManifestRegistryForInstalledIndex.mock.calls.length).toBe(
              manifestLoadsBeforeSelection,
            );
            if (cronSession) {
              expect(
                loadSessionEntry({
                  storePath: cronSession.storePath,
                  sessionKey,
                  readConsistency: "latest",
                }),
              ).toMatchObject({
                authProfileOverride: "captured:prepared",
                authProfileOverrideSource: "user",
              });
            }
          } else if (surface === "fallback") {
            const previousStores = listOwnedRuntimeAuthProfileStoreSnapshots();
            onTestFinished(() => replaceOwnedRuntimeAuthProfileStoreSnapshots(previousStores));
            setRuntimeAuthProfileStoreSnapshot({
              version: 1,
              profiles: {
                "captured:blocked": { type: "api_key", provider: "captured", key: "fixture-key" },
                "backup:available": { type: "api_key", provider: "backup", key: "fixture-backup" },
              },
              usageStats: {
                "captured:blocked": {
                  disabledUntil: Date.now() + 60_000,
                  disabledReason: "auth",
                },
              },
            });
            const result = await withPluginRuntimeRegistryScope(captured.registry, () =>
              runWithModelFallback({
                cfg: config,
                provider: "captured",
                model: "model",
                workspaceDir: WORKSPACE,
                pluginMetadataSnapshot,
                fallbacksOverride: ["backup/model"],
                userLockedAuthProfileId: "captured:prepared",
                run: async (provider) => provider,
              }),
            );
            expect(result).toMatchObject({
              outcome: "completed",
              result: "captured",
              provider: "captured",
              model: "model",
            });
            expect(loadPluginRegistrySnapshotWithMetadata.mock.calls.length).toBe(0);
            expect(loadPluginManifestRegistryForInstalledIndex.mock.calls.length).toBe(0);
          } else {
            const store = withPluginRuntimeRegistryScope(captured.registry, () =>
              overlayExternalAuthProfiles({ version: 1, profiles: {} }, overlayOptions),
            );

            expect(Object.keys(store.profiles)).toEqual(expected);
            expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
            expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
          }
        });
      },
    );

    it("reuses a compatible current snapshot without a direct disk load", () => {
      const config: OpenClawConfig = {};
      registerCurrentSnapshot(config);

      // The demo manifest declares no external-auth contracts, so resolution
      // short-circuits to [] right after the snapshot is consulted.
      const profiles = resolveExternalAuthProfilesWithPlugins({
        config,
        env: {},
        workspaceDir: WORKSPACE,
        context: { env: {}, store: { version: 1, profiles: {} } },
      });

      expect(profiles).toEqual([]);
      expect(loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
    });

    it("falls back to a direct disk load when no current snapshot is registered", () => {
      armFallbackLoad();

      resolveExternalAuthProfilesWithPlugins({
        config: {},
        env: {},
        workspaceDir: WORKSPACE,
        context: { env: {}, store: { version: 1, profiles: {} } },
      });

      expect(loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalled();
    });
  });
});
