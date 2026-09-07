import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronToolsAllowPreflightDiagnostics } from "./run-delivery-trace.js";

const cfg = {
  mcp: {
    servers: {
      notes: { transport: "stdio", command: "notes-mcp" },
    },
  },
} as OpenClawConfig;

describe("configured MCP inherited-cap diagnostics", () => {
  it("persists an actionable warning for legacy Codex default caps", async () => {
    const diagnostics = await createCronToolsAllowPreflightDiagnostics({
      cfg,
      jobId: "job-1",
      provider: "openai",
      model: "gpt-5.4-codex",
      workspaceDir: "/workspace",
      agentRuntime: "codex",
      agentPayload: {
        kind: "agentTurn",
        message: "run",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true,
      },
    });

    expect(diagnostics?.entries[0]).toMatchObject({
      source: "cron-preflight",
      severity: "warn",
    });
    expect(diagnostics?.summary).toContain("openclaw automations edit job-1 --tools <tool,...>");
  });

  it("does not warn after final executable-surface capture", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics({
        cfg,
        jobId: "job-1",
        provider: "openai",
        model: "gpt-5.4-codex",
        workspaceDir: "/workspace",
        agentRuntime: "codex",
        toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
        agentPayload: {
          kind: "agentTurn",
          message: "run",
          toolsAllow: ["notes__read"],
          toolsAllowIsDefault: true,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not warn for a configured MCP server excluded from the run agent", async () => {
    const agentScopedCfg = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "notes-mcp",
            codex: { agents: ["research"] },
          },
        },
      },
    } as OpenClawConfig;
    const base = {
      cfg: agentScopedCfg,
      jobId: "job-agent-scope",
      provider: "openai",
      model: "gpt-5.4-codex",
      workspaceDir: "/workspace",
      agentRuntime: "codex",
      agentPayload: {
        kind: "agentTurn" as const,
        message: "run",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true as const,
      },
    };

    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...base, agentId: "support" }),
    ).resolves.toBeUndefined();
    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...base, agentId: "research" }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });
});
