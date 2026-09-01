/** Tests secrets runtime fast-path decisions and skip conditions. */
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { resolveLegacyOAuthPath } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig } from "./runtime.test-support.js";

const { collectConfigAssignmentsMock, resolveRuntimeWebToolsMock, runtimePrepareImportMock } =
  vi.hoisted(() => ({
    collectConfigAssignmentsMock:
      vi.fn<typeof import("./runtime-config-collectors.js").collectConfigAssignments>(),
    resolveRuntimeWebToolsMock: vi.fn<
      typeof import("./runtime-web-tools.js").resolveRuntimeWebTools
    >(async () => ({
      metadata: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
      degradedOwners: [],
      secretOwners: [],
    })),
    runtimePrepareImportMock: vi.fn(),
  }));

function explicitMainRoster() {
  return { agents: { list: [{ id: "main" }] } };
}

vi.mock("./runtime-prepare.runtime.js", () => {
  runtimePrepareImportMock();
  return {
    createResolverContext: ({
      sourceConfig,
      env,
      manifestRegistry,
    }: {
      sourceConfig: unknown;
      env: unknown;
      manifestRegistry?: unknown;
    }) => ({
      sourceConfig,
      env,
      cache: {},
      ...(manifestRegistry ? { manifestRegistry } : {}),
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    }),
    collectConfigAssignments: collectConfigAssignmentsMock,
    collectAuthStoreAssignments: () => undefined,
    resolveRuntimeWebTools: resolveRuntimeWebToolsMock,
  };
});

vi.mock("./runtime-owner-assignments.js", () => ({
  listSecretAssignmentOwners: () => [],
  resolveAndApplySecretAssignments: async () => ({
    degradedOwners: [],
    resolvedValues: new Map(),
  }),
}));

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
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

