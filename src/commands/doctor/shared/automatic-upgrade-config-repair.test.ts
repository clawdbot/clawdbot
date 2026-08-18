import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { planUpgradeConfigRepair } from "./automatic-upgrade-config-repair.js";

function invalidSnapshot(params: {
  config: OpenClawConfig;
  issuePaths: string[];
  includedPaths?: string[];
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: params.includedPaths ?? [],
    exists: true,
    raw: JSON.stringify(params.config),
    parsed: params.config,
    sourceConfig: params.config,
    resolved: params.config,
    valid: false,
    runtimeConfig: params.config,
    config: params.config,
    issues: params.issuePaths.map((path) => ({ path, message: "retired" })),
    warnings: [],
    legacyIssues: [{ path: "", message: "retired" }],
  };
}

describe("automatic upgrade config repair", () => {
  it("plans removal of the stable-authored retired keys without changing other config", () => {
    const snapshot = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true, every: "30m" } },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });

    const plan = planUpgradeConfigRepair(snapshot);

    expect(plan?.config).toEqual({
      meta: { lastTouchedVersion: "2026.7.1-2" },
      agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: {} } },
      gateway: { mode: "local" },
    });
    expect(plan?.snapshot.valid).toBe(true);
    expect(plan?.snapshot.issues).toEqual([]);
    expect(snapshot.sourceConfig).toHaveProperty("meta.lastTouchedAt");
  });

  it.each([
    {
      name: "an unrelated validation failure",
      issuePaths: ["meta", "gateway"],
      includedPaths: [],
    },
    {
      name: "an included config source",
      issuePaths: ["meta"],
      includedPaths: ["/tmp/included.json"],
    },
  ])("refuses $name", ({ issuePaths, includedPaths }) => {
    const snapshot = invalidSnapshot({
      config: {
        meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z" },
      } as OpenClawConfig,
      issuePaths,
      includedPaths,
    });

    expect(planUpgradeConfigRepair(snapshot)).toBeNull();
  });

  it("refuses another invalid key reported at the same schema parent", () => {
    const snapshot = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          unrelatedRetiredKey: true,
        },
      } as OpenClawConfig,
      issuePaths: ["meta"],
    });

    expect(planUpgradeConfigRepair(snapshot)).toBeNull();
  });
});
