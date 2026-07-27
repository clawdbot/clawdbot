import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import {
  preparePrivateOwnerModelSpendAlertBestEffort,
  recordConfiguredModelSpendCall,
} from "./model-spend-alerts.js";
import { resolveModelSpendCostMicroUsd } from "./model-spend-cost.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  } as Model;
}

function config(
  options: {
    everyUsd?: number;
    providers?: string[];
    timeZone?: string;
  } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: { userTimezone: options.timeZone ?? "UTC" },
      entries: {
        main: {
          modelSpend: {
            providers: options.providers ?? ["deepseek"],
            dailyAlertEveryUsd: options.everyUsd ?? 1.4,
          },
        },
      },
    },
  };
}

function billedUsage(total: number) {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total,
      totalOrigin: "provider-billed" as const,
    },
  };
}

function record(params: { total: number; cfg?: OpenClawConfig; nowMs?: number }) {
  return recordConfiguredModelSpendCall({
    cfg: params.cfg ?? config(),
    agentId: "main",
    nowMs: params.nowMs,
    call: {
      model: model(),
      usage: billedUsage(params.total),
    },
  });
}

function preparePendingModelSpendAlert(params: { cfg: OpenClawConfig; agentId: string }) {
  const cfg: OpenClawConfig = {
    ...params.cfg,
    commands: {
      ...params.cfg.commands,
      ownerAllowFrom: ["telegram:model-spend-test-owner"],
    },
  };
  return preparePrivateOwnerModelSpendAlertBestEffort({
    cfg,
    agentId: params.agentId,
    channel: "telegram",
    to: "model-spend-test-owner",
    chatType: "direct",
  });
}

describe("model spend alerts", () => {
  it("prefers provider-billed totals and rounds calculated pricing upward to micro-USD", () => {
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: billedUsage(1.2345671),
      }),
    ).toEqual({ costMicroUsd: 1_234_568, trackingComplete: true });
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toEqual({ costMicroUsd: 3, trackingComplete: true });
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: { input: 1 },
      }),
    ).toEqual({ costMicroUsd: 1, trackingComplete: false });
  });

  it("combines crossed thresholds and advances the alert watermark before delivery", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-threshold-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      expect(record({ total: 3 })).toBe("recorded");
      const pending = preparePendingModelSpendAlert({
        cfg: config(),
        agentId: "main",
      });

      expect(pending?.text).toContain("deepseek reached $3.00");
      expect(pending?.text).toContain("crossed $1.40 through $2.80");
      expect(pending?.text).toContain("daily reset: UTC");
      expect(preparePendingModelSpendAlert({ cfg: config(), agentId: "main" })).toBeUndefined();
      const row = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "SELECT last_alerted_threshold_microusd FROM model_spend_daily WHERE provider = ?",
        )
        .get("deepseek") as { last_alerted_threshold_microusd: number } | undefined;
      expect(row?.last_alerted_threshold_microusd).toBe(2_800_000);
    });
  });

  it("uses exact micro-USD thresholds and the current interval after config changes", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-interval-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const precise = config({ everyUsd: 1.000_007 });
      record({ total: 1.000_006_1, cfg: precise, nowMs: 1_000 });
      expect(preparePendingModelSpendAlert({ cfg: precise, agentId: "main" })?.text).toContain(
        "crossed $1.000007",
      );

      const changed = config({ everyUsd: 2 });
      record({ total: 1, cfg: changed, nowMs: 2_000 });
      const next = preparePendingModelSpendAlert({ cfg: changed, agentId: "main" });
      expect(next?.text).toContain("reached $2.000007");
      expect(next?.text).toContain("crossed $2.00");
    });
  });

  it("attempts the tracking-incomplete warning once per provider day", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-incomplete-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      for (let index = 0; index < 2; index += 1) {
        recordConfiguredModelSpendCall({
          cfg,
          agentId: "main",
          call: {
            model: model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        });
      }
      expect(preparePendingModelSpendAlert({ cfg, agentId: "main" })?.text).toContain(
        "tracking is incomplete for deepseek",
      );
      expect(preparePendingModelSpendAlert({ cfg, agentId: "main" })).toBeUndefined();
    });
  });

  it("resets daily pools in the configured timezone and keeps prior-day alerts", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-timezone-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config({ timeZone: "Asia/Shanghai" });
      record({ total: 1.5, cfg, nowMs: Date.parse("2026-01-01T15:59:00Z") });
      record({ total: 1, cfg, nowMs: Date.parse("2026-01-01T16:01:00Z") });
      record({ total: 0.5, cfg, nowMs: Date.parse("2026-01-01T16:03:00Z") });

      const pending = preparePendingModelSpendAlert({ cfg, agentId: "main" });
      expect(pending?.text.match(/Model spend alert:/g)).toHaveLength(2);
      expect(pending?.text).toContain("2026-01-01");
      expect(pending?.text).toContain("2026-01-02");
      expect(pending?.text).toContain("daily reset: Asia/Shanghai");
    });
  });

  it("keeps accumulated spend across an agent database restart", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-restart-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const nowMs = Date.parse("2026-01-01T12:00:00Z");
      record({ total: 1, nowMs });
      closeOpenClawAgentDatabasesForTest();
      record({ total: 0.5, nowMs });
      closeOpenClawAgentDatabasesForTest();

      expect(preparePendingModelSpendAlert({ cfg: config(), agentId: "main" })?.text).toContain(
        "reached $1.50",
      );
    });
  });

  it("attempts alerts only on configured owner direct routes", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-owner-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg: OpenClawConfig = {
        ...config(),
        commands: { ownerAllowFrom: ["telegram:owner-a"] },
      };
      record({ total: 1.5, cfg });

      expect(
        preparePrivateOwnerModelSpendAlertBestEffort({
          cfg,
          agentId: "main",
          channel: "telegram",
          to: "owner-a",
          chatType: "group",
        }),
      ).toBeUndefined();
      expect(
        preparePrivateOwnerModelSpendAlertBestEffort({
          cfg,
          agentId: "main",
          channel: "telegram",
          to: "user-x",
          chatType: "direct",
        }),
      ).toBeUndefined();
      expect(
        preparePrivateOwnerModelSpendAlertBestEffort({
          cfg,
          agentId: "main",
          channel: "telegram",
          to: "owner-a",
          chatType: "direct",
        })?.text,
      ).toContain("deepseek reached $1.50");
    });
  });

  it("prunes old daily totals on the next recorded call", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-retention-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      record({ total: 1.5, nowMs: Date.parse("2020-01-01T12:00:00Z") });
      record({ total: 0.1 });

      expect(
        openOpenClawAgentDatabase({ agentId: "main" })
          .db.prepare("SELECT day_key FROM model_spend_daily WHERE day_key = ? AND provider = ?")
          .get("2020-01-01", "deepseek"),
      ).toBeUndefined();
    });
  });

  it("creates the additive table lazily for an existing current-version database", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-lazy-schema-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const opened = openOpenClawAgentDatabase({ agentId: "main" });
      opened.db.exec("DROP TABLE model_spend_daily");
      closeOpenClawAgentDatabasesForTest();

      const reopened = openOpenClawAgentDatabase({ agentId: "main" });
      expect(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'model_spend_daily'",
          )
          .get(),
      ).toBeUndefined();

      expect(record({ total: 0.1 })).toBe("recorded");
      expect(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'model_spend_daily'",
          )
          .get(),
      ).toEqual({ name: "model_spend_daily" });
    });
  });
});
