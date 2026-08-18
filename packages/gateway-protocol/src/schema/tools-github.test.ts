import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ToolsGitHubConfigureParamsSchema,
  ToolsGitHubStatusResultSchema,
} from "./agents-models-skills.js";

describe("GitHub tools protocol", () => {
  it.each([
    {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-11111111111111111111111111111111",
    },
    { scope: "system", agentId: "main", mode: "inherit" },
    {
      scope: "agent",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-22222222222222222222222222222222",
      gitAuthor: { name: "Agent" },
    },
    { scope: "agent", agentId: "main", mode: "inherit" },
  ])("accepts configure action %#", (action) => {
    expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(true);
  });

  it.each([
    { scope: "system", mode: "inherit" },
    { scope: "agent", mode: "inherit" },
    { scope: "system", mode: "managed" },
    { scope: "system", agentId: "main", mode: "managed", secretName: "ONE_USE_HANDOFF" },
    { scope: "system", agentId: "main", mode: "managed", secretName: "github-setup-token" },
    { scope: "agent", agentId: "main", mode: "managed", secretName: "HANDOFF", extra: true },
    {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-33333333333333333333333333333333",
      gitAuthor: { name: "   " },
    },
    {
      scope: "agent",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-44444444444444444444444444444444",
      gitAuthor: { email: "\t\n" },
    },
  ])("rejects impossible configure action %#", (action) => {
    expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(false);
  });

  it("keeps credentials out of status", () => {
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        source: "system-configured",
        credentialState: "configured_unavailable",
        account: null,
        gitAuthor: { name: null, email: null },
        evidence: "none",
      }),
    ).toBe(true);
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        source: "agent-override",
        credentialState: "available",
        account: { login: "octocat", avatarUrl: null },
        gitAuthor: { name: "Agent", email: null },
        evidence: "github-api",
        token: "not-allowed",
      }),
    ).toBe(false);
  });
});
