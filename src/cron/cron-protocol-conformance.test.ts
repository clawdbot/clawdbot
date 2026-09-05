// Cron protocol conformance tests cover schema compatibility for cron messages.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { FAILOVER_REASONS } from "../../packages/gateway-protocol/src/failover-reasons.js";
import {
  CronDeliverySchema,
  CronJobStateSchema,
  CronRunLogEntrySchema,
} from "../../packages/gateway-protocol/src/schema.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";

type CronDelivery = NonNullable<CronJob["delivery"]>;

const DELIVERY_FIXTURES = {
  none: { mode: "none", threadId: 42 },
  announce: {
    mode: "announce",
    channel: "telegram",
    threadId: "topic-42",
    completionDestination: { mode: "webhook", to: "https://example.test/complete" },
    failureDestination: { mode: "announce", channel: "last", to: "ops" },
  },
  webhook: { mode: "webhook", to: "https://example.test/result" },
} satisfies Record<CronDelivery["mode"], CronDelivery>;

describe("cron protocol conformance", () => {
  it("accepts every typed delivery mode and rejects unknown modes", () => {
    for (const delivery of Object.values(DELIVERY_FIXTURES)) {
      expect(Value.Check(CronDeliverySchema, delivery)).toBe(true);
    }
    expect(Value.Check(CronDeliverySchema, { mode: "email" })).toBe(false);
  });

  it("accepts every core failover reason in state and run-history schemas", () => {
    for (const reason of FAILOVER_REASONS) {
      expect(Value.Check(CronJobStateSchema, { lastErrorReason: reason })).toBe(true);
      expect(
        Value.Check(CronRunLogEntrySchema, {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          errorReason: reason,
        }),
      ).toBe(true);
    }

    expect(Value.Check(CronJobStateSchema, { lastErrorReason: "not-a-reason" })).toBe(false);
    expect(
      Value.Check(CronRunLogEntrySchema, {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        errorReason: "not-a-reason",
      }),
    ).toBe(false);
  });
});
