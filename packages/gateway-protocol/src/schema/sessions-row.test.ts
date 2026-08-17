import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionRowSchema", () => {
  it("round-trips optional sharing fields", () => {
    const row = {
      key: "agent:main:main",
      kind: "global",
      activeLeafEntryId: "leaf-rendered",
      createdActor: {
        type: "human",
        id: "profile-ada",
        label: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=7",
      },
      owner: {
        actor: { type: "agent", id: "research", label: "Research" },
        assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
        assignedAt: 42,
      },
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      icon: "🦞",
      visibility: "suggest",
      sharingRole: "owner",
      restartRecoveryStatus: "tombstoned",
    };
    const roundTripped = structuredClone(row);

    expect(SessionRowSchema.properties.activeLeafEntryId).toBeDefined();
    expect(Value.Check(SessionRowSchema, roundTripped)).toBe(true);
    expect(Value.Check(SessionRowSchema, { ...roundTripped, activeLeafEntryId: null })).toBe(true);
    expect(roundTripped).toMatchObject({
      activeLeafEntryId: "leaf-rendered",
      createdActor: { avatarUrl: "/api/users/profile-ada/avatar?v=7" },
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      visibility: "suggest",
      sharingRole: "owner",
      restartRecoveryStatus: "tombstoned",
    });
  });
});