describe("secrets runtime fast path", () => {
  afterEach(() => {
    collectConfigAssignmentsMock.mockReset();
    runtimePrepareImportMock.mockClear();
    resolveRuntimeWebToolsMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    closeOpenClawAgentDatabasesForTest();
    vi.resetModules();
  });

  it("skips heavy resolver loading when config and auth stores have no SecretRefs", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        ...explicitMainRoster(),
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
    expect(snapshot.authStores.map(({ agentDir, store }) => ({ agentDir, store }))).toEqual([
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
        ...explicitMainRoster(),
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
        ...explicitMainRoster(),
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
      config: asConfig(explicitMainRoster()),
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
        ...explicitMainRoster(),
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

  it("reuses published plugin metadata without reopening manifests for configured web search", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");
    const { collectConfigAssignments } = await import("./runtime-config-collectors.js");
    const { resolveRuntimeWebTools } = await import("./runtime-web-tools.js");
    const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
    const { setCurrentPluginMetadataSnapshot } =
      await import("../plugins/current-plugin-metadata.test-support.js");
    const { listAgentWorkspaceDirs } = await import("../agents/workspace-dirs.js");
    const config = asConfig({
      ...explicitMainRoster(),
      tools: { web: { search: { provider: "webiq" } } },
      plugins: {
        enabled: true,
        allow: ["workiq-code-mode", "tools-code-mode", "webiq", "diagnostics-otel", "brave"],
        entries: {
          "workiq-code-mode": { config: { enabledNamespaces: ["m365", "search"] } },
          "tools-code-mode": { enabled: true },
          webiq: { enabled: true, config: { webSearch: { omitAuth: true, region: "US" } } },
          "diagnostics-otel": { enabled: true },
        },
      },
    });
    const workspaceDir = listAgentWorkspaceDirs(config, process.env)[0];
    const pluginMetadataSnapshot = loadPluginMetadataSnapshot({
      config,
      env: process.env,
      workspaceDir,
    });
    expect(pluginMetadataSnapshot.plugins.length).toBeGreaterThan(0);
    setCurrentPluginMetadataSnapshot(pluginMetadataSnapshot, {
      config,
      env: process.env,
      workspaceDir,
    });
    collectConfigAssignmentsMock.mockImplementationOnce(collectConfigAssignments);
    resolveRuntimeWebToolsMock.mockImplementationOnce(resolveRuntimeWebTools);
    const openSyncSpy = vi.spyOn(fs, "openSync");
    const probeDescriptor = fs.openSync(pluginMetadataSnapshot.plugins[0]!.manifestPath, "r");
    fs.closeSync(probeDescriptor);
    expect(openSyncSpy).toHaveBeenCalledOnce();
    openSyncSpy.mockClear();

    try {
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config,
        env: process.env,
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: emptyAuthStore,
      });

      const manifestOpens = openSyncSpy.mock.calls.filter(
        ([filePath]) => typeof filePath === "string" && filePath.endsWith("/openclaw.plugin.json"),
      );
      expect(snapshot.webTools.search.diagnostics).toEqual(expect.any(Array));
      expect(manifestOpens).toHaveLength(0);
    } finally {
      openSyncSpy.mockRestore();
      setCurrentPluginMetadataSnapshot(undefined);
    }
  });

  it("skips the startup-only fast path when the inherited main auth store exists", async () => {
    const { prepareSecretsRuntimeFastPathSnapshot } = await import("./runtime-fast-path.js");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-fast-path-"));
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_STATE_DIR: root,
    };
    const mainAgentDir = path.join(root, "agents", "main", "agent");
    const agentDir = path.join(root, "custom-agent");
    mkdirSync(agentDir, { recursive: true });
    writeAuthProfileStore(mainAgentDir);

    try {
      const snapshot = prepareSecretsRuntimeFastPathSnapshot({
        config: asConfig({
          agents: {
            list: [{ id: "main", agentDir }],
          },
        }),
        env,
      });

      expect(snapshot).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects retired OAuth before entering the secrets fast path", async () => {
    const { assertAuthProfileMigrationReady, hasLegacyAuthProfileSourcesForStartup } =
      await import("../agents/auth-profiles/legacy-source-diagnostic.js");
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-legacy-preflight-"));
    const env: NodeJS.ProcessEnv = { HOME: root, OPENCLAW_STATE_DIR: root };
    const credentialsPath = resolveLegacyOAuthPath(env);
    mkdirSync(path.dirname(credentialsPath), { recursive: true });
    writeFileSync(credentialsPath, '{"openai":{"access":"fake"}}\n');

    try {
      expect(
        hasLegacyAuthProfileSourcesForStartup({
          agentDirs: [path.join(root, "custom-agent")],
          env,
        }),
      ).toBe(true);
      expect(() =>
        assertAuthProfileMigrationReady(path.join(root, "agents", "main", "agent")),
      ).toThrow("requires legacy credential migration");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes startup-only fast-path snapshots from persisted auth stores after startup", async () => {
    const { prepareSecretsRuntimeFastPathSnapshot } = await import("./runtime-fast-path.js");
    const { activateSecretsRuntimeSnapshotState, getActiveSecretsRuntimeSnapshotState } =
      await import("./runtime-state.js");
    const { refreshActiveProviderAuthRuntimeSnapshot } = await import("./runtime.js");
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
            list: [{ id: "main", agentDir }],
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

      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      const active = getActiveSecretsRuntimeSnapshotState();
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

  it("does not let an active refresh overwrite a snapshot published during preparation", async () => {
    const {
      activateSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshot,
      prepareSecretsRuntimeSnapshot,
      refreshActiveProviderAuthRuntimeSnapshot,
    } = await import("./runtime.js");
    const agentDir = "/tmp/openclaw-agent-refresh-cas";
    let publishNewerSnapshot = false;
    let newerSnapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>> | null = null;
    const loadInitialAuthStore = () => {
      if (publishNewerSnapshot && newerSnapshot) {
        publishNewerSnapshot = false;
        activateSecretsRuntimeSnapshot(newerSnapshot);
      }
      return emptyAuthStore();
    };
    const config = (port: number) =>
      asConfig({
        agents: { list: [{ id: "main", agentDir }] },
        gateway: { port },
      });
    const initialSnapshot = await prepareSecretsRuntimeSnapshot({
      config: config(19_001),
      agentDirs: [agentDir],
      loadAuthStore: loadInitialAuthStore,
    });
    activateSecretsRuntimeSnapshot(initialSnapshot);
    newerSnapshot = await prepareSecretsRuntimeSnapshot({
      config: config(19_002),
      agentDirs: [agentDir],
      loadAuthStore: emptyAuthStore,
    });

    publishNewerSnapshot = true;
    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig.gateway?.port).toBe(19_002);
  });

  it("does not let an active refresh overwrite auth stores mutated during preparation", async () => {
    const { getRuntimeAuthProfileStoreSnapshotCore, setRuntimeAuthProfileStoreSnapshot } =
      await import("../agents/auth-profiles/runtime-snapshots.js");
    const {
      activateSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshot,
      prepareSecretsRuntimeSnapshot,
      refreshActiveProviderAuthRuntimeSnapshot,
    } = await import("./runtime.js");
    const agentDir = "/tmp/openclaw-agent-auth-store-refresh-cas";
    const oldStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "sk-old" },
      },
    };
    const newStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "sk-new" },
      },
    };
    let mutateDuringRefresh = false;
    const loadAuthStore = () => {
      if (mutateDuringRefresh) {
        mutateDuringRefresh = false;
        setRuntimeAuthProfileStoreSnapshot(newStore, agentDir);
        return oldStore;
      }
      return getRuntimeAuthProfileStoreSnapshotCore(agentDir) ?? oldStore;
    };
    const initial = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: { list: [{ id: "main", agentDir }] },
      }),
      agentDirs: [agentDir],
      loadAuthStore,
    });
    activateSecretsRuntimeSnapshot(initial);

    mutateDuringRefresh = true;
    await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);

    expect(
      getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles["openai:default"],
    ).toMatchObject({ key: "sk-new" });
    expect(
      getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles["openai:default"],
    ).toMatchObject({
      key: "sk-new",
    });
  });

  it("re-prepares a preflighted config refresh after its snapshot revision goes stale", async () => {
    const { getRuntimeConfigSnapshotRefreshHandler } =
      await import("../config/runtime-snapshot.js");
    const {
      activateSecretsRuntimeSnapshot,
      getActiveSecretsRuntimeSnapshot,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js");
    const agentDir = "/tmp/openclaw-agent-preflight-cas";
    const authStore = (key: string): AuthProfileStore => ({
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key },
      },
    });
    const config = (port: number) =>
      asConfig({
        agents: { list: [{ id: "main", agentDir }] },
        gateway: { port },
      });
    const initial = await prepareSecretsRuntimeSnapshot({
      config: config(19_011),
      agentDirs: [agentDir],
      loadAuthStore: () => authStore("old-key"),
    });
    activateSecretsRuntimeSnapshot(initial);
    const concurrent = await prepareSecretsRuntimeSnapshot({
      config: config(19_012),
      agentDirs: [agentDir],
      loadAuthStore: () => authStore("new-key"),
    });
    const staleRefreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    if (!staleRefreshHandler?.preflight) {
      throw new Error("expected active runtime refresh preflight handler");
    }
    const desiredConfig = config(19_013);
    const preflightResult = await staleRefreshHandler.preflight({
      sourceConfig: desiredConfig,
    });
    activateSecretsRuntimeSnapshot(concurrent);

    await expect(
      staleRefreshHandler.refresh({ sourceConfig: desiredConfig, preflightResult }),
    ).resolves.toBe(true);

    const activeStore = getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store;
    expect(activeStore?.profiles["openai:default"]).toMatchObject({ key: "new-key" });
    expect(getActiveSecretsRuntimeSnapshot()?.sourceConfig.gateway?.port).toBe(19_013);
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
            list: [{ id: "main", agentDir }],
          },
        }),
        env,
      });

      expect(fastPath).not.toBeNull();
      expect(
        fastPath!.snapshot.authStores.map(({ agentDir: storeAgentDir, store }) => ({
          agentDir: storeAgentDir,
          store,
        })),
      ).toEqual([{ agentDir, store: emptyAuthStore() }]);
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
