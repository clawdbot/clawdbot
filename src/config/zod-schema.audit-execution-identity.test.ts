import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("logging.audit.executionIdentity", () => {
  it("accepts only the explicit boolean config surface", () => {
    expect(
      OpenClawSchema.safeParse({
        logging: { audit: { executionIdentity: true } },
      }).success,
    ).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        logging: { audit: { executionIdentity: false } },
      }).success,
    ).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        logging: { audit: { executionIdentity: "true" } },
      }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        logging: { audit: { execution_identity: true } },
      }).success,
    ).toBe(false);
  });
});
