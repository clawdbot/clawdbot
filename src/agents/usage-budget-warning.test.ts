import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  refreshCostUsageCacheForAgent,
  resolveUsageCostCacheDatabasePath,
} from "../infra/session-cost-usage-aggregation.js";
import { testing as sessionCostUsageTestApi } from "../infra/session-cost-usage.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { prepareAgentUsageBudgetWarningBestEffort } from "./usage-budget-warning.js";

const NOW_MS = Date.UTC(2026, 6, 31, 12);

function config(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        usageBudget: { daily: { usd: 10 }, action: "warn" },
      },
    },
    ...overrides,
  };
}

function params(cfg = config(), sessionFile?: string) {
  return {
    cfg,
    agentId: "main",
    sessionFile,
    chatType: "direct",
    senderIsOwner: true,
    nowMs: NOW_MS,
  };
}

describe("usage budget warning", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  async function seedUsage(usage: { totalCost: number; unpricedCalls?: number }, nowMs = NOW_MS) {
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "usage.jsonl");
    const entries: unknown[] = [
      { type: "session", version: 1, id: "usage-budget-warning" },
      {
        type: "message",
        timestamp: new Date(nowMs).toISOString(),
        message: {
          role: "assistant",
          usage: { input: 1, output: 1, totalTokens: 2, cost: { total: usage.totalCost } },
        },
      },
    ];
    for (let index = 0; index < (usage.unpricedCalls ?? 0); index += 1) {
      entries.push({
        type: "message",
        timestamp: new Date(nowMs - index - 1).toISOString(),
        message: {
          role: "assistant",
          provider: "custom",
          model: `unpriced-${index}`,
          usage: {
            input: 881,
            output: 6,
            cacheRead: 22_400,
            cacheWrite: 0,
            totalTokens: 23_287,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    }
    fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await refreshCostUsageCacheForAgent({
      agentId: "main",
      config: config(),
      sessionFiles: [sessionFile],
    });
    return sessionFile;
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-budget-warning-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    sessionCostUsageTestApi.clearUsageCostRefreshesForTest();
    closeOpenClawAgentDatabasesForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("warns once at the highest crossed daily multiple without blocking calls", async () => {
    const sessionFile = await seedUsage({ totalCost: 23.5 });
    expect(prepareAgentUsageBudgetWarningBestEffort(params(config(), sessionFile))).toBe(
      "Usage budget warning: Spend is $23.50 UTC today, crossing $20.00. Warn-only mode; model calls continue.",
    );
    expect(prepareAgentUsageBudgetWarningBestEffort(params(config(), sessionFile))).toBeUndefined();
  });

  it("reuses one bounded watermark row across UTC day rollover", async () => {
    await seedUsage({ totalCost: 12 });
    expect(prepareAgentUsageBudgetWarningBestEffort(params())).toContain("crossing $10.00");

    const tomorrowMs = NOW_MS + 24 * 60 * 60 * 1000;
    await seedUsage({ totalCost: 15 }, tomorrowMs);
    expect(prepareAgentUsageBudgetWarningBestEffort({ ...params(), nowMs: tomorrowMs })).toContain(
      "crossing $10.00",
    );

    closeOpenClawAgentDatabasesForTest();
    const database = new DatabaseSync(resolveUsageCostCacheDatabasePath("main"), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare("SELECT key FROM cache_entries WHERE scope = ?")
          .all("usage-budget-warning-v1"),
      ).toEqual([{ key: "state" }]);
    } finally {
      database.close();
    }
  });

  it("fails closed for group and non-owner delivery routes", () => {
    expect(
      prepareAgentUsageBudgetWarningBestEffort({ ...params(), chatType: "group" }),
    ).toBeUndefined();
    expect(
      prepareAgentUsageBudgetWarningBestEffort({ ...params(), senderIsOwner: false }),
    ).toBeUndefined();
  });

  it("allows a per-agent override to disable an inherited warning budget", () => {
    const cfg = config({
      agents: {
        defaults: { usageBudget: { daily: { usd: 10 }, action: "warn" } },
        list: [{ id: "main", usageBudget: { enabled: false } }],
      },
    });
    expect(prepareAgentUsageBudgetWarningBestEffort(params(cfg))).toBeUndefined();
  });

  it("labels cached totals as a lower bound when pricing is incomplete", async () => {
    const sessionFile = await seedUsage({ totalCost: 12, unpricedCalls: 2 });
    const warning = prepareAgentUsageBudgetWarningBestEffort(params(config(), sessionFile));
    expect(warning).toContain("Known spend is at least $12.00");
    expect(warning).toContain("2 unpriced model calls are not included");
  });

  it("formats valid sub-cent thresholds without rounding them to zero", async () => {
    const sessionFile = await seedUsage({ totalCost: 0.002 });
    const cfg = config({
      agents: { defaults: { usageBudget: { daily: { usd: 0.001 }, action: "warn" } } },
    });
    expect(prepareAgentUsageBudgetWarningBestEffort(params(cfg, sessionFile))).toContain(
      "Spend is $0.002 UTC today, crossing $0.002",
    );
  });
});
