// Health inspection tests cover metadata-only accounts and operational hook boundaries.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadFreshHealthModulesForTest,
  type HealthTestPlugin,
} from "./health.snapshot.test-support.js";

const tempDirs = createTempDirTracker();
let plugins: HealthTestPlugin[] = [];
let sessionStorePath: string;
let health: Awaited<ReturnType<typeof loadFreshHealthModulesForTest>>;

describe("collectGatewayHealthSnapshot account inspection", () => {
  beforeAll(async () => {
    health = await loadFreshHealthModulesForTest({
      getConfig: () => ({}),
      getSessionStorePath: () => sessionStorePath,
      getSessions: () => ({}),
      getPlugins: () => plugins,
    });
  });

  beforeEach(() => {
    sessionStorePath = path.join(tempDirs.make("openclaw-health-inspection-"), "sessions.json");
    plugins = [];
    health.setActiveDegradedPlugins([]);
    health.setActivePluginRegistry(health.createTestRegistry([]));
  });

  afterEach(() => {
    health.setActivePluginRegistry(health.createTestRegistry([]));
    tempDirs.cleanup();
  });

  it("keeps summary-only unavailable accounts visible and probes only resolved siblings", async () => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const buildAccountSnapshot = vi.fn(({ account }: { account: unknown }) => {
      if ((account as { token?: string }).token !== "healthy-token") {
        throw new Error("runtime hook received an inspection summary");
      }
      return { accountId: "healthy", configured: true, name: "Resolved healthy account" };
    });
    plugins = [
      {
        ...health.createChannelTestPluginBase({
          id: "health-inspection-fixture",
          label: "Inspection",
        }),
        config: {
          listAccountIds: () => ["default", "healthy"],
          resolveAccount: (_cfg, accountId) => {
            if (accountId !== "healthy") {
              throw new Error("credential unavailable");
            }
            return { accountId, enabled: true, configured: true, token: "healthy-token" };
          },
          inspectAccount: (_cfg, accountId) => ({
            accountId,
            enabled: true,
            configured: true,
            tokenStatus: accountId === "healthy" ? "available" : "configured_unavailable",
          }),
        },
        status: { probeAccount, buildAccountSnapshot },
      },
    ];

    const snapshot = await health.getHealthSnapshot({ probe: true });
    expect(snapshot.channels["health-inspection-fixture"]?.accounts).toMatchObject({
      default: { configured: true, tokenStatus: "configured_unavailable" },
      healthy: { configured: true, name: "Resolved healthy account" },
    });
    expect(probeAccount).toHaveBeenCalledTimes(1);
    expect(probeAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountId: "healthy", token: "healthy-token" }),
      }),
    );
    expect(buildAccountSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { name: "Partial inspection" }])(
    "keeps unknown configuration when account resolution fails and inspection is %s",
    async (inspected) => {
      const runtimeOnly = vi.fn(() => {
        throw new Error("runtime hook received an inspection summary");
      });
      plugins = [
        {
          ...health.createChannelTestPluginBase({ id: "health-partial-fixture", label: "Partial" }),
          config: {
            listAccountIds: () => ["default"],
            inspectAccount: () => inspected,
            resolveAccount: () => {
              throw new Error("account resolution failed");
            },
          },
          status: {
            probeAccount: runtimeOnly,
            buildAccountSnapshot: runtimeOnly,
            buildChannelSummary: runtimeOnly,
          },
        },
      ];

      const snapshot = await health.getHealthSnapshot({ probe: true });
      const account = snapshot.channels["health-partial-fixture"]?.accounts?.default;
      expect(account?.configured).toBeUndefined();
      expect(account?.stateReason).toBe("configuration status unavailable");
      expect(runtimeOnly).not.toHaveBeenCalled();
    },
  );
});
