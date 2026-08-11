import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionCompactionCheckpointSchema } from "./sessions.js";

describe("SessionCompactionCheckpointSchema", () => {
  const checkpoint = {
    checkpointId: "checkpoint-1",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    createdAt: 1,
    reason: "manual",
    tokensBefore: 100,
    tokensAfter: 40,
    tokensVersion: 1,
    preCompaction: { sessionId: "session-1", entryId: "before" },
    postCompaction: { sessionId: "session-1", entryId: "after" },
  } as const;

  it("round-trips v1 token provenance and rejects unknown versions", () => {
    expect(Value.Check(SessionCompactionCheckpointSchema, checkpoint)).toBe(true);
    expect(Value.Decode(SessionCompactionCheckpointSchema, checkpoint)).toEqual(checkpoint);
    expect(
      Value.Check(SessionCompactionCheckpointSchema, { ...checkpoint, tokensVersion: 2 }),
    ).toBe(false);
  });
});
