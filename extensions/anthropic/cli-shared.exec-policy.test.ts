// Anthropic tests cover how the Claude CLI backend layers global and per-agent exec policy.
import { describe, expect, it } from "vitest";
import { normalizeClaudeBackendConfig } from "./cli-shared.js";

function normalizeArgsForAgentExec(agentExec: Record<string, string>): string[] | undefined {
  return normalizeClaudeBackendConfig(
    { command: "claude", args: ["-p"], output: "json", input: "arg" },
    {
      backendId: "claude-cli",
      agentId: "agent",
      config: {
        tools: { exec: { security: "deny", ask: "off" } },
        agents: { list: [{ id: "agent", tools: { exec: agentExec } }] },
      },
    } as Parameters<typeof normalizeClaudeBackendConfig>[1],
  ).args;
}

describe("Claude backend exec policy layering", () => {
  it("keeps restrictive global exec security when the agent block omits it", () => {
    expect(normalizeArgsForAgentExec({ ask: "off" })).not.toContain("bypassPermissions");
  });

  it("still lets an explicit per-agent exec mode override global security", () => {
    expect(normalizeArgsForAgentExec({ mode: "full" })).toContain("bypassPermissions");
  });
});
