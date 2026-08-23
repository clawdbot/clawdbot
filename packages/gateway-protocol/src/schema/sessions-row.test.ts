import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsAssignOwnerParams } from "../index.js";
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
      participants: [
        { type: "human", id: "profile-bob", label: "Bob" },
        { type: "agent", id: "research", label: "Research" },
      ],
      participantCount: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      icon: "🦞",
      channelAvatarUrl: "/__openclaw__/channel-avatar/agent%3Amain%3Amain",
      visibility: "suggest",
      sharingRole: "owner",
      restartRecoveryStatus: "tombstoned",
      permissionMode: "workspace",
      sessionRoot: "/workspace/project",
    };
    const roundTripped = structuredClone(row);

    expect(SessionRowSchema.properties.activeLeafEntryId).toBeDefined();
    expect(Value.Check(SessionRowSchema, roundTripped)).toBe(true);
    expect(Value.Check(SessionRowSchema, { ...roundTripped, activeLeafEntryId: null })).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        ...roundTripped,
        participants: Array.from({ length: 5 }, (_, index) => ({
          type: "human",
          id: `profile-${index}`,
        })),
      }),
    ).toBe(false);
    expect(roundTripped).toMatchObject({
      activeLeafEntryId: "leaf-rendered",
      createdActor: { avatarUrl: "/api/users/profile-ada/avatar?v=7" },
      participantCount: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      channelAvatarUrl: "/__openclaw__/channel-avatar/agent%3Amain%3Amain",
      visibility: "suggest",
      sharingRole: "owner",
      restartRecoveryStatus: "tombstoned",
      permissionMode: "workspace",
      sessionRoot: "/workspace/project",
    });
    expect(Value.Check(SessionRowSchema, { ...roundTripped, permissionMode: "unrestricted" })).toBe(
      false,
    );
  });

  it("keeps sessions.assignOwner target actors closed and non-empty", () => {
    const accepted = [
      { key: "agent:main:handoff", owner: { type: "human", id: "profile-ada" } },
      { key: "agent:main:handoff", owner: { type: "agent", id: "research" }, agentId: "main" },
    ];
    const rejected = [
      { key: "agent:main:handoff", owner: { type: "system", id: "system" } },
      { key: "agent:main:handoff", owner: { type: "human", id: "" } },
      { key: "agent:main:handoff", owner: { type: "human", id: "ada", label: "Ada" } },
    ];

    expect(accepted.every(validateSessionsAssignOwnerParams)).toBe(true);
    expect(rejected.every((value) => !validateSessionsAssignOwnerParams(value))).toBe(true);
  });
});
