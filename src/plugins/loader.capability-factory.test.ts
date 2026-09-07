import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  registryContainsRuntimePluginIds,
  resolveCompatibleRuntimePluginRegistry,
} from "./active-runtime-registry.js";
import type { PluginCapabilityCatalogContext } from "./capability-catalog-context.types.js";
import { isPluginRegistryLoadInFlight, resolvePluginRegistryLoadCacheKey } from "./loader-cache.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { loadOpenClawPluginsWithInternalOverrides } from "./loader-runtime-load.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, getPluginCache, withPluginCache } from "./plugin-cache.js";
import { pluginLoaderCacheState } from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

const families = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;
const contextSymbol = Symbol.for("fixture.capability-context");

function createContext(): PluginCapabilityCatalogContext {
  const unavailable = () => {
    throw new Error("registration invoked a host operation");
  };
  return {
    isProviderApiKeyConfigured: unavailable,
    isProviderAuthProfileConfigured: unavailable,
    resolveAgentDir: unavailable,
    createRealtimeTranscriptionWebSocketSession: unavailable,
    resolveProviderRequestHeaders: unavailable,
    resolveProviderAuthProfileApiKey: unavailable,
    resolveApiKeyForProvider: unavailable,
    captureWsEvent: unavailable,
    createDebugProxyWebSocketAgent: unavailable,
    resolveDebugProxySettings: unavailable,
    fetchWithSsrFGuard: unavailable,
    createProviderHttpError: unavailable,
    readProviderJsonResponse: unavailable,
    readProviderTextResponse: unavailable,
    formatErrorMessage: vi.fn(() => "ready"),
    warn: unavailable,
    redactSensitiveText: unavailable,
  };
}

async function withFactoryPlugin(
  extension: "cjs" | "ts",
  register: string,
  run: (options: PluginLoadOptions, root: string) => Promise<void> | void,
  manifest?: Record<string, unknown>,
) {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const plugin = writePlugin({
    id: "factory-owner",
    dir: path.join(root, "plugin"),
    filename: `index.${extension}`,
    body: `${extension === "ts" ? "export default" : "module.exports ="} {
      id: "factory-owner",
      register(api) {
        ${register}
      }
    };`,
  });
  if (manifest) {
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", additionalProperties: false },
        ...manifest,
      }),
    );
  }
  await withEnvAsync(
    {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    },
    async () =>
      await run(
        {
          config: {
            plugins: {
              allow: [plugin.id],
              load: { paths: [plugin.file] },
              slots: { memory: "none" },
            },
          },
          pluginSdkResolution: "src",
          activate: false,
        },
        root,
      ),
  );
}

function loadRestricted(options: PluginLoadOptions) {
  return loadOpenClawPluginsWithInternalOverrides(
    { ...options, cache: false },
    {
      runtime: {
        config: {
          current: () => options.config ?? {},
          mutateConfigFile: async () => {
            throw new Error("restricted registration cannot mutate config");
          },
          replaceConfigFile: async () => {
            throw new Error("restricted registration cannot replace config");
          },
        },
      },
      moduleLoader: { installNativeSdkResolver: false, loaderFilename: import.meta.url },
    },
  );
}

const registerFactories = `
  const providerId = api.runtime.modelAuth.resolveProviderIdForAuth(" Fixture ", { metadataSnapshot: { plugins: [] } });
  const model = api.runtime.modelConfig.resolveAllowedModelRef({
    cfg: api.config, catalog: [], raw: "fixture/allowed", defaultProvider: "fixture", manifestPlugins: [],
  });
  if (providerId !== "fixture" || model?.key !== "fixture/allowed") {
    throw new Error("native model policy bindings are unavailable");
  }
  const createProvider = (host) => {
    const provider = {
      id: "factory-provider", label: "Factory provider",
      isConfigured: () => host.formatErrorMessage(new Error("ready")) === "ready",
      synthesize: async () => { throw new Error("not synthesis"); },
      createSession: () => { throw new Error("not a session"); },
      createBridge: () => { throw new Error("not a bridge"); }
    };
    Object.defineProperty(provider, Symbol.for("fixture.capability-context"), { value: host });
    return provider;
  };
  api.registerSpeechProvider(createProvider);
  api.registerRealtimeTranscriptionProvider(createProvider);
  api.registerRealtimeVoiceProvider(createProvider);
  api.registerService({ id: "factory-lifecycle", start() {} });
`;

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("retains the creating cache generation when broad services initialize later", () => {
  const owner = createPluginCache();
  const replacement = createPluginCache();
  const runtime = { events: {} } as PluginRuntime;
  const createPluginRuntime = vi.fn(() => {
    expect(getPluginCache()).toBe(owner);
    return runtime;
  });
  const loadPluginModule = vi.fn(() => {
    expect(getPluginCache()).toBe(owner);
    return { createPluginRuntime };
  });
  const lazyRuntime = withPluginCache(owner, () => createLazyPluginRuntime({ loadPluginModule }));
  expect(loadPluginModule).not.toHaveBeenCalled();
  withPluginCache(replacement, () => {
    expect(lazyRuntime.events).toBe(runtime.events);
    expect(lazyRuntime.events).toBe(runtime.events);
  });
  expect(loadPluginModule).toHaveBeenCalledTimes(1);
  expect(createPluginRuntime).toHaveBeenCalledTimes(1);
});

