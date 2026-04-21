import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig } from "./runtime.test-support.js";

const runtimePrepareImportMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-prepare.runtime.js", () => {
  runtimePrepareImportMock();
  return {
    createResolverContext: ({ sourceConfig, env }: { sourceConfig: unknown; env: unknown }) => ({
      sourceConfig,
      env,
      cache: {},
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    }),
    collectConfigAssignments: () => undefined,
    collectAuthStoreAssignments: () => undefined,
    resolveSecretRefValues: async () => new Map(),
    applyResolvedAssignments: () => undefined,
    resolveRuntimeWebTools: async () => ({
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    }),
  };
});

function emptyAuthStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

describe("secrets runtime fast path", () => {
  afterEach(() => {
    runtimePrepareImportMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.resetModules();
  });

  it("skips heavy resolver loading when config and auth stores have no SecretRefs", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: "plain-startup-token",
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
    expect(snapshot.config.gateway?.auth?.token).toBe("plain-startup-token");
    expect(snapshot.authStores).toEqual([
      {
        agentDir: "/tmp/openclaw-agent-main",
        store: emptyAuthStore(),
      },
    ]);
  });

  it("uses the resolver path when an auth profile store contains a SecretRef", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      }),
    });

    expect(runtimePrepareImportMock).toHaveBeenCalledTimes(1);
  });
});
