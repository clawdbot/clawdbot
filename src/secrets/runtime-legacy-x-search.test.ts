import { describe, expect, it, vi } from "vitest";
import {
  asConfig,
  getResolvePluginWebSearchProvidersMock,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

vi.mock("../channels/plugins/bootstrap-registry.js", () => {
  return {
    getBootstrapChannelPlugin: (id: string) =>
      id === "telegram"
        ? {
            secrets: {
              collectRuntimeConfigAssignments: () => {},
            },
          }
        : undefined,
    getBootstrapChannelSecrets: (id: string) =>
      id === "telegram"
        ? {
            collectRuntimeConfigAssignments: () => {},
          }
        : undefined,
  };
});

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();

describe("secrets runtime snapshot legacy x_search", () => {
  it("keeps legacy x_search SecretRefs in place until doctor repairs them", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      apiKey: "xai-runtime-key",
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(getResolvePluginWebSearchProvidersMock()).not.toHaveBeenCalled();
  });

  it("still resolves legacy x_search auth in place even when unrelated legacy config is present", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
              enabled: true,
            },
          },
        },
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key-invalid-config",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      apiKey: "xai-runtime-key-invalid-config",
      enabled: true,
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(getResolvePluginWebSearchProvidersMock()).not.toHaveBeenCalled();
  });

  it("does not force-enable xai at runtime for knob-only x_search config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(getResolvePluginWebSearchProvidersMock()).not.toHaveBeenCalled();
  });
});
