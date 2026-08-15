import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProviderUsagePluginDescriptors: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

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
  fingerprintProviderUsageCredentials,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
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

async function runUsageStatus() {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["usage.status"],
    'usageHandlers["usage.status"] test invariant',
  )({
    respond,
    params: {},
    context: { getRuntimeConfig: () => config },
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reuses byte-identical results within 60s and refreshes stale data in the background", async () => {
    const first = await runUsageStatus();
    const repeated = await runUsageStatus();

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

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
  });

  it("shares the raw snapshot with models.authStatus and invalidates on credential rotation", async () => {
    await runUsageStatus();
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    const usage = readProviderUsageStaleWhileRevalidate({
      agentId,
      agentDir,
      configRef: config,
      credentialKey: fingerprintProviderUsageCredentials({
        cfg: config,
        directApiKeys: new Map(),
        store: store as AuthProfileStore,
      }),
      providerIds: ["openai"],
      now,
    });
    expect(usage.get("openai")?.windows[0]?.usedPercent).toBe(10);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    store.profiles["openai:default"].access = "access-two";
    const rotated = (await runUsageStatus()) as {
      providers: Array<{ windows: Array<{ usedPercent: number }> }>;
    };
    expect(rotated.providers[0]?.windows[0]?.usedPercent).toBe(20);
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });
});
