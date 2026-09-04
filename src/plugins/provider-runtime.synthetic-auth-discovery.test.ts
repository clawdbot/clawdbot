/** Verifies provider runtime discovery includes synthetic-auth provider hooks. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSyntheticLocalProviderAuth } from "../agents/model-auth-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

const nativeProvider = vi.hoisted(() => ({
  id: "native-auth",
  label: "Native auth",
  aliases: ["native-alias"],
  auth: [],
  prepareSyntheticAuth: vi.fn<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>>(),
}));

const resolveProviderRuntimePlugin = vi.hoisted(() =>
  vi.fn<() => ProviderPlugin | undefined>(() => undefined),
);
const resolvePluginDiscoveryProvidersRuntime = vi.hoisted(() =>
  vi.fn<() => ProviderPlugin[]>(() => [
    nativeProvider,
    {
      id: "anthropic-vertex",
      label: "Anthropic Vertex",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "gcp-vertex-credentials",
        source: "gcp-vertex-credentials (ADC)",
        mode: "api-key" as const,
      }),
    },
    {
      id: "ollama",
      label: "Ollama",
      auth: [],
      resolveSyntheticAuth: ({
        provider,
        providerConfig,
      }: {
        provider: string;
        providerConfig?: { api?: string; baseUrl?: string };
      }) =>
        providerConfig?.api === "ollama" && providerConfig.baseUrl?.startsWith("http://10.")
          ? {
              apiKey: "ollama-local",
              source: `models.providers.${provider} (synthetic local key)`,
              mode: "api-key" as const,
            }
          : undefined,
    },
  ]),
);

vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  return {
    ...actual,
    testing: {},
    prepareProviderExtraParams: vi.fn(),
    resolveProviderHookPlugin: vi.fn(),
    resolveProviderPluginsForHooks: vi.fn(() => []),
    resolveProviderRuntimePlugin,
    wrapProviderStreamFn: vi.fn(),
  };
});

vi.mock("./provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime,
}));

const resolveProviderOwnerIds = vi.hoisted(() =>
  vi.fn(({ provider }: { provider: string }) =>
    provider === "ollama"
      ? ["ollama"]
      : provider === "anthropic-vertex"
        ? ["anthropic-vertex"]
        : provider === "native-auth" || provider === "native-alias"
          ? ["native-auth"]
          : [],
  ),
);

vi.mock("./providers.js", () => ({
  resolveCatalogHookProviderPluginIds: vi.fn(() => []),
  resolveExternalAuthProfileProviderPluginIds: vi.fn(() => []),
  resolveOwningPluginIdsForProvider: resolveProviderOwnerIds,
  resolveOwningPluginIdsForProviderRef: resolveProviderOwnerIds,
}));

import {
  captureProviderSyntheticAuthFacts,
  prepareProviderSyntheticAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "./provider-runtime.js";
import {
  prepareSyntheticAuthWithProvider,
  resolveSyntheticAuthWithProvider,
  restorePreparedSyntheticAuthFacts,
} from "./provider-synthetic-auth.js";

const nativeAuth = { apiKey: "native-marker", source: "native auth", mode: "oauth" as const };

function nativeParams(config = {}, env = {}, workspaceDir = "/workspace") {
  return {
    config,
    env,
    workspaceDir,
    provider: "native-auth",
    context: { config, provider: "native-auth" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeProvider.prepareSyntheticAuth.mockReset().mockResolvedValue(nativeAuth);
});

describe("resolveProviderSyntheticAuthWithPlugin", () => {
  it("falls back to lightweight discovery providers when runtime hooks are unavailable", () => {
    expect(
      resolveProviderSyntheticAuthWithPlugin({
        provider: "anthropic-vertex",
        context: {
          config: undefined,
          provider: "anthropic-vertex",
          providerConfig: undefined,
        },
      }),
    ).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "gcp-vertex-credentials (ADC)",
      mode: "api-key",
    });
    expect(resolveProviderRuntimePlugin).not.toHaveBeenCalled();
    expect(resolvePluginDiscoveryProvidersRuntime).toHaveBeenCalled();
  });

  it("uses the configured provider api as the synthetic-auth hook owner", () => {
    expect(
      resolveProviderSyntheticAuthWithPlugin({
        provider: "ollama-remote",
        context: {
          config: undefined,
          provider: "ollama-remote",
          providerConfig: {
            api: "ollama",
            baseUrl: "http://10.0.0.8:11434",
            apiKey: "ollama-local",
            models: [],
          },
        },
      }),
    ).toEqual({
      apiKey: "ollama-local",
      source: "models.providers.ollama-remote (synthetic local key)",
      mode: "api-key",
    });
  });

  it.each([
    { route: "discovery", result: nativeAuth },
    { route: "discovery", result: undefined },
    { route: "runtime wrappers", result: nativeAuth },
    { route: "runtime wrappers", result: undefined },
  ])(
    "publishes and reuses native availability through $route: $result",
    async ({ route, result }) => {
      const params = nativeParams();
      nativeProvider.prepareSyntheticAuth.mockResolvedValue(result);
      const verify = async () => {
        expect(resolveProviderSyntheticAuthWithPlugin(params)).toBeUndefined();
        expect(nativeProvider.prepareSyntheticAuth).not.toHaveBeenCalled();
        expect(
          await Promise.all([
            prepareProviderSyntheticAuthWithPlugin(params),
            prepareProviderSyntheticAuthWithPlugin(params),
          ]),
        ).toEqual([result, result]);
        expect(
          await prepareProviderSyntheticAuthWithPlugin({
            ...params,
            signal: new AbortController().signal,
          }),
        ).toEqual(result);
        expect(resolveProviderSyntheticAuthWithPlugin(params)).toEqual(result);
        expect(nativeProvider.prepareSyntheticAuth).toHaveBeenCalledOnce();
      };
      if (route === "runtime wrappers") {
        await resolveProviderRuntimePlugin.withImplementation(
          () => ({ ...nativeProvider }),
          async () =>
            await resolvePluginDiscoveryProvidersRuntime.withImplementation(() => [], verify),
        );
      } else {
        await verify();
      }
    },
  );

  it("keeps pure runtime auth ahead of unrelated discovery", async () => {
    const resolveSyntheticAuth = vi.fn(() => nativeAuth);
    const provider: ProviderPlugin = {
      id: "config-auth",
      label: "Config auth",
      auth: [],
      resolveSyntheticAuth,
    };
    await resolveProviderRuntimePlugin.withImplementation(
      () => provider,
      async () =>
        await resolvePluginDiscoveryProvidersRuntime.withImplementation(
          () => {
            throw new Error("Unrelated provider discovery must stay lazy");
          },
          async () => {
            expect(
              await prepareSyntheticLocalProviderAuth({ cfg: {}, provider: provider.id }),
            ).toEqual(nativeAuth);
          },
        ),
    );
    expect(resolveSyntheticAuth).toHaveBeenCalledOnce();
  });

  it.each(["config", "env", "workspace", "provider generation"])(
    "does not reuse native facts across a changed %s",
    async (changed) => {
      const params = nativeParams();
      await prepareProviderSyntheticAuthWithPlugin(params);
      nativeProvider.prepareSyntheticAuth.mockResolvedValue(undefined);
      const replacement =
        changed === "provider generation"
          ? { ...nativeProvider, prepareSyntheticAuth: vi.fn(async () => undefined) }
          : nativeProvider;
      const next = {
        ...params,
        ...(changed === "config" ? { config: {} } : {}),
        ...(changed === "env" ? { env: {} } : {}),
        ...(changed === "workspace" ? { workspaceDir: "/other-workspace" } : {}),
      };
      const context = { config: next.config, provider: next.provider };
      expect(resolveSyntheticAuthWithProvider(replacement, context, next)).toBeUndefined();
      expect(await prepareSyntheticAuthWithProvider(replacement, context, next)).toBeUndefined();
      expect(replacement.prepareSyntheticAuth).toHaveBeenCalledTimes(
        changed === "provider generation" ? 1 : 2,
      );
      expect(resolveProviderSyntheticAuthWithPlugin(params)).toEqual(nativeAuth);
    },
  );

  it("joins each cancellation scope without cancelling or evicting another probe", async () => {
    const started = createDeferredCore();
    const cleanup = createDeferredCore();
    const available = createDeferredCore();
    const controller = new AbortController();
    const otherController = new AbortController();
    const reason = new Error("native preparation cancelled");
    nativeProvider.prepareSyntheticAuth
      .mockImplementationOnce(async ({ signal }) => {
        started.resolve(undefined);
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await cleanup.promise;
        return undefined;
      })
      .mockImplementationOnce(async () => {
        await available.promise;
        return nativeAuth;
      });
    const params = nativeParams();
    let settled = false;
    const pending = prepareProviderSyntheticAuthWithPlugin({
      ...params,
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await started.promise;
    const otherParams = { ...params, signal: otherController.signal };
    const active = prepareProviderSyntheticAuthWithPlugin(otherParams);
    const activeResult = Promise.allSettled([active]);
    const calls = [pending, active];
    try {
      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      cleanup.resolve(undefined);
      await rejected;
      expect(resolveProviderSyntheticAuthWithPlugin(params)).toBeUndefined();

      const follower = prepareProviderSyntheticAuthWithPlugin(otherParams);
      calls.push(follower);
      const followerResult = Promise.allSettled([follower]);
      available.resolve(undefined);
      expect(await activeResult).toEqual([{ status: "fulfilled", value: nativeAuth }]);
      expect(await followerResult).toEqual([{ status: "fulfilled", value: nativeAuth }]);
      expect(resolveProviderSyntheticAuthWithPlugin(params)).toEqual(nativeAuth);
      expect(nativeProvider.prepareSyntheticAuth).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      otherController.abort();
      cleanup.resolve(undefined);
      available.resolve(undefined);
      await Promise.allSettled(calls);
    }
  });

  it("captures fresh known-empty facts and keeps restored workers closed to probing", async () => {
    const params = nativeParams();
    const capture = () =>
      captureProviderSyntheticAuthFacts({ ...params, providerRefs: ["native-auth"] });
    const available = await capture();
    expect(available[0]?.result).toEqual(nativeAuth);
    nativeProvider.prepareSyntheticAuth.mockResolvedValue(undefined);
    const unavailable = await capture();
    expect(unavailable[0]?.result).toBeNull();
    expect(nativeProvider.prepareSyntheticAuth).toHaveBeenCalledTimes(2);

    const worker = nativeParams();
    restorePreparedSyntheticAuthFacts(worker.config, unavailable, worker);
    expect(await prepareProviderSyntheticAuthWithPlugin(worker)).toBeUndefined();
    expect(resolveProviderSyntheticAuthWithPlugin(worker)).toBeUndefined();
    await expect(
      prepareProviderSyntheticAuthWithPlugin({
        ...worker,
        provider: "native-alias",
        context: { config: worker.config, provider: "native-alias" },
      }),
    ).rejects.toThrow("Prepared synthetic auth is missing");
    await expect(prepareProviderSyntheticAuthWithPlugin({ ...worker, env: {} })).rejects.toThrow(
      "environment or workspace does not match",
    );
    expect(nativeProvider.prepareSyntheticAuth).toHaveBeenCalledTimes(2);
  });

  it.each([nativeAuth, undefined])(
    "reads captured alias outcomes before reopening worker discovery: %j",
    async (result) => {
      nativeProvider.prepareSyntheticAuth.mockResolvedValue(result);
      const params = nativeParams();
      const facts = await captureProviderSyntheticAuthFacts({
        ...params,
        providerRefs: ["native-alias"],
      });
      const worker = nativeParams();
      const lookup = {
        ...worker,
        provider: "native-alias",
        context: { config: worker.config, provider: "native-alias" },
      };
      restorePreparedSyntheticAuthFacts(worker.config, facts, worker);
      const workerHook = vi.fn(() => ({ ...nativeAuth, apiKey: "unexpected-worker-probe" }));
      const workerProvider: ProviderPlugin = {
        ...nativeProvider,
        prepareSyntheticAuth: undefined,
        resolveSyntheticAuth: workerHook,
      };
      resolvePluginDiscoveryProvidersRuntime.mockClear();
      await resolvePluginDiscoveryProvidersRuntime.withImplementation(
        () => [workerProvider],
        async () => {
          expect(resolveProviderSyntheticAuthWithPlugin(lookup)).toEqual(result);
          expect(await prepareProviderSyntheticAuthWithPlugin(lookup)).toEqual(result);
          expect(resolveSyntheticAuthWithProvider(workerProvider, lookup.context, worker)).toEqual(
            result,
          );
          expect(resolvePluginDiscoveryProvidersRuntime).not.toHaveBeenCalled();
        },
      );
      expect(workerHook).not.toHaveBeenCalled();
    },
  );

  it("captures the canonical pure result when it precedes an async alias fallback", async () => {
    const config = {
      models: {
        providers: {
          "custom-native": { api: "ollama" as const, baseUrl: "http://localhost", models: [] },
        },
      },
    };
    const resolveSyntheticAuth = vi.fn(() => nativeAuth);
    resolveProviderRuntimePlugin
      .mockReturnValueOnce({
        ...nativeProvider,
        prepareSyntheticAuth: undefined,
        resolveSyntheticAuth,
      })
      .mockReturnValueOnce({ ...nativeProvider, id: "ollama" });
    await resolvePluginDiscoveryProvidersRuntime.withImplementation(
      () => [],
      async () => {
        expect(
          await captureProviderSyntheticAuthFacts({ config, providerRefs: ["custom-native"] }),
        ).toEqual([{ providerRef: "custom-native", result: nativeAuth }]);
      },
    );
    expect(resolveSyntheticAuth).toHaveBeenCalledOnce();
    expect(nativeProvider.prepareSyntheticAuth).not.toHaveBeenCalled();
  });
});
