import { describe, expect, it, vi } from "vitest";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resolveStoredModelOverride } from "./stored-model-overrides.js";

function withPreparedConfig<T>(config: OpenClawConfig, run: () => T): T {
  return withPluginRuntimeGenerationScope(
    {
      config,
      metadataSnapshot: createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
    },
    run,
  );
}

describe("resolveStoredModelOverride", () => {
  it.each(["session", "parent"] as const)(
    "resolves a bare %s override from the selected agent's configured provider",
    (source) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: { model: "global-provider/global-model" },
          entries: { work: { model: "agent-provider/default-model" } },
        },
      };
      const entry = { sessionId: "selected", updatedAt: 1, modelOverride: "pinned-model" };
      const result = withPreparedConfig(config, () =>
        resolveStoredModelOverride({
          config,
          agentId: "work",
          ...(source === "session"
            ? { sessionEntry: entry }
            : { parentSessionKey: "parent", sessionStore: { parent: entry } }),
        }),
      );

      expect(result).toEqual({
        provider: "agent-provider",
        model: "pinned-model",
        source,
        routeResolution: "raw",
      });
    },
  );

  it("keeps an explicit default provider ahead of the configured provider", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "configured-provider/default-model" } },
    };
    const result = withPreparedConfig(config, () =>
      resolveStoredModelOverride({
        config,
        defaultProvider: "explicit-provider",
        sessionEntry: { sessionId: "selected", updatedAt: 1, modelOverride: "pinned-model" },
      }),
    );

    expect(result).toEqual({
      provider: "explicit-provider",
      model: "pinned-model",
      source: "session",
      routeResolution: "raw",
    });
  });

  it("does not resolve configured models when neither session has an override", () => {
    const config: OpenClawConfig = {
      get agents(): never {
        throw new Error("unused configured model was read");
      },
    };
    const loadSessionEntry = vi.fn(() => ({ sessionId: "parent", updatedAt: 1 }));

    expect(
      resolveStoredModelOverride({
        config,
        sessionEntry: { sessionId: "child", updatedAt: 2, modelOverride: " " },
        parentSessionKey: "parent",
        loadSessionEntry,
      }),
    ).toBeNull();
    expect(loadSessionEntry).toHaveBeenCalledExactlyOnceWith("parent");
  });

  it.each([
    ...(["raw", "explicit", "legacy"] as const).map((provenance) => ({
      name: `${provenance} route provenance`,
      provenance,
      storedModel: "legacy",
      configuredModel: undefined,
      expectedModel: provenance === "raw" ? "runtime-manifest-model" : "manifest-model",
      runtimeCalls: provenance === "raw" ? 2 : 0,
    })),
    {
      name: "an exact configured model",
      provenance: "raw",
      storedModel: "legacy",
      configuredModel: "legacy",
      expectedModel: "manifest-model",
      runtimeCalls: 0,
    },
    {
      name: "a raw literal configured self-prefix",
      provenance: "raw",
      storedModel: "stored-provider/legacy",
      configuredModel: "stored-provider/legacy",
      expectedModel: "stored-provider/legacy",
      runtimeCalls: 0,
    },
    {
      name: "a resolved literal configured self-prefix",
      provenance: "explicit",
      storedModel: "stored-provider/legacy",
      configuredModel: "stored-provider/legacy",
      expectedModel: "stored-provider/legacy",
      runtimeCalls: 0,
    },
    {
      name: "an unconfigured legacy provider-wrapped id",
      provenance: "raw",
      storedModel: "stored-provider/legacy",
      configuredModel: undefined,
      expectedModel: "runtime-manifest-model",
      runtimeCalls: 2,
    },
    {
      name: "a legacy wrapper around a configured id",
      provenance: "raw",
      storedModel: "stored-provider/legacy",
      configuredModel: "legacy",
      expectedModel: "runtime-manifest-model",
      runtimeCalls: 2,
    },
    {
      name: "an unmatched model under a configured provider",
      provenance: "raw",
      storedModel: "legacy",
      configuredModel: "another-model",
      expectedModel: "runtime-manifest-model",
      runtimeCalls: 2,
    },
  ])(
    "applies stored model normalization for $name",
    ({ provenance, storedModel, configuredModel, expectedModel, runtimeCalls }) => {
      const config: OpenClawConfig = configuredModel
        ? {
            models: {
              providers: {
                "Stored-Provider": {
                  baseUrl: "https://stored-provider.test/v1",
                  models: [
                    {
                      id: configuredModel,
                      name: "Configured stored model",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 4096,
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
          }
        : {};
      const manifestRegistry = makeRegistry([
        { id: "stored-provider", channels: [], providers: ["stored-provider"] },
      ]);
      const manifest = manifestRegistry.plugins[0]!;
      manifest.modelIdNormalization = {
        providers: { "stored-provider": { aliases: { legacy: "manifest-model" } } },
      };
      const normalizeModelId = vi.fn(({ modelId }: { modelId: string }) => `runtime-${modelId}`);
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.plugins.push(
        createPluginRecord({
          id: manifest.id,
          source: manifest.source,
          rootDir: manifest.rootDir,
          origin: manifest.origin,
          providerIds: manifest.providers,
        }),
      );
      pluginRegistry.providers.push({
        pluginId: manifest.id,
        source: manifest.source,
        rootDir: manifest.rootDir,
        provider: {
          id: "stored-provider",
          label: "Stored provider",
          auth: [],
          normalizeModelId,
        },
      });
      const sessionEntry = {
        sessionId: "stored-selection",
        updatedAt: 1,
        providerOverride: "stored-provider",
        modelOverride: storedModel,
        ...(provenance === "explicit"
          ? { modelOverrideRouteResolution: "resolved" as const }
          : provenance === "legacy"
            ? {
                modelOverrideSource: "auto" as const,
                modelOverrideFallbackOriginProvider: "origin-provider",
                modelOverrideFallbackOriginModel: "origin-model",
              }
            : {}),
      };
      const { result, projection } = withPluginRuntimeGenerationScope(
        {
          config,
          metadataSnapshot: createPluginMetadataSnapshot({ config, manifestRegistry }),
          pluginRegistry,
        },
        () => ({
          result: resolveStoredModelOverride({
            config,
            defaultProvider: "unused-provider",
            sessionEntry,
          }),
          projection: resolveSessionModelRef(config, sessionEntry),
        }),
      );

      expect(result).toEqual({
        provider: "stored-provider",
        model: expectedModel,
        source: "session",
        routeResolution: provenance === "raw" ? "raw" : "resolved",
      });
      expect(projection).toEqual({
        provider: "stored-provider",
        model: expectedModel,
      });
      expect(normalizeModelId).toHaveBeenCalledTimes(runtimeCalls);
    },
  );

  it("recovers resolved provenance for legacy auto-fallback overrides", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionEntry: {
          sessionId: "legacy-fallback",
          updatedAt: 1,
          providerOverride: "cloudflare-ai-gateway",
          modelOverride: "gemini-2.5-flash-lite",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
      }),
    ).toMatchObject({ routeResolution: "resolved" });
  });

  it("loads parent overrides without requiring a whole session store", () => {
    const loadSessionEntry = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:telegram:dm:parent"
        ? {
            sessionId: "parent-session",
            updatedAt: 1782259200000,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-7",
          }
        : undefined,
    );

    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        loadSessionEntry,
        sessionKey: "agent:main:telegram:dm:parent:thread:child",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-7",
      source: "parent",
      routeResolution: "raw",
    });
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:telegram:dm:parent");
  });

  it("does not inherit active automatic fallback overrides from parent sessions", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
            modelOverrideFallbackOriginProvider: "openai",
            modelOverrideFallbackOriginModel: "gpt-primary",
          },
        },
      }),
    ).toBeNull();
  });

  it("inherits configured automatic selections without fallback provenance", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "legacy-parent-session",
            updatedAt: 1,
            providerOverride: "google-vertex",
            modelOverride: "gemini-fallback",
            modelOverrideSource: "auto",
          },
        },
      }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-fallback",
      source: "parent",
      routeResolution: "raw",
    });
  });

  it("continues to inherit deliberate parent model pins", () => {
    expect(
      resolveStoredModelOverride({
        defaultProvider: "openai",
        sessionKey: "agent:main:discord:channel:root:thread:child",
        sessionStore: {
          "agent:main:discord:channel:root": {
            sessionId: "parent-session",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-sonnet-4-6",
            modelOverrideSource: "user",
          },
        },
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      source: "parent",
      routeResolution: "raw",
    });
  });
});
