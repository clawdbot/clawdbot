import { describe, it, expect } from "vitest";
import { resolveCronDeliveryPlan } from "./delivery.js";

describe("Cron Delivery - mode none with channel last", () => {
  it("should ignore channel='last' when mode='none'", () => {
    const job = {
      id: "test-job",
      name: "Test Job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Test message",
      },
      delivery: {
        mode: "none",
        channel: "last",
        to: "some-target",
      },
    } as any;

    const plan = resolveCronDeliveryPlan(job);

    expect(plan.mode).toBe("none");
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBeUndefined();
  });

  it("should ignore channel='telegram' when mode='none'", () => {
    const job = {
      id: "test-job",
      name: "Test Job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Test message",
      },
      delivery: {
        mode: "none",
        channel: "telegram",
        to: "@user",
      },
    } as any;

    const plan = resolveCronDeliveryPlan(job);

    expect(plan.mode).toBe("none");
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBeUndefined();
  });

  it("should use channel when mode='announce' even if channel='last'", () => {
    const job = {
      id: "test-job",
      name: "Test Job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Test message",
      },
      delivery: {
        mode: "announce",
        channel: "last",
        to: "some-target",
      },
    } as any;

    const plan = resolveCronDeliveryPlan(job);

    expect(plan.mode).toBe("announce");
    expect(plan.channel).toBe("last");
    expect(plan.to).toBe("some-target");
  });

  it("should use channel from payload when mode='none' in delivery", () => {
    const job = {
      id: "test-job",
      name: "Test Job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "Test message",
        channel: "telegram",
        to: "@user",
      },
      delivery: {
        mode: "none",
      },
    } as any;

    const plan = resolveCronDeliveryPlan(job);

    expect(plan.mode).toBe("none");
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBeUndefined();
  });
});
