import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  };
}

describe("resolveCronDeliveryPlan", () => {
  it("preserves explicit message target context for delivery.mode=none", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        name: "Cron Target Context",
        payload: { kind: "agentTurn", message: "send a message" },
        delivery: {
          mode: "none",
          channel: "telegram",
          to: "123:topic:42",
          threadId: 42,
          accountId: "ops",
        },
      }),
    );

    expect(plan).toEqual({
      mode: "none",
      channel: "telegram",
      to: "123:topic:42",
      threadId: 42,
      accountId: "ops",
      source: "delivery",
      requested: false,
    });
  });
});
