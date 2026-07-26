import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  failDurableDelivery,
  suppressDurableDelivery,
} from "../infra/outbound/delivery-completion.js";
import type { Model } from "../llm/types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { preparePrivateOwnerModelSpendAlertBestEffort } from "./model-spend-alert-delivery.js";
import {
  markModelSpendAlertsDelivered,
  markModelSpendAlertsQueued,
  markModelSpendAlertsUnknown,
  preparePendingModelSpendAlertBestEffort as preparePendingModelSpendAlert,
  recordConfiguredModelSpendCall,
  releaseModelSpendAlerts,
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

function record(params: {
  id: string;
  total: number;
  cfg?: OpenClawConfig;
  nowMs?: number;
  deliveryTarget?: {
    sessionKey?: string;
    channel?: string;
    to?: string;
    chatType?: string;
  };
}) {
  return recordConfiguredModelSpendCall({
    cfg: params.cfg ?? config(),
    agentId: "main",
    deliveryTarget: params.deliveryTarget,
    nowMs: params.nowMs,
    call: {
      accountingCallId: params.id,
      model: model(),
      usage: billedUsage(params.total),
    },
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
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: { input: 1, output: 1 },
      }),
    ).toEqual({ costMicroUsd: 3, trackingComplete: false });
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: { input: 1, output: 1, total: 2 },
      }),
    ).toEqual({ costMicroUsd: 3, trackingComplete: true });
    expect(
      resolveModelSpendCostMicroUsd({
        model: model(),
        usage: { output: 1, total: 1 },
      }),
    ).toEqual({ costMicroUsd: 2, trackingComplete: true });
    expect(
      resolveModelSpendCostMicroUsd({
        model: model({ cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 } }),
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      }),
    ).toEqual({ costMicroUsd: 0, trackingComplete: false });
    for (const inconsistentTotal of [1, 4]) {
      expect(
        resolveModelSpendCostMicroUsd({
          model: model(),
          usage: { input: 1, output: 1, total: inconsistentTotal },
        }),
      ).toEqual({ costMicroUsd: 3, trackingComplete: false });
    }
  });

  it("creates one combined alert when one call crosses multiple thresholds", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-threshold-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      expect(record({ id: "call-1", total: 3 })).toBe("recorded");
      const pending = preparePendingModelSpendAlert({
        cfg: config(),
        agentId: "main",
        sessionKey: "agent:main:main",
      });

      expect(pending?.alertIds).toHaveLength(1);
      expect(pending?.text).toContain("deepseek reached $3.00");
      expect(pending?.text).toContain("crossed $1.40 through $2.80");
      expect(pending?.text).toContain("daily reset: UTC");
    });
  });

  it("uses configured tiered pricing instead of the runtime model's flat fallback", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-tiered-pricing-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config({ everyUsd: 1 });
      cfg.models = {
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com",
            api: "openai-completions",
            models: [
              {
                id: "deepseek-chat",
                name: "DeepSeek Chat",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0.3,
                  output: 1.5,
                  cacheRead: 0,
                  cacheWrite: 0,
                  tieredPricing: [
                    {
                      input: 0.3,
                      output: 1.5,
                      cacheRead: 0,
                      cacheWrite: 0,
                      range: [0, 32_000],
                    },
                    {
                      input: 0.5,
                      output: 2.5,
                      cacheRead: 0,
                      cacheWrite: 0,
                      range: [32_000, 128_000],
                    },
                  ],
                },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      };

      expect(
        recordConfiguredModelSpendCall({
          cfg,
          agentId: "main",
          call: {
            accountingCallId: "tiered-pricing",
            model: model(),
            usage: {
              input: 40_000,
              output: 10_000,
              cacheRead: 0,
              cacheWrite: 0,
              total: 50_000,
            },
          },
        }),
      ).toBe("recorded");

      const row = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("SELECT spend_microusd FROM model_spend_daily WHERE provider = ?")
        .get("deepseek") as { spend_microusd: number } | undefined;
      expect(row?.spend_microusd).toBe(45_000);
    });
  });

  it("does not round a configured six-decimal interval up by one micro-USD", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-micro-usd-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config({ everyUsd: 1.000_007 });
      expect(record({ id: "micro-usd-threshold", total: 1.000_006_1, cfg })).toBe("recorded");

      const pending = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(pending?.alertIds).toHaveLength(1);
      const alertId = pending?.alertIds[0];
      if (!alertId) {
        throw new Error("expected a model-spend threshold alert");
      }
      const row = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("SELECT first_threshold_microusd FROM model_spend_alerts WHERE alert_id = ?")
        .get(alertId) as { first_threshold_microusd: number } | undefined;
      expect(row?.first_threshold_microusd).toBe(1_000_007);
    });
  });

  it("uses the current interval when configuration changes during a provider day", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-interval-change-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const firstConfig = config({ everyUsd: 1.4 });
      record({ id: "before-change", total: 1.5, cfg: firstConfig, nowMs: 1_000 });
      const first = preparePendingModelSpendAlert({
        cfg: firstConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      markModelSpendAlertsDelivered({
        agentId: "main",
        alertIds: first?.alertIds ?? [],
        deliveryIntentId: first?.deliveryIntentId ?? "missing",
      });

      const changedConfig = config({ everyUsd: 2 });
      record({ id: "after-change", total: 0.6, cfg: changedConfig, nowMs: 2_000 });
      const changed = preparePendingModelSpendAlert({
        cfg: changedConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(changed?.text).toContain("reached $2.10");
      expect(changed?.text).toContain("crossed $2.00");
      expect(changed?.text).not.toContain("$3.40");
    });
  });

  it("deduplicates terminal callbacks across restart and serializes concurrent completions", async () => {
    const stateDir = tempDirs.make("openclaw-model-spend-dedupe-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      expect(record({ id: "same-call", total: 1 })).toBe("recorded");
      expect(record({ id: "same-call", total: 1 })).toBe("duplicate");
      closeOpenClawAgentDatabasesForTest();
      expect(record({ id: "same-call", total: 1 })).toBe("duplicate");

      await Promise.all([
        Promise.resolve().then(() => record({ id: "call-2", total: 0.2 })),
        Promise.resolve().then(() => record({ id: "call-3", total: 0.2 })),
      ]);
      const row = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "SELECT spend_microusd FROM model_spend_daily WHERE day_key = ? AND provider = ?",
        )
        .get(new Date().toISOString().slice(0, 10), "deepseek") as
        | { spend_microusd: number }
        | undefined;
      expect(row?.spend_microusd).toBe(1_400_000);
    });
  });

  it("attributes only monitored providers instead of charging fallback attempts to the request provider", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-provider-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const result = recordConfiguredModelSpendCall({
        cfg: config(),
        agentId: "main",
        call: {
          accountingCallId: "fallback-openai",
          model: model({ provider: "openai", id: "gpt-5.4" }),
          usage: billedUsage(9),
        },
      });
      expect(result).toBe("provider_not_monitored");
      expect(preparePendingModelSpendAlert({ cfg: config(), agentId: "main" })).toBeUndefined();
    });
  });

  it("emits at most one tracking-incomplete notice per provider day", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-incomplete-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      for (const id of ["missing-1", "missing-2"]) {
        recordConfiguredModelSpendCall({
          cfg,
          agentId: "main",
          call: {
            accountingCallId: id,
            model: model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        });
      }
      const pending = preparePendingModelSpendAlert({ cfg, agentId: "main" });
      expect(pending?.alertIds).toHaveLength(1);
      expect(pending?.text).toContain("tracking is incomplete for deepseek");
    });
  });

  it("resets the pool at midnight in the configured user timezone", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-timezone-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config({ timeZone: "Asia/Shanghai" });
      record({ id: "before-midnight", total: 1, cfg, nowMs: Date.parse("2026-01-01T15:59:00Z") });
      record({ id: "after-midnight-1", total: 1, cfg, nowMs: Date.parse("2026-01-01T16:01:00Z") });
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      ).toBeUndefined();

      record({
        id: "after-midnight-2",
        total: 0.5,
        cfg,
        nowMs: Date.parse("2026-01-01T16:03:00Z"),
      });
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:main",
        })?.text,
      ).toContain("2026-01-02");
    });
  });

  it("keeps an undelivered prior-day alert pending after the daily reset", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-pending-day-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config({ timeZone: "Asia/Shanghai" });
      record({
        id: "prior-day",
        total: 1.5,
        cfg,
        nowMs: Date.parse("2026-01-01T15:59:00Z"),
      });

      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:main",
        })?.text,
      ).toContain("2026-01-01");
    });
  });

  it("preserves the reset timezone used when each pending pool was recorded", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-timezone-change-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const recordedAt = Date.parse("2026-01-01T12:00:00Z");
      const utcConfig = config({ timeZone: "UTC" });
      const shanghaiConfig = config({ timeZone: "Asia/Shanghai" });
      record({ id: "utc-pool", total: 1.5, cfg: utcConfig, nowMs: recordedAt });
      record({ id: "shanghai-pool", total: 1.5, cfg: shanghaiConfig, nowMs: recordedAt });

      const pending = preparePendingModelSpendAlert({
        cfg: shanghaiConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(pending?.alertIds).toHaveLength(2);
      expect(pending?.text).toContain("daily reset: UTC");
      expect(pending?.text).toContain("daily reset: Asia/Shanghai");
    });
  });

  it("formats separate provider-day pools as separate alerts", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-multi-day-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      record({ id: "day-1", total: 1.5, cfg, nowMs: Date.parse("2026-01-01T12:00:00Z") });
      record({ id: "day-2", total: 3, cfg, nowMs: Date.parse("2026-01-02T12:00:00Z") });

      const prepared = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(prepared?.alertIds).toHaveLength(2);
      expect(prepared?.text.match(/Model spend alert:/g)).toHaveLength(2);
      expect(prepared?.text).toContain("reached $1.50 on 2026-01-01");
      expect(prepared?.text).toContain("reached $3.00 on 2026-01-02");
    });
  });

  it("prioritizes the current session within a bounded alert batch", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-batch-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg: OpenClawConfig = {
        ...config({ everyUsd: 0.01 }),
        commands: { ownerAllowFrom: ["telegram:owner-a"] },
      };
      for (let index = 0; index < 100; index += 1) {
        record({ id: `background-${index}`, total: 0.01, cfg });
      }
      record({
        id: "current-session",
        total: 0.01,
        cfg,
        deliveryTarget: {
          sessionKey: "agent:main:main",
          channel: "telegram",
          to: "owner-a",
          chatType: "direct",
        },
      });

      const first = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(first?.alertIds).toHaveLength(100);
      expect(first?.alertIds.some((id) => id.endsWith(":current-session"))).toBe(true);
      expect(first?.text).not.toContain("$0.01 through $1.01");
      expect(first?.text).toContain("$0.99, $1.01");
      markModelSpendAlertsDelivered({
        agentId: "main",
        alertIds: first?.alertIds ?? [],
        deliveryIntentId: first?.deliveryIntentId ?? "missing",
      });

      const second = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(second?.alertIds).toHaveLength(1);
      expect(second?.text).toContain("crossed $1.00");
    });
  });

  it("prunes expired terminal alerts and daily totals on the next recorded call", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-retention-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      const oldTimestamp = Date.parse("2020-01-01T12:00:00Z");
      record({ id: "old-call", total: 1.5, cfg, nowMs: oldTimestamp });
      const oldAlert = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      markModelSpendAlertsDelivered({
        agentId: "main",
        alertIds: oldAlert?.alertIds ?? [],
        deliveryIntentId: oldAlert?.deliveryIntentId ?? "missing",
      });
      const oldAlertId = oldAlert?.alertIds[0];
      if (!oldAlertId) {
        throw new Error("expected old model-spend alert");
      }
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare("UPDATE model_spend_alerts SET updated_at = ? WHERE alert_id = ?").run(
        oldTimestamp,
        oldAlertId,
      );

      record({ id: "current-call", total: 0.1, cfg });

      expect(
        db.prepare("SELECT alert_id FROM model_spend_alerts WHERE alert_id = ?").get(oldAlertId),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT day_key FROM model_spend_daily WHERE day_key = ? AND provider = ?")
          .get("2020-01-01", "deepseek"),
      ).toBeUndefined();
    });
  });

  it("creates additive tables lazily for an existing current-version database", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-lazy-schema-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const opened = openOpenClawAgentDatabase({ agentId: "main" });
      opened.db.exec(`
        DROP TABLE model_spend_alerts;
        DROP TABLE model_spend_calls;
        DROP TABLE model_spend_daily;
      `);
      closeOpenClawAgentDatabasesForTest();

      const reopened = openOpenClawAgentDatabase({ agentId: "main" });
      expect(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'model_spend_%'",
          )
          .all(),
      ).toEqual([]);

      expect(record({ id: "lazy-call", total: 0.1 })).toBe("recorded");
      expect(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'model_spend_daily'",
          )
          .get(),
      ).toEqual({ name: "model_spend_daily" });
    });
  });

  it("rejects a partially present additive model-spend schema", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-partial-schema-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const opened = openOpenClawAgentDatabase({ agentId: "main" });
      opened.db.exec(`
        DROP TABLE model_spend_alerts;
        DROP TABLE model_spend_calls;
      `);
      closeOpenClawAgentDatabasesForTest();

      expect(() => openOpenClawAgentDatabase({ agentId: "main" })).toThrow(
        /missing table model_spend_(alerts|calls)/u,
      );
    });
  });

  it("targets safe owner sessions, holds unsafe routes globally, and commits delivery", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-delivery-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg: OpenClawConfig = {
        ...config(),
        commands: { ownerAllowFrom: ["telegram:owner-a", "telegram:owner-b"] },
      };
      record({
        id: "targeted",
        total: 1.5,
        cfg,
        deliveryTarget: {
          sessionKey: "agent:main:telegram:a",
          channel: "telegram",
          to: "owner-a",
          chatType: "direct",
        },
      });
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:telegram:b",
        }),
      ).toBeUndefined();
      const targeted = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:telegram:a",
      });
      expect(targeted).toBeDefined();
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:telegram:a",
        }),
      ).toBeUndefined();
      const targetedCompletion = {
        agentId: "main",
        alertIds: targeted?.alertIds ?? [],
        deliveryIntentId: targeted?.deliveryIntentId ?? "missing",
      };
      expect(
        markModelSpendAlertsQueued(targetedCompletion, targetedCompletion.deliveryIntentId),
      ).toEqual({
        status: "queued",
      });
      releaseModelSpendAlerts(targetedCompletion);
      const retried = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:telegram:a",
      });
      expect(retried).toBeDefined();
      const retriedCompletion = {
        agentId: "main",
        alertIds: retried?.alertIds ?? [],
        deliveryIntentId: retried?.deliveryIntentId ?? "missing",
      };
      markModelSpendAlertsDelivered(retriedCompletion);
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:telegram:a",
        }),
      ).toBeUndefined();

      record({
        id: "group",
        total: 1.5,
        cfg,
        deliveryTarget: {
          sessionKey: "agent:main:telegram:group",
          channel: "telegram",
          to: "owner-a",
          chatType: "group",
        },
      });
      record({
        id: "non-owner",
        total: 1.5,
        cfg,
        deliveryTarget: {
          sessionKey: "agent:main:telegram:non-owner",
          channel: "telegram",
          to: "user-x",
          chatType: "direct",
        },
      });
      expect(
        preparePrivateOwnerModelSpendAlertBestEffort({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:telegram:group",
          channel: "telegram",
          to: "owner-b",
          chatType: "group",
        }),
      ).toBeUndefined();
      expect(
        preparePrivateOwnerModelSpendAlertBestEffort({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:telegram:non-owner",
          channel: "telegram",
          to: "user-x",
          chatType: "direct",
        }),
      ).toBeUndefined();
      const globalAlerts = preparePrivateOwnerModelSpendAlertBestEffort({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:telegram:b",
        channel: "telegram",
        to: "owner-b",
        chatType: "direct",
      });
      expect(globalAlerts?.alertIds).toHaveLength(2);
      expect(globalAlerts?.alertIds.some((id) => id.endsWith(":group"))).toBe(true);
      expect(globalAlerts?.alertIds.some((id) => id.endsWith(":non-owner"))).toBe(true);
    });
  });

  it("keeps unknown send outcomes terminal and enforces delivery ownership", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-unknown-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      record({ id: "unknown", total: 1.5, cfg });
      const prepared = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      const completion = {
        agentId: "main",
        alertIds: prepared?.alertIds ?? [],
        deliveryIntentId: prepared?.deliveryIntentId ?? "missing",
      };

      expect(() => markModelSpendAlertsQueued(completion, "another-owner")).toThrow(
        "queue id does not match",
      );
      markModelSpendAlertsQueued(completion, completion.deliveryIntentId);
      markModelSpendAlertsUnknown(completion);
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      ).toBeUndefined();
      expect(markModelSpendAlertsQueued(completion, completion.deliveryIntentId)).toEqual({
        status: "sent",
      });
    });
  });

  it("reclaims only expired claims without a matching durable queue intent", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-orphan-claim-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      record({ id: "orphaned", total: 1.5, cfg });
      const orphaned = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      const orphanedAlertId = orphaned?.alertIds[0];
      if (!orphanedAlertId) {
        throw new Error("expected orphaned model-spend alert");
      }
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("UPDATE model_spend_alerts SET updated_at = 0 WHERE alert_id = ?")
        .run(orphanedAlertId);

      const recovered = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(recovered?.alertIds).toEqual(orphaned?.alertIds);
      expect(recovered?.deliveryIntentId).not.toBe(orphaned?.deliveryIntentId);

      const orphanedCompletion = {
        agentId: "main",
        alertIds: orphaned?.alertIds ?? [],
        deliveryIntentId: orphaned?.deliveryIntentId ?? "missing",
      };
      const recoveredCompletion = {
        agentId: "main",
        alertIds: recovered?.alertIds ?? [],
        deliveryIntentId: recovered?.deliveryIntentId ?? "missing",
      };
      expect(() =>
        markModelSpendAlertsQueued(orphanedCompletion, orphanedCompletion.deliveryIntentId),
      ).toThrow("delivery ownership changed");
      expect(
        markModelSpendAlertsQueued(recoveredCompletion, recoveredCompletion.deliveryIntentId),
      ).toEqual({ status: "queued" });
    });
  });

  it("releases suppressed alerts but terminally records irreconcilable sends", () => {
    const stateDir = tempDirs.make("openclaw-model-spend-completion-state-");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = config();
      record({ id: "completion-state", total: 1.5, cfg });
      const suppressed = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      suppressDurableDelivery({
        kind: "model_spend_alert",
        agentId: "main",
        alertIds: suppressed?.alertIds ?? [],
        deliveryIntentId: suppressed?.deliveryIntentId ?? "missing",
      });

      const unknown = preparePendingModelSpendAlert({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      failDurableDelivery({
        kind: "model_spend_alert",
        agentId: "main",
        alertIds: unknown?.alertIds ?? [],
        deliveryIntentId: unknown?.deliveryIntentId ?? "missing",
      });
      expect(
        preparePendingModelSpendAlert({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      ).toBeUndefined();
    });
  });
});
