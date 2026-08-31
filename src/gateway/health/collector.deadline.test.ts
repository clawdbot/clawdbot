import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type DeadlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
const listSessionEntriesReadOnly = vi.fn(() => []);
let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;

function createDeadlinePlugin(params: {
  accountIds: string[];
  probe: (account: DeadlineAccount) => Promise<Record<string, unknown>>;
}): ChannelPlugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null): DeadlineAccount => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return {
    ...createChannelTestPluginBase({ id: "deadline-test", label: "Deadline Test" }),
    config: {
      listAccountIds: () => params.accountIds,
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => (account as DeadlineAccount).enabled,
      isConfigured: (account) => (account as DeadlineAccount).configured,
    },
    status: {
      probeAccount: async ({ account }) => await params.probe(account as DeadlineAccount),
      buildChannelSummary: ({ snapshot }) => ({ ...snapshot }),
    },
  };
}

async function collectDeadlineSnapshot(params: {
  timeoutMs: number;
  audience?: "public" | "admin";
}) {
  return await collectGatewayHealthSnapshot({
    audience: params.audience ?? "admin",
    probe: true,
    timeoutMs: params.timeoutMs,
  });
}

describe("gateway health collection deadline", () => {
  beforeAll(async () => {
    vi.doMock("../../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
    }));
    // Store paths reach real SQLite target resolution, which inspects the agent
    // database beside them; a shared /tmp path would read machine-wide state.
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../../config/sessions/session-accessor.js", () => ({
      listSessionEntriesReadOnly,
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
    }));
    const [health, channelTestUtils] = await Promise.all([
      import("./collector.js"),
      import("../../test-utils/channel-plugins.js"),
    ]);
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    createChannelTestPluginBase = channelTestUtils.createChannelTestPluginBase;
  });

  beforeEach(async () => {
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-deadline-sessions-"),
      "sessions.json",
    );
    listSessionEntriesReadOnly.mockReset();
    testConfig = {};
    healthPluginsForTest = [];
    await collectGatewayHealthSnapshot({ audience: "admin", probe: false, timeoutMs: 50 });
  });

  afterEach(() => {
    vi.useRealTimers();
    tempDirs.cleanup();
  });

  it("does not start probes when session preparation exhausts the aggregate deadline", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => ({ ok: true }));
    healthPluginsForTest = [createDeadlinePlugin({ accountIds: ["default"], probe })];
    listSessionEntriesReadOnly.mockImplementationOnce(() => {
      vi.advanceTimersByTime(50);
      return [];
    });

    const snap = await collectDeadlineSnapshot({ timeoutMs: 50 });
    const channel = snap.channels["deadline-test"];

    expect(snap.sessions.path).toBe(
      path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite"),
    );
    expect(channel?.probe).toMatchObject({ ok: false, timedOut: true });
    expect(channel?.accounts?.default?.probe).toMatchObject({ ok: false, timedOut: true });
    expect(probe).not.toHaveBeenCalled();
  }, 1_000);

  it("preserves healthy accounts when one probe never settles", async () => {
    vi.useFakeTimers();
    const accountIds = ["default", "fast-1", "fast-2", "fast-3", "fast-4", "fast-5"];
    const started: string[] = [];
    let releaseSlowProbe: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (account.accountId === "default") {
            return await new Promise<Record<string, unknown>>((resolve) => {
              releaseSlowProbe = () => {
                active -= 1;
                resolve({ ok: true });
              };
            });
          }
          await Promise.resolve();
          active -= 1;
          return { ok: true, accountId: account.accountId };
        },
      }),
    ];

    const snapshotPromise = collectDeadlineSnapshot({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    const snap = await snapshotPromise;
    const channel = snap.channels["deadline-test"];

    expect(started).toEqual(accountIds);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(channel?.probe).toMatchObject({ ok: false, timedOut: true });
    for (const accountId of accountIds.slice(1)) {
      expect(channel?.accounts?.[accountId]?.probe).toMatchObject({ ok: true });
    }
    releaseSlowProbe?.();
    await vi.advanceTimersByTimeAsync(0);
  }, 1_000);

  it("does not start queued probes after the aggregate deadline", async () => {
    vi.useFakeTimers();
    const accountIds = [
      "default",
      "blocked-1",
      "blocked-2",
      "blocked-3",
      "blocked-4",
      "queued-1",
      "queued-2",
    ];
    const started: string[] = [];
    const releaseProbes: Array<() => void> = [];
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseProbes.push(() => resolve({ ok: true }));
          });
        },
      }),
    ];

    const snapshotPromise = collectDeadlineSnapshot({ timeoutMs: 50, audience: "public" });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(accountIds.slice(0, 5));
    await vi.advanceTimersByTimeAsync(50);
    const snap = await snapshotPromise;
    const channel = snap.channels["deadline-test"];

    expect(started).toEqual(accountIds.slice(0, 5));
    for (const accountId of accountIds) {
      expect(channel?.accounts?.[accountId]?.probe).toMatchObject({
        ok: false,
        timedOut: true,
      });
    }
    for (const release of releaseProbes) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
  }, 1_000);

  it("retains timed-out permits across repeated health collections", async () => {
    vi.useFakeTimers();
    const accountIds = ["default", "blocked-1", "blocked-2", "blocked-3", "blocked-4"];
    const started: string[] = [];
    const releaseProbes: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    healthPluginsForTest = [
      createDeadlinePlugin({
        accountIds,
        probe: async (account) => {
          started.push(account.accountId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseProbes.push(() => {
              active -= 1;
              resolve({ ok: true });
            });
          });
        },
      }),
    ];

    const firstSnapshot = collectDeadlineSnapshot({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(accountIds);
    await vi.advanceTimersByTimeAsync(50);
    await firstSnapshot;

    const secondSnapshot = collectDeadlineSnapshot({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(accountIds);
    await vi.advanceTimersByTimeAsync(50);
    const second = await secondSnapshot;

    expect(started).toEqual(accountIds);
    expect(active).toBe(5);
    expect(maxActive).toBe(5);
    for (const accountId of accountIds) {
      expect(second.channels["deadline-test"]?.accounts?.[accountId]?.probe).toMatchObject({
        ok: false,
        timedOut: true,
      });
    }
    for (const release of releaseProbes) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(0);
  }, 1_000);
});
