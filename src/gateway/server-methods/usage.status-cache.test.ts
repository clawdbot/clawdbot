import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProviderUsagePluginDescriptors: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    externalCliDiscoveryForConfigStatus: vi.fn(() => undefined),
  };
});

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
  };
});

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

import {
  clearModelAuthStatusUsageCache,
  readProfileUsageStaleWhileRevalidate,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { usageHandlers } from "./usage.js";

const config = {
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

const refreshingCapableClient = { connect: { caps: ["usage-refreshing"] } };

function createStore(access = "access-one"): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "oauth" as const,
        provider: "openai",
        access,
        refresh: "refresh-one",
        expires: 1_000_000,
      },
    },
    // Successful runs stamp this selection metadata on the real store.
    usageStats: undefined,
  };
}

async function runUsageStatus(params: { runtimeConfig?: OpenClawConfig; client?: unknown } = {}) {
  const runtimeConfig = params.runtimeConfig ?? config;
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["usage.status"],
    'usageHandlers["usage.status"] test invariant',
  )({
    respond,
    params: {},
    context: { getRuntimeConfig: () => runtimeConfig },
    client: params.client ?? null,
  } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "usage.status result");
}

async function runCapableUsageStatus(runtimeConfig = config) {
  return await runUsageStatus({ runtimeConfig, client: refreshingCapableClient });
}

