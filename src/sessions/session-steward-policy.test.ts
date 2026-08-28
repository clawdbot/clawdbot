import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveSessionStewardBoundary,
  type SessionStewardBoundaryDecision,
} from "./session-steward-policy.js";

type SessionStewardBoundaryFixture = {
  name: string;
  sessionKey?: string | null;
  requestedAgentId?: string | null;
  configuredAgentIds?: string[];
  expected: SessionStewardBoundaryDecision;
  rawMustNotContain?: string[];
};

const fixtures = JSON.parse(
  readFileSync("test/fixtures/session-steward-boundary-cases.json", "utf8"),
) as SessionStewardBoundaryFixture[];

describe("Session Steward boundary policy", () => {
  it.each(fixtures)("classifies and redacts $name", (fixture) => {
    const decision = resolveSessionStewardBoundary({
      sessionKey: fixture.sessionKey,
      requestedAgentId: fixture.requestedAgentId,
      configuredAgentIds: fixture.configuredAgentIds,
    });
    expect(decision).toEqual(fixture.expected);
    expect(decision.affectedSession).toBe(fixture.expected.affectedSession);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
    }
  });

  it("does not return raw session tails in serialized decisions", () => {
    const decision = resolveSessionStewardBoundary({
      sessionKey: "agent:main:direct:person-123:thread:thread-456",
      requestedAgentId: "worker",
      configuredAgentIds: ["main", "worker"],
    });
    const serialized = JSON.stringify(decision);
    expect(decision).toMatchObject({
      kind: "agent",
      ownerAgentId: "main",
      requestedAgentId: "worker",
      agentRelation: "cross_agent",
      affectedSession: "agent:main:REDACTED",
    });
    expect(serialized).not.toContain("person-123");
    expect(serialized).not.toContain("thread-456");
  });

  it("exposes configured agent ids without exposing credential-shaped ids", () => {
    expect(
      resolveSessionStewardBoundary({
        sessionKey: "agent:main:direct:user-1",
        requestedAgentId: "worker",
        configuredAgentIds: ["main", "worker"],
      }),
    ).toMatchObject({
      ownerAgentId: "main",
      requestedAgentId: "worker",
      agentRelation: "cross_agent",
      affectedSession: "agent:main:REDACTED",
    });
    expect(
      resolveSessionStewardBoundary({
        sessionKey: "agent:sk-abcdefghijk:main",
        requestedAgentId: "sk-abcdefghijk",
      }),
    ).toMatchObject({
      ownerAgentId: "UNKNOWN",
      requestedAgentId: "UNKNOWN",
      agentRelation: "same_agent",
      affectedSession: "agent:UNKNOWN:REDACTED",
    });
  });

  it("keeps unconfigured agent ids out of serialized boundary facts", () => {
    const decision = resolveSessionStewardBoundary({
      sessionKey: "agent:ordinary-unconfigured-owner:direct:peer-123",
      requestedAgentId: "ordinary-unconfigured-owner",
    });
    expect(decision).toMatchObject({
      kind: "agent",
      ownerAgentId: "UNKNOWN",
      requestedAgentId: "UNKNOWN",
      agentRelation: "same_agent",
      affectedSession: "agent:UNKNOWN:REDACTED",
    });
    expect(JSON.stringify(decision)).not.toContain("ordinary-unconfigured-owner");
    expect(JSON.stringify(decision)).not.toContain("peer-123");
  });
});
