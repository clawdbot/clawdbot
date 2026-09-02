import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionObserverDigestSchema } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeSessionObserverModelOutput } from "./session-observer-model.js";

describe("session observer schema", () => {
  it("validates protocol digests", () => {
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        agentId: "main",
        runId: "run-1",
        revision: 1,
        updatedAt: 1,
        headline: "Checking the implementation",
        health: "on-track",
        planProgress: { completed: 2, total: 4 },
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        revision: 1,
        updatedAt: 1,
        headline: "x".repeat(121),
        health: "on-track",
      }),
    ).toBe(false);
  });

  it("rejects loose JSON and truncates accepted strings to hard caps", () => {
    expect(normalizeSessionObserverModelOutput("```json\n{}\n```")).toBeNull();
    const normalized = normalizeSessionObserverModelOutput(
      JSON.stringify({
        headline: "h".repeat(140),
        assessment: "a".repeat(400),
        health: "grinding",
      }),
    );
    expect(normalized?.headline).toHaveLength(120);
    expect(normalized?.assessment).toHaveLength(320);
  });
});