describe("usage.status provider usage cache", () => {
  let now = 1_000;
  let store = createStore();

  beforeEach(() => {
    now = 1_000;
    store = createStore();
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.clearAllMocks();
    clearModelAuthStatusUsageCache();
    mocks.ensureAuthProfileStore.mockImplementation(() => store);
    mocks.listProviderUsagePluginDescriptors.mockReturnValue([
      { provider: "openai", displayName: "OpenAI" },
    ]);
    mocks.loadProviderUsageSummary.mockImplementation(async () => ({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "5h",
              usedPercent: mocks.loadProviderUsageSummary.mock.calls.length * 10,
            },
          ],
          plan: "Plus",
        },
      ],
    }));
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockExactConfigProviderUsage() {
    mocks.loadProviderUsageSummary.mockImplementation(async (options) => ({
      updatedAt: now,
      providers:
        options.config === config
          ? [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [{ label: "5h", usedPercent: 25 }],
                accountEmail: "configured@example.com",
              },
            ]
          : [],
    }));
  }

  it("loads the cached provider snapshot from the exact runtime config", async () => {
    mockExactConfigProviderUsage();

    // Clientless internal reads stay blocking, so the first response already
    // carries the snapshot the exact-config loader produced.
    const result = (await runUsageStatus()) as {
      providers: Array<{ accountEmail?: string }>;
    };
    expect(result.providers[0]?.accountEmail).toBe("configured@example.com");
  });

  it("hands the exact runtime config to the background refresh", async () => {
    mockExactConfigProviderUsage();

    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(async () => {
      expect(
        (await runCapableUsageStatus()) as { providers: Array<{ accountEmail?: string }> },
      ).toMatchObject({ providers: [{ accountEmail: "configured@example.com" }] });
    });
  });

  it("returns a cold marker only to capable clients and retains invalidated refresh work", async () => {
    const scope = new AsyncWorkScope();
    const heldRefresh = createDeferredCore<UsageSummary>();
    const original: UsageSummary = { updatedAt: now, providers: [] };
    let legacy: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    mocks.loadProviderUsageSummary.mockImplementationOnce(() => heldRefresh.promise);
    try {
      await expect(scope.track(() => runCapableUsageStatus())).resolves.toEqual({
        updatedAt: now,
        providers: [],
        refreshing: true,
      });

      // Keep the blocking reader outside this scope: only the cold marker's
      // detached refresh may keep its owner alive after that request returned.
      legacy = runUsageStatus();
      const pending = Symbol("pending");
      await expect(
        Promise.race([
          legacy,
          new Promise((resolve) => {
            setTimeout(() => resolve(pending), 25);
          }),
        ]),
      ).resolves.toBe(pending);
      clearModelAuthStatusUsageCache();
      const current = (await runUsageStatus()) as UsageSummary;
      expect(current.providers[0]?.windows[0]?.usedPercent).toBe(20);

      let drained = false;
      draining = scope.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      heldRefresh.resolve(original);
      await expect(legacy).resolves.toEqual(original);
      await draining;
      expect(drained).toBe(true);
      await expect(runUsageStatus()).resolves.toEqual(current);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    } finally {
      heldRefresh.resolve(original);
      await Promise.allSettled([legacy, mocks.loadProviderUsageSummary.mock.results[0]?.value]);
      await (draining ?? scope.drain());
    }
  });

  it("keeps serving usage while run bookkeeping refreshes the runtime snapshot", async () => {
    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(async () => {
      expect(await runCapableUsageStatus()).toMatchObject({
        providers: [{ provider: "openai" }],
      });
    });

    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    store = { ...store, usageStats: { "openai:default": { lastUsed: now } } };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    now += 1;

    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [{ provider: "openai" }],
    });
    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [{ provider: "openai" }],
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);
  });

  it("refreshes when usage bookkeeping changes the selected profile", async () => {
    store = {
      version: 1,
      profiles: {
        "openai:first": expectDefined(
          createStore("access-first").profiles["openai:default"],
          "first auth profile",
        ),
        "openai:second": expectDefined(
          createStore("access-second").profiles["openai:default"],
          "second auth profile",
        ),
      },
      usageStats: {
        "openai:first": { lastUsed: 100 },
        "openai:second": { lastUsed: 200 },
      },
    };
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);

    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1));

    store = {
      ...store,
      usageStats: {
        "openai:first": { lastUsed: 300 },
        "openai:second": { lastUsed: 200 },
      },
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    now += 1;

    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      expect(await runCapableUsageStatus()).toMatchObject({
        providers: [{ provider: "openai" }],
      });
    });
    await expect(runCapableUsageStatus()).resolves.toMatchObject({
      providers: [{ provider: "openai" }],
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("keeps clientless internal reads blocking", async () => {
    const result = (await runUsageStatus()) as { refreshing?: boolean; providers: unknown[] };
    expect(result.providers).toHaveLength(1);
    expect(result.refreshing).toBeUndefined();
  });

  it("keeps a failed refresh incomplete for capable clients and recovers", async () => {
    mocks.loadProviderUsageSummary.mockRejectedValueOnce(new Error("provider stack down"));
    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // A failed refresh publishes nothing, so the payload stays marked incomplete
    // and the client's bounded retry owns reporting it. The next attempt recovers.
    await expect(runCapableUsageStatus()).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(async () => {
      expect((await runCapableUsageStatus()) as { providers: unknown[] }).toMatchObject({
        providers: [expect.any(Object)],
      });
    });
  });

  it("reuses byte-identical results within 60s and refreshes stale data in the background", async () => {
    const first = (await runUsageStatus()) as UsageSummary;
    const repeated = await runUsageStatus();

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(mocks.listProviderUsagePluginDescriptors).toHaveBeenCalledTimes(1);

    now = 61_000;
    const stale = await runUsageStatus();
    expect(JSON.stringify(stale)).toBe(JSON.stringify(first));
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);

    await vi.waitFor(async () => {
      const refreshed = (await runUsageStatus()) as {
        providers: Array<{ windows: Array<{ usedPercent: number }> }>;
      };
      expect(refreshed.providers[0]?.windows[0]?.usedPercent).toBe(20);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    expect(mocks.listProviderUsagePluginDescriptors).toHaveBeenCalledTimes(1);
  });

  it("rebuilds prepared usage facts once for each config and plugin generation", async () => {
    await runUsageStatus();
    await runUsageStatus();

    const nextConfig = { ...config };
    await runUsageStatus({ runtimeConfig: nextConfig });
    await runUsageStatus({ runtimeConfig: nextConfig });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await runUsageStatus({ runtimeConfig: nextConfig });
    await runUsageStatus({ runtimeConfig: nextConfig });

    expect(mocks.listProviderUsagePluginDescriptors).toHaveBeenCalledTimes(3);
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(3);
  });

  it("rebuilds prepared usage facts once after an auth-store write", async () => {
    const writtenAgentDir = tempDirs.make("openclaw-usage-auth-");
    try {
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: writtenAgentDir, store }]);

      await runUsageStatus();
      await runUsageStatus();

      store = createStore("access-two");
      saveAuthProfileStore(store, writtenAgentDir);
      await runUsageStatus();
      await runUsageStatus();

      expect(mocks.listProviderUsagePluginDescriptors).toHaveBeenCalledTimes(2);
      expect(mocks.ensureAuthProfileStore).toHaveBeenCalledTimes(2);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it.each(["Timeout", "Refresh queue timeout"])(
    "keeps a provider's last-good snapshot when its refresh fails with %s",
    async (error) => {
      const first = (await runUsageStatus()) as UsageSummary;
      now = 61_000;
      mocks.loadProviderUsageSummary.mockResolvedValueOnce({
        updatedAt: now,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [],
            error,
          },
        ],
      });

      const stale = await runUsageStatus();
      expect(JSON.stringify(stale)).toBe(JSON.stringify(first));
      await mocks.loadProviderUsageSummary.mock.results[1]?.value;
      now = 62_000;
      await vi.waitFor(async () => {
        const retained = (await runUsageStatus()) as UsageSummary;
        expect(retained.providers).toEqual(first.providers);
        expect(retained.updatedAt).toBe(first.updatedAt);
        expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("invalidates cached usage when the runtime config changes", async () => {
    const configFor = (baseUrl: string) =>
      ({ ...config, models: { providers: { openai: { baseUrl, models: [] } } } }) as OpenClawConfig;
    const first = configFor("https://one.example/v1");
    await expect(runCapableUsageStatus(first)).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(async () => {
      expect(
        ((await runCapableUsageStatus(first)) as { providers: unknown[] }).providers,
      ).toHaveLength(1);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    const second = configFor("https://two.example/v1");
    await expect(runCapableUsageStatus(second)).resolves.toMatchObject({ refreshing: true });
    await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2));
  });

  it.each([false, true])(
    "isolates provider-only misses from general usage (general first: %s)",
    async (generalFirst) => {
      mocks.loadProviderUsageSummary.mockImplementation(async (options) => ({
        updatedAt: now,
        providers: options.providerOnly
          ? []
          : [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [{ label: "week", usedPercent: 10 }],
              },
            ],
      }));
      if (generalFirst) {
        await runUsageStatus();
      }
      const params = {
        agentId: resolveDefaultAgentId(config),
        agentDir: resolveAgentDir(config, resolveDefaultAgentId(config)),
        configRef: config,
        credentialKey: getProviderUsageRuntimeSnapshot({ config }).credentialKey,
        providerIds: ["openai"],
        now,
      };
      expect(readProviderUsageStaleWhileRevalidate(params).usageByProvider.size).toBe(0);
      await Promise.all(mocks.loadProviderUsageSummary.mock.results.map((result) => result.value));
      expect(readProviderUsageStaleWhileRevalidate(params).usageByProvider.size).toBe(0);
      expect(await runUsageStatus()).toMatchObject({
        providers: [{ windows: [{ usedPercent: 10 }] }],
      });
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["token", "reference"] as const)("isolates quota (%s)", async (change) => {
    store = {
      version: 1,
      profiles: {
        "openai:first":
          change === "token"
            ? { type: "token", provider: "openai", token: "first-token" }
            : {
                type: "token",
                provider: "openai",
                tokenRef: { source: "env", provider: "default", id: "FIRST_TOKEN" },
              },
        "openai:second": { type: "token", provider: "openai", token: "second-token" },
      },
    };
    mocks.loadProviderUsageSummary.mockImplementation(async (options) => ({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "week",
              usedPercent: options.authProfile?.profileId === "openai:first" ? 10 : 20,
            },
          ],
        },
      ],
    }));
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    const readProfiles = () => {
      const snapshot = getProviderUsageRuntimeSnapshot({ config, agentId, agentDir, store });
      return readProfileUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        workspaceDir: "/tmp/workspace",
        authStore: store,
        configRef: config,
        profileCredentialKeys: snapshot.profileCredentialKeys,
        targets: Object.keys(store.profiles).map((profileId) => ({
          profileId,
          providerId: "openai",
        })),
        now,
      });
    };

    expect(readProfiles()).toMatchObject({
      pendingProfileIds: new Set(["openai:first", "openai:second"]),
      refreshPending: true,
    });
    await vi.waitFor(() => expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2));
    await Promise.all(mocks.loadProviderUsageSummary.mock.results.map((result) => result.value));

    const warmed = readProfiles();
    expect(warmed.refreshPending).toBe(false);
    expect(warmed.pendingProfileIds).toEqual(new Set());
    expect(warmed.usageByProfile.get("openai:first")?.windows[0]?.usedPercent).toBe(10);
    expect(warmed.usageByProfile.get("openai:second")?.windows[0]?.usedPercent).toBe(20);
    expect(
      mocks.loadProviderUsageSummary.mock.calls.map(([options]) => options.authProfile),
    ).toEqual([
      { provider: "openai", profileId: "openai:first" },
      { provider: "openai", profileId: "openai:second" },
    ]);

    store = {
      ...store,
      order: { openai: ["openai:second", "openai:first"] },
      lastGood: { openai: "openai:second" },
      usageStats: { "openai:first": { lastUsed: now } },
    };
    expect(readProfiles().usageByProfile).toEqual(warmed.usageByProfile);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);

    store = {
      ...store,
      profiles: {
        ...store.profiles,
        "openai:first":
          change === "token"
            ? { type: "token", provider: "openai", token: "replacement-token" }
            : {
                type: "token",
                provider: "openai",
                tokenRef: { source: "env", provider: "default", id: "REPLACEMENT_TOKEN" },
              },
      },
    };
    const rotated = readProfiles();
    expect(rotated.pendingProfileIds).toEqual(new Set(["openai:first"]));
    expect(rotated.usageByProfile.has("openai:first")).toBe(false);
    expect(rotated.usageByProfile.get("openai:second")).toEqual(
      warmed.usageByProfile.get("openai:second"),
    );
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(3);
    const isCurrent = mocks.loadProviderUsageSummary.mock.calls.at(-1)?.[0].isAuthProfileCurrent;
    expect(isCurrent?.()).toBe(true);
    store = {
      ...store,
      profiles: {
        "openai:second": expectDefined(store.profiles["openai:second"], "retained profile"),
      },
    };
    expect(readProfiles().usageByProfile.get("openai:second")).toEqual(
      warmed.usageByProfile.get("openai:second"),
    );
    expect(isCurrent?.()).toBe(false);
    await Promise.all(mocks.loadProviderUsageSummary.mock.results.map((result) => result.value));
    expect(readProfiles().usageByProfile.has("openai:first")).toBe(false);
  });
});
