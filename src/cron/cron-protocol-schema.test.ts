import { Value } from "typebox/value";
// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { describe, expect, it } from "vitest";
import {
  CronAddParamsSchema,
  CronJobStateSchema,
  CronPacingSchema,
  CronUpdateParamsSchema,
} from "../../packages/gateway-protocol/src/schema.js";

type SchemaLike = {
  description?: string;
  properties?: Record<string, unknown>;
  deprecated?: boolean;
};

describe("cron protocol schema", () => {
  it("marks the legacy lastStatus alias deprecated", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    const lastStatus = properties.lastStatus as SchemaLike | undefined;
    if (!lastStatus) {
      throw new Error("expected legacy lastStatus schema alias");
    }
    expect(lastStatus.deprecated).toBe(true);
  });

  it("exposes failure-notification delivery state", () => {
    const properties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(properties.lastFailureNotificationDelivered).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryStatus).toBeDefined();
    expect(properties.lastFailureNotificationDeliveryError).toBeDefined();
  });

  it("reports stream identity without accepting it in state patches", () => {
    const stateProperties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(stateProperties.streamSourceIdentity).toBeDefined();

    const updateProperties = (CronUpdateParamsSchema as SchemaLike).properties ?? {};
    const patchProperties = (updateProperties.patch as SchemaLike | undefined)?.properties ?? {};
    const patchStateProperties =
      (patchProperties.state as SchemaLike | undefined)?.properties ?? {};
    expect(patchStateProperties.streamSourceIdentity).toBeUndefined();
  });

  it("reports schedule activation without accepting it in state patches", () => {
    const stateProperties = (CronJobStateSchema as SchemaLike).properties ?? {};
    expect(stateProperties.scheduleActivatedAtMs).toBeDefined();

    const updateProperties = (CronUpdateParamsSchema as SchemaLike).properties ?? {};
    const patchProperties = (updateProperties.patch as SchemaLike | undefined)?.properties ?? {};
    const patchState = patchProperties.state as SchemaLike | undefined;
    expect(patchState?.properties?.scheduleActivatedAtMs).toBeUndefined();
  });

  it("documents that pacing requires at least one bound", () => {
    expect((CronPacingSchema as SchemaLike).description).toContain(
      "at least one of min or max is required",
    );
  });

  it("keeps system-owned payloads out of client create and patch schemas", () => {
    const payload = { kind: "skillCollectionReview" };
    expect(
      Value.Check(CronAddParamsSchema, {
        name: "skill review",
        schedule: { kind: "every", everyMs: 604_800_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload,
      }),
    ).toBe(false);
    expect(
      Value.Check(CronUpdateParamsSchema, {
        id: "job-1",
        patch: { payload },
      }),
    ).toBe(false);
  });
});
