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

const MCP_SUPPRESSION_WARNING =
  "This automation's explicit toolsAllow omits every configured MCP selector, so the bundle MCP runtime will not start. Add bundle-mcp, group:plugins, an exact <server>__<tool> selector, or * to enable configured MCP tools.";

function makePreflightParams(toolsAllow: string[] | undefined) {
  return {
    cfg,
    jobId: "job-explicit-cap",
    provider: "anthropic",
    model: "claude-sonnet-5",
    workspaceDir: "/workspace",
    agentPayload: {
      kind: "agentTurn" as const,
      message: "run",
      ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    },
  };
}

describe("configured MCP explicit-cap diagnostics", () => {
  it("persists an actionable warning when a finite explicit cap suppresses configured MCP", async () => {
    const diagnostics = await createCronToolsAllowPreflightDiagnostics(
      makePreflightParams(["read"]),
    );

    expect(diagnostics).toMatchObject({
      summary: MCP_SUPPRESSION_WARNING,
      entries: [
        expect.objectContaining({
          source: "cron-preflight",
          severity: "warn",
          message: MCP_SUPPRESSION_WARNING,
        }),
      ],
    });
  });

  it.each([
    { name: "omitted cap", toolsAllow: undefined },
    { name: "intentional deny-all cap", toolsAllow: [] },
    { name: "wildcard cap", toolsAllow: ["*"] },
    { name: "bundle group", toolsAllow: ["bundle-mcp"] },
    { name: "plugin group", toolsAllow: ["group:plugins"] },
    { name: "exact MCP tool", toolsAllow: ["notes__read"] },
  ])("does not warn for $name", async ({ toolsAllow }) => {
    await expect(
      createCronToolsAllowPreflightDiagnostics(makePreflightParams(toolsAllow)),
    ).resolves.toBeUndefined();
  });

  it("does not warn when the run has no enabled configured MCP server", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics({
        ...makePreflightParams(["read"]),
        cfg: {},
      }),
    ).resolves.toBeUndefined();
  });
});

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
