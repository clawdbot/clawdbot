import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionClassificationSchema, SessionPeerKindSchema } from "./session-classification.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("session classification schemas", () => {
  it("accepts flattened derived facts through the canonical row schema", () => {
    expect(Value.Check(SessionClassificationSchema, "plugin-owned")).toBe(true);
    expect(Value.Check(SessionPeerKindSchema, "topic")).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        key: "agent:main:telegram:main:direct:peer",
        kind: "direct",
        classification: "direct",
        agentId: "main",
        accountId: "main",
        peerKind: "direct",
        isMain: false,
        isBackground: false,
      }),
    ).toBe(true);
  });
});
