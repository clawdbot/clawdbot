import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionMemberAddParamsSchema,
  SessionMembersListEvidenceResultSchema,
  SessionMembersListResultSchema,
  SessionSharingEvidenceEventSchema,
  SessionSharingEventSchema,
  SessionVisibilitySetParamsSchema,
} from "./sessions-sharing.js";

const baseEvent = {
  action: "visibility",
  sessionKey: "agent:main:main",
  agentId: "main",
  visibility: "draft",
  ts: 1,
} as const;

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
        members: [{ identityId: "alice", addedBy: "profile-ada", addedAt: 1 }],
        identities: [],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionMembersListResultSchema, {
        sessionKey: "agent:main:main",
        members: [{ identityId: "bob", addedByState: "unknown", addedAt: 2 }],
        identities: [],
        role: "owner",
        allowedVisibilities: [],
      }),
    ).toBe(false);
    for (const member of [
      { identityId: "alice", addedBy: "profile-ada", addedAt: 1 },
      { identityId: "bob", addedByState: "unknown", addedAt: 2 },
      { identityId: "carol", addedAt: 3 },
    ]) {
      expect(
        Value.Check(SessionMembersListEvidenceResultSchema, {
          sessionKey: "agent:main:main",
          members: [member],
          identities: [],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(SessionMembersListEvidenceResultSchema, {
        sessionKey: "agent:main:main",
        members: [
          {
            identityId: "mixed",
            addedBy: "profile-ada",
            addedByState: "unknown",
            addedAt: 4,
          },
        ],
        identities: [],
        role: "owner",
        allowedVisibilities: [],
      }),
    ).toBe(false);
  });

  it("rejects unknown visibility modes", () => {
    expect(
      Value.Check(SessionVisibilitySetParamsSchema, {
        sessionKey: "agent:main:main",
        visibility: "private",
      }),
    ).toBe(false);
  });

  it("keeps the legacy event actor required", () => {
    expect(
      Value.Check(SessionSharingEventSchema, {
        ...baseEvent,
        actor: { type: "human", id: "profile-ada", label: "Ada" },
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionSharingEventSchema, {
        ...baseEvent,
        actorState: "unknown",
      }),
    ).toBe(false);
    expect(Value.Check(SessionSharingEventSchema, baseEvent)).toBe(false);
    expect(
      Value.Check(SessionSharingEventSchema, {
        ...baseEvent,
        actor: { type: "human", id: "profile-ada" },
        actorState: "unknown",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionSharingEvidenceEventSchema, {
        ...baseEvent,
        actorState: "unknown",
      }),
    ).toBe(true);
    expect(Value.Check(SessionSharingEvidenceEventSchema, baseEvent)).toBe(true);
    expect(
      Value.Check(SessionSharingEvidenceEventSchema, {
        ...baseEvent,
        actor: { type: "human", id: "profile-ada" },
      }),
    ).toBe(false);
  });
});
