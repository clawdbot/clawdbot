import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionMemberAddParamsSchema,
  SessionMembersListResultSchema,
  SessionVisibilitySetParamsSchema,
} from "./sessions-sharing.js";

describe("session sharing protocol", () => {
  it("accepts additive visibility and membership payloads", () => {
    expect(
      Value.Check(SessionVisibilitySetParamsSchema, {
        sessionKey: "agent:main:main",
        visibility: "draft",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionMemberAddParamsSchema, {
        sessionKey: "agent:main:main",
        identityId: "alice@example.com",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionMembersListResultSchema, {
        sessionKey: "agent:main:main",
        members: [],
        identities: [],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      }),
    ).toBe(true);
  });

  it("rejects unknown visibility modes", () => {
    expect(
      Value.Check(SessionVisibilitySetParamsSchema, {
        sessionKey: "agent:main:main",
        visibility: "private",
      }),
    ).toBe(false);
  });
});
