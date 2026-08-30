import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvOverride } from "../../../config/test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { VERSION } from "../../../version.js";
import {
  isStartupConfigRepairResult,
  planStartupConfigRepair,
  resolveStartupConfigSnapshot,
} from "./automatic-startup-config-repair.js";

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
    issues: params.issuePaths.map((issuePath) => ({ path: issuePath, message: "retired" })),
    warnings: [],
    legacyIssues: [{ path: "", message: "retired" }],
  };
}

describe("automatic startup config repair", () => {
  it("plans a deterministic, fully valid migration of retired session keys", () => {
    const snapshot = invalidSnapshot({
      config: { session: { idleMinutes: 45 } } as OpenClawConfig,
      issuePaths: ["session.idleMinutes"],
    });

    const plan = planStartupConfigRepair(snapshot);

    expect(plan?.config.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(validateConfigObjectWithPlugins(plan?.config).ok).toBe(true);
    expect(planStartupConfigRepair(snapshot)?.config).toEqual(plan?.config);
    expect(snapshot.sourceConfig.session).toEqual({ idleMinutes: 45 });
  });

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

    const plan = planStartupConfigRepair(snapshot);

    expect(plan?.config).toEqual({
      meta: { lastTouchedVersion: "2026.7.1-2" },
      agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: {} } },
      gateway: { mode: "local" },
    });
    expect(plan?.snapshot.valid).toBe(true);
    expect(plan?.snapshot.issues).toEqual([]);
    expect(snapshot.sourceConfig).toHaveProperty("meta.lastTouchedAt");
  });

  it("accepts the canonical writer metadata stamped onto the repaired stable config", () => {
    const before = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true }, workspace: "/tmp/workspace" },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });
    const repaired = {
      meta: {
        lastTouchedVersion: VERSION,
        migrations: { modelPolicyAllowlist: true },
      },
      agents: { defaults: { workspace: "/tmp/workspace" }, entries: { main: {} } },
      gateway: { mode: "local" },
    } as OpenClawConfig;
    const after: ConfigFileSnapshot = {
      ...before,
      raw: JSON.stringify(repaired),
      parsed: repaired,
      sourceConfig: repaired,
      resolved: repaired,
      runtimeConfig: repaired,
      config: repaired,
      valid: true,
      issues: [],
      legacyIssues: [],
    };

    expect(isStartupConfigRepairResult(before, after)).toBe(true);
    expect(isStartupConfigRepairResult(before, { ...after, path: "/tmp/other.json" })).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, gateway: { mode: "remote" } },
      }),
    ).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, session: { reset: { mode: "idle" } } },
      }),
    ).toBe(false);
  });

  it("admits a config whose only migration is plugin-owned", () => {
    // Regression: the pre-bootstrap trust check must reach plugin doctor contracts
    // (here the bundled Active Memory retired-QMD removal), not only core migrations.
    const snapshot = invalidSnapshot({
      config: {
        plugins: { entries: { "active-memory": { config: { qmd: { enabled: true } } } } },
      } as OpenClawConfig,
      issuePaths: ["plugins.entries.active-memory.config.qmd"],
    });

    const resolved = resolveStartupConfigSnapshot(snapshot);

    expect(resolved?.valid).toBe(true);
    expect(resolved?.sourceConfig.plugins?.entries?.["active-memory"]?.config).toEqual({});
  });

  it("previews repairable snapshots without touching the shared state database", async () => {
    // Backup discovery and gateway pre-bootstrap resolve before state-database admission;
    // a broken store (here: a directory at the canonical path) must not break the preview.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-repair-preview-"));
    try {
      await fs.mkdir(path.join(root, "state", "openclaw.sqlite"), { recursive: true });
      await withEnvOverride({ OPENCLAW_STATE_DIR: root }, async () => {
        const snapshot = invalidSnapshot({
          config: { session: { idleMinutes: 45 } } as OpenClawConfig,
          issuePaths: ["session.idleMinutes"],
        });
        const resolved = resolveStartupConfigSnapshot(snapshot);
        expect(resolved?.valid).toBe(true);
        expect(resolved?.sourceConfig.session).toEqual({
          reset: { mode: "idle", idleMinutes: 45 },
        });
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "a non-legacy type error", config: { gateway: { port: "not-a-number" } } },
    {
      name: "a migration with a remaining type error",
      config: { session: { idleMinutes: 45 }, gateway: { port: "not-a-number" } },
    },
    {
      name: "an included config source",
      config: { session: { idleMinutes: 45 } },
      includedPaths: ["/tmp/included.json"],
    },
    {
      name: "an include directive without recorded include paths",
      config: { $include: "included.json", session: { idleMinutes: 45 } },
    },
    {
      name: "an unresolved plugin validation failure",
      config: {
        session: { idleMinutes: 45 },
        plugins: { load: { paths: ["/nonexistent-startup-plugin"] } },
      },
    },
    {
      name: "another invalid key at a retired key's schema parent",
      config: { meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z", unrelatedRetiredKey: true } },
    },
  ])("refuses $name", ({ config, includedPaths }) => {
    const snapshot = invalidSnapshot({
      config: config as OpenClawConfig,
      issuePaths: [],
      includedPaths,
    });

    expect(planStartupConfigRepair(snapshot)).toBeNull();
  });
});