describe.each(["cjs", "ts"] as const)("%s capability factory registration", (extension) => {
  it.each(["injected", "default", "restricted-injected", "restricted-default"] as const)(
    "retains complete runtime descriptors with %s host composition",
    async (mode) => {
      await withFactoryPlugin(extension, registerFactories, (options) => {
        const injected = mode.endsWith("injected");
        const context = injected ? createContext() : undefined;
        const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
        resolveRuntime.mockImplementation(() => {
          throw new Error("native factory registration must not load the broad runtime module");
        });
        const loadOptions = { ...options, capabilityCatalogContext: context };
        const registry = mode.startsWith("restricted")
          ? loadRestricted(loadOptions)
          : loadOpenClawPlugins(loadOptions);
        expect(registry.plugins).toContainEqual(
          expect.objectContaining({ id: "factory-owner", status: "loaded" }),
        );
        expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(true);
        expect(registry.services.map((entry) => entry.service.id)).toEqual(["factory-lifecycle"]);
        const runtime = getPluginRegistryRuntime(registry)!;
        for (const facet of ["modelAuth", "modelConfig"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(runtime, facet);
          expect(descriptor).toEqual({
            configurable: true,
            enumerable: true,
            get: expect.any(Function),
            set: undefined,
          });
        }
        const contexts = families.map((family) => {
          expect(registry[family]).toHaveLength(1);
          const provider = registry[family][0]!.provider;
          expect(Object.getOwnPropertyDescriptor(provider, contextSymbol)?.enumerable).toBe(false);
          const host = Reflect.get(provider, contextSymbol) as PluginCapabilityCatalogContext;
          if (context) {
            expect(host).toBe(context);
            expect(context.formatErrorMessage).not.toHaveBeenCalled();
          }
          return host;
        });
        expect(contexts[1]).toBe(contexts[0]);
        expect(contexts[2]).toBe(contexts[0]);
        expect(typeof contexts[0]!.isProviderApiKeyConfigured).toBe("function");
        expect(typeof contexts[0]!.createRealtimeTranscriptionWebSocketSession).toBe("function");
        expect(
          registry.speechProviders[0]!.provider.isConfigured({
            cfg: {},
            providerConfig: {},
            timeoutMs: 1000,
          }),
        ).toBe(true);
        expect(resolveRuntime).not.toHaveBeenCalled();
      });
    },
  );

  it("agrees on raw authored options during load, cache reuse, and active lookup", async () => {
    await withFactoryPlugin(
      extension,
      'api.logger.info("inside registration");' + registerFactories,
      (options) => {
        let inFlightAtRegistration: boolean | undefined;
        const authored: PluginLoadOptions = Object.freeze({
          ...options,
          activate: true,
          runtimeOptions: Object.freeze({}),
          logger: {
            info: (message) => {
              if (message.includes("inside registration")) {
                inFlightAtRegistration = isPluginRegistryLoadInFlight(authored);
              }
            },
            warn() {},
            error() {},
            debug() {},
          },
        });
        const cacheKey = resolvePluginRegistryLoadCacheKey(authored);
        const registry = loadOpenClawPlugins(authored);
        expect(inFlightAtRegistration).toBe(true);
        expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(true);
        expect(isPluginRegistryLoadInFlight(authored)).toBe(false);
        expect(resolvePluginRegistryLoadCacheKey(authored)).toBe(cacheKey);
        expect(pluginLoaderCacheState.get(cacheKey)).toBe(registry);
        expect(resolveCompatibleRuntimePluginRegistry(authored)).toBe(registry);
        expect(loadOpenClawPlugins(authored)).toBe(registry);
        expect(authored).not.toHaveProperty("capabilityCatalogContext");
        expect(authored.runtimeOptions).toEqual({});
      },
    );
  }, 120_000);

  it("cold-loads a synchronous external-auth and capability-factory hybrid", async () => {
    const register = `
      let host;
      api.registerSpeechProvider((context) => {
        host = context;
        return {
          id: "factory-provider", label: "Factory provider",
          isConfigured: () => true,
          synthesize: async () => { throw new Error("not synthesis"); },
        };
      });
      api.registerProvider({
        id: "factory-provider", label: "Factory provider", auth: [],
        resolveExternalAuthProfiles() {
          if (!host) throw new Error("capability factory context was not bound");
          return [{
            profileId: "factory-provider:external", persistence: "runtime-only",
            credential: { type: "oauth", provider: "factory-provider",
              access: host.formatErrorMessage(new Error("hybrid-ready")),
              refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 },
          }];
        },
      });
    `;
    await withFactoryPlugin(
      extension,
      register,
      (options, root) => {
        const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
        resolveRuntime.mockImplementation(() => {
          throw new Error("cold external auth must use native factory composition");
        });
        const agentDir = path.join(root, "state", "agents", "main", "agent");
        const store = loadAuthProfileStoreForRuntime(agentDir, {
          config: options.config,
          readOnly: true,
          syncExternalCli: false,
          externalCli: { mode: "none", config: options.config },
        });
        expect(store.profiles["factory-provider:external"]).toMatchObject({
          type: "oauth",
          provider: "factory-provider",
          access: "hybrid-ready",
        });
        expect(store.runtimeExternalProfileIds).toContain("factory-provider:external");
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({});
        expect(resolveRuntime).not.toHaveBeenCalled();
      },
      {
        providers: ["factory-provider"],
        contracts: { externalAuthProviders: ["factory-provider"] },
      },
    );
  }, 120_000);

  it("partitions registry reuse by native context identity", async () => {
    await withFactoryPlugin(extension, registerFactories, (options) => {
      const firstContext = createContext();
      const firstOptions = { ...options, capabilityCatalogContext: firstContext };
      const first = loadOpenClawPlugins(firstOptions);
      expect(first.speechProviders).toHaveLength(1);
      expect(loadOpenClawPlugins(firstOptions)).toBe(first);
      const secondContext = createContext();
      const second = loadOpenClawPlugins({ ...options, capabilityCatalogContext: secondContext });
      expect(second).not.toBe(first);
      expect(Reflect.get(first.speechProviders[0]!.provider, contextSymbol)).toBe(firstContext);
      expect(Reflect.get(second.speechProviders[0]!.provider, contextSymbol)).toBe(secondContext);
      const firstRuntime = getPluginRegistryRuntime(first)!;
      const secondRuntime = getPluginRegistryRuntime(second)!;
      firstRuntime.modelAuth.resolveProviderIdForAuth = () => "first-only";
      expect(firstRuntime.modelAuth.resolveProviderIdForAuth("fixture")).toBe("first-only");
      expect(
        secondRuntime.modelAuth.resolveProviderIdForAuth(" Fixture ", {
          metadataSnapshot: { plugins: [] },
        }),
      ).toBe("fixture");
    });
  });

  it.each([
    { body: 'throw new Error("factory failed");', error: "factory failed" },
    { body: 'return Promise.reject(new Error("factory rejected"));', error: "must be synchronous" },
    { body: "return Promise.resolve({});", error: "must be synchronous" },
    {
      body: 'return { then(resolve, reject) { reject(new Error("thenable rejected")); } };',
      error: "must be synchronous",
    },
  ])(
    "rolls back a failed factory without an unhandled rejection: $body",
    async ({ body, error }) => {
      await withFactoryPlugin(
        extension,
        `api.registerSpeechProvider({
        id: "before-failure", label: "Before failure", isConfigured: () => true,
        synthesize: async () => { throw new Error("not synthesis"); }
      });
      api.registerRealtimeVoiceProvider(() => { ${body} });`,
        async (options) => {
          const registry = loadOpenClawPlugins({
            ...options,
            capabilityCatalogContext: createContext(),
          });
          expect(registry.plugins).toContainEqual(
            expect.objectContaining({
              id: "factory-owner",
              status: "error",
              error: expect.stringContaining(error),
            }),
          );
          for (const family of families) {
            expect(registry[family]).toEqual([]);
          }
          expect(registry.modelCatalogProviders).toEqual([]);
          expect(registryContainsRuntimePluginIds(registry, ["factory-owner"])).toBe(false);
          // Assimilated rejected promises/thenables must settle inside the host rejection handler.
          await Promise.resolve();
          await Promise.resolve();
        },
      );
    },
  );
});
