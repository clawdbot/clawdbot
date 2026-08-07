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

const refreshingCapableClient = {
  connect: { caps: ["usage-refreshing"] },
};

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

async function runUsageStatus(client?: unknown) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["usage.status"],
    'usageHandlers["usage.status"] test invariant',
  )({
    respond,
    params: {},
    context: { getRuntimeConfig: () => config },
    client: client === undefined ? refreshingCapableClient : client,
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

  it("marks the cold snapshot as refreshing instead of waiting for provider HTTP", async () => {
    let resolveProviderUsage:
      | ((value: { updatedAt: number; providers: never[] }) => void)
      | undefined;
    mocks.loadProviderUsageSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProviderUsage = resolve;
        }),
    );

    const resultPromise = runUsageStatus();
    const providerWait = Symbol("provider-wait");
    const result = await Promise.race([
      resultPromise,
      new Promise<typeof providerWait>((resolve) => {
        setTimeout(() => resolve(providerWait), 25);
      }),
    ]);

    resolveProviderUsage?.({ updatedAt: now, providers: [] });
    expect(result).toEqual({ updatedAt: now, providers: [], refreshing: true });
  });

  it("keeps the blocking cold read for clients without the usage-refreshing capability", async () => {
    let resolveProviderUsage:
      | ((value: { updatedAt: number; providers: never[] }) => void)
      | undefined;
    mocks.loadProviderUsageSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProviderUsage = resolve;
        }),
    );

    // A legacy client caches whatever it receives, so a cold read must not answer
    // with an empty placeholder: it awaits the provider refresh like before.
    const resultPromise = runUsageStatus({ connect: { caps: [] } });
    const providerWait = Symbol("provider-wait");
    const raced = await Promise.race([
      resultPromise,
      new Promise<typeof providerWait>((resolve) => {
        setTimeout(() => resolve(providerWait), 25);
      }),
    ]);
    expect(raced).toBe(providerWait);

    resolveProviderUsage?.({ updatedAt: now, providers: [] });
    const result = await resultPromise;
    expect(result).toEqual({ updatedAt: now, providers: [] });
    expect((result as { refreshing?: boolean }).refreshing).toBeUndefined();
  });

  it("keeps the blocking cold read when no client is attached", async () => {
    const result = await runUsageStatus(null);
    expect(result).toMatchObject({ providers: expect.any(Array) });
    expect((result as { refreshing?: boolean }).refreshing).toBeUndefined();
  });

  it("surfaces a failed background refresh to the next capable cold read", async () => {
    mocks.loadProviderUsageSummary.mockRejectedValueOnce(new Error("provider stack down"));

    // Cold read answers the marker while the doomed refresh runs.
    const first = await runUsageStatus();
    expect(first).toMatchObject({ providers: [], refreshing: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // The bounded retry must observe the recorded failure, not another
    // successful placeholder.
    const respond = vi.fn();
    await expect(
      expectDefined(
        usageHandlers["usage.status"],
        'usageHandlers["usage.status"] test invariant',
      )({
        respond,
        params: {},
        context: { getRuntimeConfig: () => config },
        client: refreshingCapableClient,
      } as unknown as Parameters<(typeof usageHandlers)["usage.status"]>[0]),
    ).rejects.toThrow("provider stack down");
    expect(respond).not.toHaveBeenCalled();

    // The failure is consumed and the retry already scheduled a fresh refresh,
    // so a recovered provider self-heals on the following read.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const third = await runUsageStatus();
    expect((third as { providers: unknown[] }).providers).toHaveLength(1);
  });

  it("keeps the blocking cold read for board widget data reads", async () => {
    // The board relay carries the operator connection's client, but a widget
    // one-shot read has no bounded-refetch machinery and must never see the
    // cold placeholder.
    const { readBoardDataBinding } = await import("../board-host-tools.js");
    const result = (await readBoardDataBinding("usage.status", {}, {
      respond: () => {},
      params: {},
      req: { method: "usage.status", params: {} },
      context: { getRuntimeConfig: () => config },
      client: refreshingCapableClient,
    } as unknown as Parameters<typeof readBoardDataBinding>[2])) as {
      providers: unknown[];
      refreshing?: boolean;
    };
    expect(result.providers).toHaveLength(1);
    expect(result.refreshing).toBeUndefined();
  });

  it("reuses byte-identical results within 60s and refreshes stale data in the background", async () => {
    expect(await runUsageStatus()).toEqual({ updatedAt: now, providers: [], refreshing: true });
    const first = await vi.waitFor(async () => {
      const result = (await runUsageStatus()) as {
        providers: Array<{ windows: Array<{ usedPercent: number }> }>;
        refreshing?: boolean;
      };
      expect(result.providers[0]?.windows[0]?.usedPercent).toBe(10);
      return result;
    });
    // Loaded usage must not carry the refreshing marker, or clients keep retrying.
    expect(first.refreshing).toBeUndefined();

    expect(JSON.stringify(await runUsageStatus())).toBe(JSON.stringify(first));
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
    expect(await runUsageStatus()).toEqual({ updatedAt: now, providers: [], refreshing: true });
    const agentId = resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    const readUsage = () =>
      readProviderUsageStaleWhileRevalidate({
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
    await vi.waitFor(() => {
      expect(readUsage().get("openai")?.windows[0]?.usedPercent).toBe(10);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(1);

    store.profiles["openai:default"].access = "access-two";
    expect(await runUsageStatus()).toEqual({ updatedAt: now, providers: [], refreshing: true });
    await vi.waitFor(async () => {
      const rotated = (await runUsageStatus()) as {
        providers: Array<{ windows: Array<{ usedPercent: number }> }>;
      };
      expect(rotated.providers[0]?.windows[0]?.usedPercent).toBe(20);
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledTimes(2);
  });
});
