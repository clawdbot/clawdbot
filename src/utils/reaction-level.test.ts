// Reaction level tests cover normalization of reaction intensity values.
import { describe, expect, it } from "vitest";
import { resolveReactionLevel } from "./reaction-level.js";

describe("resolveReactionLevel", () => {
  it.each([
    {
      name: "defaults when value is missing",
      input: {
        value: undefined,
        defaultLevel: "minimal" as const,
        invalidFallback: "ack" as const,
      },
      expected: {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      },
    },
    {
      name: "supports ack",
      input: { value: "ack", defaultLevel: "minimal" as const, invalidFallback: "ack" as const },
      expected: { level: "ack", ackEnabled: true, agentReactionsEnabled: false },
    },
    {
      name: "supports extensive",
      input: {
        value: "extensive",
        defaultLevel: "minimal" as const,
        invalidFallback: "ack" as const,
      },
      expected: {
        level: "extensive",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "extensive",
      },
    },
    {
      name: "uses invalid fallback ack",
      input: { value: "bogus", defaultLevel: "minimal" as const, invalidFallback: "ack" as const },
      expected: { level: "ack", ackEnabled: true, agentReactionsEnabled: false },
    },
    {
      name: "uses invalid fallback minimal",
      input: {
        value: "bogus",
        defaultLevel: "minimal" as const,
        invalidFallback: "minimal" as const,
      },
      expected: {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(resolveReactionLevel(input)).toEqual(expected);
  });
});
