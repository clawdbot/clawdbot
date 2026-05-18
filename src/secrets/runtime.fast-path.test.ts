import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/path-constants.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resolveOAuthPath } from "../config/paths.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig } from "./runtime.test-support.js";

const { resolveRuntimeWebToolsMock, runtimePrepareImportMock } = vi.hoisted(() => ({
  resolveRuntimeWebToolsMock: vi.fn(async () => ({
    search: { providerSource: "none", diagnostics: [] },
    fetch: { providerSource: "none", diagnostics: [] },
    diagnostics: [],
  })),
  runtimePrepareImportMock: vi.fn(),
}));

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
    resolveRuntimeWebTools: resolveRuntimeWebToolsMock,
  };
});

function emptyAuthStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

function requireGatewayAuth(
  snapshot: Awaited<ReturnType<typeof import("./runtime.js").prepareSecretsRuntimeSnapshot>>,
) {
  const auth = snapshot.config.gateway?.auth;
  if (!auth) {
    throw new Error("expected gateway auth config");
  }
  return auth;
}

function writeAuthProfileStore(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, AUTH_PROFILE_FILENAME),
    `${JSON.stringify({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
    })}\n`,
  );
}

describe("secrets runtime fast path", () => {
  afterEach(() => {
    runtimePrepareImportMock.mockClear();
    resolveRuntimeWebToolsMock.mockClear();
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
    expect(requireGatewayAuth(snapshot).token).toBe("plain-startup-token");
    expect(snapshot.authStores).toEqual([
      {
        agentDir: "/tmp/openclaw-agent-main",
        store: emptyAuthStore(),
      },
    ]);
  });

  it("uses the fast path when web fetch only configures runtime limits", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              maxChars: 200_000,
              maxCharsCap: 2_000_000,
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [],
          entries: {},
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
    expect(snapshot.webTools.fetch.providerSource).toBe("none");
  });

  it("uses the fast path when web fetch is explicitly disabled", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: false,
              maxChars: 200_000,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
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

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit web fetch provider config on the resolver path", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "oauth credentials file",
      setup: (env: NodeJS.ProcessEnv, _mainAgentDir: string, _agentDir: string) => {
        const credentialsPath = resolveOAuthPath(env);
        mkdirSync(path.dirname(credentialsPath), { recursive: true });
        writeFileSync(
          credentialsPath,
          `${JSON.stringify({
            "openai-codex": {
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          })}\n`,
        );
      },
    },
    {
      name: "inherited main auth store",
      setup: (_env: NodeJS.ProcessEnv, mainAgentDir: string, _agentDir: string) => {
        writeAuthProfileStore(mainAgentDir);
      },
    },
  ])("skips the startup-only fast path when $name exists", async ({ setup }) => {
    const { prepareSecretsRuntimeFastPathSnapshot } = await import("./runtime-fast-path.js");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-fast-path-"));
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
    };
    const mainAgentDir = resolveDefaultAgentDir({}, env);
    const agentDir = path.join(root, "custom-agent");
    mkdirSync(agentDir, { recursive: true });
    setup(env, mainAgentDir, agentDir);

    try {
      const snapshot = prepareSecretsRuntimeFastPathSnapshot({
        config: asConfig({
          agents: {
            list: [{ id: "default", agentDir }],
          },
        }),
        env,
      });

      expect(snapshot).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes startup-only fast-path snapshots from persisted auth stores after startup", async () => {
    const { prepareSecretsRuntimeFastPathSnapshot } = await import("./runtime-fast-path.js");
    const { activateSecretsRuntimeSnapshotState, getActiveSecretsRuntimeSnapshot } =
      await import("./runtime-state.js");
    const { refreshActiveSecretsRuntimeSnapshot } = await import("./runtime.js");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-fast-path-refresh-"));
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
    };
    const agentDir = path.join(root, "custom-agent");
    mkdirSync(agentDir, { recursive: true });

    try {
      const fastPath = prepareSecretsRuntimeFastPathSnapshot({
        config: asConfig({
          agents: {
            list: [{ id: "default", agentDir }],
          },
        }),
        env,
      });

      expect(fastPath).not.toBeNull();
      activateSecretsRuntimeSnapshotState({
        snapshot: fastPath!.snapshot,
        refreshContext: fastPath!.refreshContext,
        refreshHandler: null,
      });
      writeAuthProfileStore(agentDir);

      await expect(refreshActiveSecretsRuntimeSnapshot()).resolves.toBe(true);
      const active = getActiveSecretsRuntimeSnapshot();
      expect(active?.authStores[0]?.agentDir).toBe(agentDir);
      expect(active?.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins empty auth stores on startup-only fast-path snapshots until refresh", async () => {
    const { ensureAuthProfileStoreWithoutExternalProfiles } =
      await import("../agents/auth-profiles/store.js");
    const { prepareSecretsRuntimeFastPathSnapshot } = await import("./runtime-fast-path.js");
    const { activateSecretsRuntimeSnapshotState } = await import("./runtime-state.js");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-fast-path-empty-store-"));
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
    };
    const agentDir = path.join(root, "custom-agent");
    mkdirSync(agentDir, { recursive: true });

    try {
      const fastPath = prepareSecretsRuntimeFastPathSnapshot({
        config: asConfig({
          agents: {
            list: [{ id: "default", agentDir }],
          },
        }),
        env,
      });

      expect(fastPath).not.toBeNull();
      expect(fastPath!.snapshot.authStores).toEqual([{ agentDir, store: emptyAuthStore() }]);
      activateSecretsRuntimeSnapshotState({
        snapshot: fastPath!.snapshot,
        refreshContext: fastPath!.refreshContext,
        refreshHandler: null,
      });
      writeAuthProfileStore(agentDir);

      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles["openai:default"],
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
