// Cron job patch tests cover applying partial updates to scheduled jobs.
import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "../delivery-plan.js";
import { projectCronJobThroughStorageCodec } from "../store/row-codec.js";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
    state: {},
    ...overrides,
  };
}

describe("applyJobPatch delivery merge", () => {
  it("threads explicit delivery threadId patches into delivery", () => {
    const job = makeJob();
    const patch = { delivery: { threadId: "99" } } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("clears nullable delivery fields", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: "99",
        accountId: "bot-a",
        failureDestination: {
          mode: "announce",
          channel: "slack",
          to: "C123",
          accountId: "bot-b",
        },
      },
    });
    const patch = {
      delivery: {
        channel: null,
        to: null,
        threadId: null,
        accountId: null,
        failureDestination: null,
      },
    } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("preserves implicit delivery when clearing an absent override", () => {
    const job = makeJob({ delivery: undefined });

    applyJobPatch(job, {
      delivery: { channel: null },
    });

    expect(job.delivery).toBeUndefined();
  });

  it("preserves implicit detached delivery when patching best-effort", () => {
    const job = makeJob({ delivery: undefined });

    applyJobPatch(job, {
      delivery: { bestEffort: false },
    });

    expect(job.delivery).toEqual({ mode: "announce", bestEffort: false });
    expect(resolveCronDeliveryPlan(job).mode).toBe("announce");
  });

  it("preserves implicit main-session delivery when patching best-effort", () => {
    const job = makeJob({
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
      delivery: undefined,
    });

    applyJobPatch(job, {
      delivery: { bestEffort: false },
    });

    expect(job.delivery).toBeUndefined();
    expect(resolveCronDeliveryPlan(job).mode).toBe("none");
  });

  it("clears nullable failure destination fields", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        failureDestination: {
          mode: "announce",
          channel: "slack",
          to: "C123",
          accountId: "bot-b",
        },
      },
    });
    const patch = {
      delivery: {
        failureDestination: {
          channel: null,
          to: null,
          accountId: null,
          mode: null,
        },
      },
    } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    const failureDestination = job.delivery?.failureDestination;
    expect(failureDestination).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
      mode: undefined,
    });
    expect(Object.hasOwn(failureDestination as object, "channel")).toBe(true);
    expect(Object.hasOwn(failureDestination as object, "to")).toBe(true);
    expect(Object.hasOwn(failureDestination as object, "accountId")).toBe(true);
    expect(Object.hasOwn(failureDestination as object, "mode")).toBe(true);
    expect(
      resolveFailureDestination(job, {
        channel: "slack",
        to: "C123",
        accountId: "bot-b",
      }),
    ).toBeNull();
  });

  it("keeps unspecified failure destination fields inheriting global defaults", () => {
    const job = makeJob();

    applyJobPatch(job, {
      delivery: {
        failureDestination: {
          to: "C123",
        },
      },
    });

    const failureDestination = job.delivery?.failureDestination;
    expect(failureDestination).toEqual({ to: "C123" });
    expect(Object.hasOwn(failureDestination as object, "channel")).toBe(false);
    expect(resolveFailureDestination(job, { channel: "slack", accountId: "bot-a" })).toEqual({
      mode: "announce",
      channel: "slack",
      to: "C123",
      accountId: "bot-a",
    });
  });

  it("uses nullable failure destination fields to clear inherited global defaults", () => {
    const job = makeJob();

    applyJobPatch(job, {
      delivery: {
        failureDestination: {
          channel: null,
          to: "C123",
          accountId: null,
          mode: null,
        },
      },
    });

    const failureDestination = job.delivery?.failureDestination;
    expect(failureDestination?.to).toBe("C123");
    expect(Object.hasOwn(failureDestination as object, "channel")).toBe(true);
    expect(Object.hasOwn(failureDestination as object, "accountId")).toBe(true);
    expect(Object.hasOwn(failureDestination as object, "mode")).toBe(true);
    expect(
      resolveFailureDestination(job, {
        channel: "slack",
        accountId: "bot-a",
        mode: "webhook",
      }),
    ).toEqual({
      mode: "announce",
      channel: "last",
      to: "C123",
      accountId: undefined,
    });
  });

  it("preserves main-job clear-only failure destinations as global opt-outs", () => {
    const job = makeJob({
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
      delivery: undefined,
    });

    applyJobPatch(job, {
      delivery: {
        failureDestination: {
          channel: null,
          to: null,
          accountId: null,
          mode: null,
        },
      },
    });

    const failureDestination = job.delivery?.failureDestination;
    expect(job.delivery?.mode).toBe("none");
    expect(failureDestination).toEqual({
      channel: undefined,
      to: undefined,
      accountId: undefined,
      mode: undefined,
    });
    expect(
      resolveFailureDestination(job, {
        channel: "slack",
        to: "C123",
        accountId: "bot-a",
      }),
    ).toBeNull();
  });
});

describe("applyJobPatch failure alert merge", () => {
  it("clears explicit fields, preserves omitted fields, and persists the result", () => {
    const job = makeJob({
      failureAlert: {
        after: 2,
        channel: "telegram",
        to: "123456",
        cooldownMs: 60_000,
        includeSkipped: true,
        mode: "announce",
        accountId: "bot-a",
      },
    });

    applyJobPatch(job, {
      failureAlert: {
        after: null,
        to: null,
        cooldownMs: null,
        accountId: null,
      },
    });

    expect(job.failureAlert).toEqual({
      after: undefined,
      channel: "telegram",
      to: undefined,
      cooldownMs: undefined,
      includeSkipped: true,
      mode: "announce",
      accountId: undefined,
    });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toEqual({
      channel: "telegram",
      includeSkipped: true,
      mode: "announce",
    });

    applyJobPatch(job, {
      failureAlert: { channel: null, includeSkipped: null, mode: null },
    });
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toEqual({});
  });

  it("clears the whole override only for explicit null", () => {
    const original = { after: 2, channel: "telegram" as const };
    const job = makeJob({ failureAlert: original });

    applyJobPatch(job, {});
    expect(job.failureAlert).toEqual(original);

    applyJobPatch(job, { failureAlert: null });
    expect(job.failureAlert).toBeUndefined();
    expect(projectCronJobThroughStorageCodec(job).failureAlert).toBeUndefined();
  });
});
