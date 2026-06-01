import { describe, expect, it } from "vitest";
import { resolveFailureDestination } from "../delivery-plan.js";
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
