import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import { usageHandlers } from "./usage.js";

const config = {
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

function createStore(access = "access-one") {
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
  };
}

async function runUsageStatus(runtimeConfig = config) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["usage.status"],
    'usageHandlers["usage.status"] test invariant',
  )({
    respond,
    params: {},
    context: { getRuntimeConfig: () => runtimeConfig },
  } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "usage.status result");
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

  it("loads the cached provider snapshot from the exact runtime config", async () => {
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

    const result = (await runUsageStatus()) as {
      providers: Array<{ accountEmail?: string }>;
    };
    expect(result.providers[0]?.accountEmail).toBe("configured@example.com");
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
    await runUsageStatus(nextConfig);
    await runUsageStatus(nextConfig);

    setActivePluginRegistry(createEmptyPluginRegistry());
    await runUsageStatus(nextConfig);
    await runUsageStatus(nextConfig);

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

  it("keeps a provider's last-good snapshot when its refresh times out", async () => {
    const first = (await runUsageStatus()) as UsageSummary;
    now = 61_000;
    mocks.loadProviderUsageSummary.mockResolvedValueOnce({
      updatedAt: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [],
          error: "Timeout",
        },
      ],
    });

    const stale = await runUsageStatus();
    expect(JSON.stringify(stale)).toBe(JSON.stringify(first));
    await mocks.loadProviderUsageSummary.mock.results[1]?.value;
    await vi.waitFor(async () => {
      const retained = (await runUsageStatus()) as UsageSummary;
      expect(retained.providers).toEqual(first.providers);
      expect(retained.updatedAt).toBe(61_000);
      expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
    });
  });

  it("shares the raw snapshot with models.authStatus and invalidates on credential rotation", async () => {
    await runUsageStatus();
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    const usage = readProviderUsageStaleWhileRevalidate({
      agentId,
      agentDir,
      configRef: config,
      credentialKey: getProviderUsageRuntimeSnapshot({ config }).credentialKey,
      providerIds: ["openai"],
      now,
    });
    expect(usage.get("openai")?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    store = createStore("access-two");
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    const rotated = (await runUsageStatus()) as {
      providers: Array<{ windows: Array<{ usedPercent: number }> }>;
    };
    expect(rotated.providers[0]?.windows[0]?.usedPercent).toBe(20);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });
});
