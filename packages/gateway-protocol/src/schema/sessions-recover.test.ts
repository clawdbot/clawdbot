import { describe, expect, it } from "vitest";
import { validateSessionsCreateParams, validateSessionsRecoverParams } from "../index.js";

describe("sessions.recover schema", () => {
  it("accepts only a source key and optional agent", () => {
    expect(validateSessionsRecoverParams({ key: "agent:main:dashboard:dead" })).toBe(true);
    expect(validateSessionsRecoverParams({ key: "global", agentId: "main" })).toBe(true);
    expect(validateSessionsRecoverParams({ key: "", agentId: "main" })).toBe(false);
    expect(validateSessionsRecoverParams({ key: "global", message: "replace this" })).toBe(false);
  });

  it("keeps recovery out of generic session creation", () => {
    expect(
      validateSessionsCreateParams({
        parentSessionKey: "agent:main:dashboard:dead",
        recover: true,
      }),
    ).toBe(false);
  });
});
