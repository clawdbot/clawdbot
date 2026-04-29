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
    expect(lastStatus).toBeDefined();
    expect(lastStatus?.deprecated).toBe(true);
  });
});
