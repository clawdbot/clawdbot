// Cron protocol schema tests cover runtime validation for cron protocol payloads.
import { describe, expect, it } from "vitest";
import {
  CronJobStateSchema,
  CronPacingSchema,
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

  it("documents that pacing requires at least one bound", () => {
    expect((CronPacingSchema as SchemaLike).description).toContain(
      "at least one of min or max is required",
    );
  });
});
