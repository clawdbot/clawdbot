import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsAssignOwnerParams } from "../index.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionRowSchema", () => {
  it("round-trips optional sharing fields", () => {
    const row = {
      key: "agent:main:main",
      kind: "global",
      lastRunId: "run-settled",
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
        { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
        { identity: { type: "agent", id: "research" }, label: "Research" },
      ],
      participantCount: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      archiveReason: "manual",
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
    expect(SessionRowSchema.properties.activeModel).toBeDefined();
    expect(SessionRowSchema.properties.activeModelProvider).toBeDefined();
    expect(SessionRowSchema.properties.lastRunId).toBeDefined();
    expect(Value.Check(SessionRowSchema, roundTripped)).toBe(true);
    expect(Value.Check(SessionRowSchema, { ...roundTripped, activeLeafEntryId: null })).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        ...roundTripped,
        participants: Array.from({ length: 5 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionRowSchema, {
        ...roundTripped,
        expandedParticipants: Array.from({ length: 32 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        ...roundTripped,
        expandedParticipants: Array.from({ length: 33 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(false);
    expect(roundTripped).toMatchObject({
      activeLeafEntryId: "leaf-rendered",
      lastRunId: "run-settled",
      createdActor: { avatarUrl: "/api/users/profile-ada/avatar?v=7" },
      participantCount: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      archiveReason: "manual",
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
    expect(Value.Check(SessionRowSchema, { ...roundTripped, lastRunId: "" })).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...roundTripped, archiveReason: "unknown" })).toBe(
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

  it.each(["user", "auto", null] as const)("accepts model override source %s", (source) => {
    expect(
      Value.Check(SessionRowSchema, {
        key: "agent:main:main",
        kind: "global",
        modelOverrideSource: source,
      }),
    ).toBe(true);
  });

  it("rejects an invalid model override source", () => {
    expect(
      Value.Check(SessionRowSchema, {
        key: "agent:main:main",
        kind: "global",
        modelOverrideSource: "session",
      }),
    ).toBe(false);
  });
});
