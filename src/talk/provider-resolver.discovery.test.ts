import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import { createVoiceProviderFixture } from "./provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProviders } from "./provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "./provider-resolver.js";

function withVoiceProviders(
  run: (cfg: OpenClawConfig) => void,
  policy: OpenClawConfig["plugins"] = {},
) {
  const { cfg, env } = createVoiceProviderFixture(policy);
  return withEnv(env, () => run(cfg));
}

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("realtime voice provider discovery", () => {
  it.each(
    [false, true].flatMap((activeReady) =>
      ["configured-voice", "configured-voice-alias"].map((configKey) => ({
        activeReady,
        configKey,
      })),
    ),
  )(
    "discovers $configKey config when the active provider is configured=$activeReady",
    ({ activeReady, configKey }) => {
      withVoiceProviders((cfg) => {
        const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
        expect(registry.realtimeVoiceProviders.map((entry) => entry.provider.id)).toEqual([
          "active-voice",
        ]);

        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: {
            "active-voice": { ready: activeReady },
            [configKey]: { ready: true },
          },
        });

        expect(result.provider.id).toBe("configured-voice");
        expect(result.providerConfig).toEqual({ ready: true, resolved: true });
        // Per-call discovery must not broaden catalogs or replace active objects.
        expect(listRealtimeVoiceProviders(cfg)).toEqual(
          registry.realtimeVoiceProviders.map((entry) => entry.provider),
        );
      });
    },
  );

  it.each(
    ["configured-voice", "configured-voice-alias"].flatMap((configKey) =>
      [undefined, " ", configKey].map((configuredProviderId) => ({
        configKey,
        configuredProviderId,
      })),
    ),
  )(
    "selects cold $configKey config with explicit selection $configuredProviderId",
    ({ configuredProviderId, configKey }) => {
      withVoiceProviders((cfg) => {
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          configuredProviderId,
          providerConfigs: { [configKey]: { ready: true } },
        });
        expect(result.provider.id).toBe("configured-voice");
      });
    },
  );

  it("keeps environment-configured providers eligible with an unconfigured default map", () => {
    withEnv({ VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER: "active-voice" }, () => {
      withVoiceProviders((cfg) => {
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: { "configured-voice": { ready: false } },
        });
        expect(result.provider.id).toBe("active-voice");
      });
    });
  });

  it("extends a cold config-derived discovery scope with per-call candidates", () => {
    withVoiceProviders((cfg) => {
      cfg.talk = { realtime: { provider: "active-voice" } };
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: { "configured-voice": { ready: true } },
      });
      expect(result.provider.id).toBe("configured-voice");
    });
  });

  it.each([
    ["active-voice", "configured-voice-alias"],
    ["configured-voice-alias", "active-voice"],
  ])("discovers mixed canonical and runtime-alias candidates %s + %s", (scopeId, candidateId) => {
    withEnv({ VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER: "configured-voice" }, () => {
      withVoiceProviders((cfg) => {
        cfg.talk = { realtime: { provider: scopeId } };
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: { [candidateId]: {} },
        });
        expect(result.provider.id).toBe("configured-voice");
      });
    });
  });

  it.each([
    { label: "disabled", policy: { entries: { "configured-voice": { enabled: false } } } },
    { label: "denied", policy: { deny: ["configured-voice"] } },
    { label: "not allowed", policy: { allow: ["active-voice"] } },
  ])("does not auto-select a $label configured owner", ({ policy }) => {
    withVoiceProviders((cfg) => {
      loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    }, policy);
  });

  it("does not discover configured owners when plugins are globally disabled", () => {
    withVoiceProviders(
      (cfg) => {
        expect(() =>
          resolveConfiguredRealtimeVoiceProvider({
            cfg,
            providerConfigs: { "configured-voice": { ready: true } },
          }),
        ).toThrow("No realtime voice provider registered");
      },
      { enabled: false },
    );
  });

  it("keeps a caller-supplied provider list authoritative", () => {
    withVoiceProviders((cfg) => {
      const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providers: registry.realtimeVoiceProviders.map((entry) => entry.provider),
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    });
  });
});
