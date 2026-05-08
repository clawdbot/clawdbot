import { describe, expect, it } from "vitest";
import { CronJobStateSchema } from "../gateway/protocol/schema.js";

type SchemaLike = {
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
});
