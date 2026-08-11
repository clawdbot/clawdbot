import { describe, expect, it } from "vitest";
import { validateSessionsCreateParams } from "../index.js";

describe("sessions.create schema", () => {
  it("accepts additive create-time visibility values", () => {
    for (const visibility of ["shared", "read-only", "suggest", "draft"]) {
      expect(validateSessionsCreateParams({ agentId: "main", visibility })).toBe(true);
    }
  });

  it("rejects unknown visibility values", () => {
    expect(validateSessionsCreateParams({ agentId: "main", visibility: "private" })).toBe(false);
  });

  it("accepts restart recovery requests", () => {
    expect(
      validateSessionsCreateParams({
        agentId: "main",
        parentSessionKey: "agent:main:dashboard:tombstoned",
        recover: true,
      }),
    ).toBe(true);
  });
});
