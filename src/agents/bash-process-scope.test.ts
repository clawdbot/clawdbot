import { describe, expect, it } from "vitest";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";

describe("resolveProcessToolScopeKey", () => {
  it.each([
    {
      name: "explicit scope before session identifiers",
      params: {
        scopeKey: " scope:explicit ",
        sessionKey: "session-key",
        sessionId: "session-id",
        agentId: "main",
      },
      expected: "scope:explicit",
    },
    {
      name: "session key before session and agent ids",
      params: {
        scopeKey: "  ",
        sessionKey: " session-key ",
        sessionId: "session-id",
        agentId: "main",
      },
      expected: "session-key",
    },
    {
      name: "session id before agent id",
      params: { sessionKey: "\t", sessionId: " session-id ", agentId: "main" },
      expected: "session-id",
    },
    {
      name: "agent id fallback",
      params: { sessionId: "\n", agentId: " main " },
      expected: "agent:main",
    },
    {
      name: "blank inputs",
      params: { scopeKey: " ", sessionKey: "\t", sessionId: "\n", agentId: "  " },
      expected: undefined,
    },
  ])("uses $name", ({ params, expected }) => {
    expect(resolveProcessToolScopeKey(params)).toBe(expected);
  });
});
