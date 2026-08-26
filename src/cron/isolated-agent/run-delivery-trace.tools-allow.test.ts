import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createCronMcpToolsAllowDiagnostics,
  createCronToolsAllowPreflightDiagnostics,
} from "./run-delivery-trace.js";

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

describe("configured MCP explicit-cap diagnostics", () => {
  const base = {
    cfg,
    jobId: "job-explicit-cap",
    provider: "openai",
    model: "gpt-5.4",
    workspaceDir: "/workspace",
    agentRuntime: "openclaw",
  };

  it.each([
    { toolsAllow: ["notes__missing"], materializedName: "nonexistent selector" },
    { toolsAllow: ["notes__search"], materializedName: "collision-renamed selector" },
  ])("warns when a $materializedName matched no exposed MCP tool", async ({ toolsAllow }) => {
    const diagnostics = await createCronMcpToolsAllowDiagnostics({
      ...base,
      agentPayload: { kind: "agentTurn", message: "run", toolsAllow },
      materialization: {
        provider: "openai",
        model: "gpt-5.4",
        materializedToolCount: 1,
        toolsAllowMatchedToolCount: 0,
      },
    });

    expect(diagnostics?.summary).toContain("suppressed every configured MCP tool");
  });

  it("does not infer selector success without matching terminal materialization evidence", async () => {
    await expect(
      createCronMcpToolsAllowDiagnostics({
        ...base,
        agentPayload: {
          kind: "agentTurn",
          message: "run",
          toolsAllow: ["notes__missing"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not warn when the explicit cap matched before later conversation filtering", async () => {
    await expect(
      createCronMcpToolsAllowDiagnostics({
        ...base,
        agentPayload: {
          kind: "agentTurn",
          message: "run",
          toolsAllow: ["notes__search"],
        },
        materialization: {
          provider: "openai",
          model: "gpt-5.4",
          materializedToolCount: 1,
          toolsAllowMatchedToolCount: 1,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("uses static inspection only for an obvious finite cap that cannot start MCP", async () => {
    const diagnostics = await createCronMcpToolsAllowDiagnostics({
      ...base,
      agentPayload: { kind: "agentTurn", message: "run", toolsAllow: ["read"] },
    });

    expect(diagnostics?.summary).toContain("suppressed every configured MCP tool");
  });

  it("does not warn for an intentional deny-all cap", async () => {
    await expect(
      createCronMcpToolsAllowDiagnostics({
        ...base,
        agentPayload: { kind: "agentTurn", message: "run", toolsAllow: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores materialization evidence from a different fallback candidate", async () => {
    await expect(
      createCronMcpToolsAllowDiagnostics({
        ...base,
        agentPayload: {
          kind: "agentTurn",
          message: "run",
          toolsAllow: ["notes__missing"],
        },
        materialization: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          materializedToolCount: 1,
          toolsAllowMatchedToolCount: 0,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("applies Codex agent scoping only to the terminal runtime projection", async () => {
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
    const params = {
      ...base,
      cfg: agentScopedCfg,
      agentRuntime: "codex",
      agentPayload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["read"] },
    };

    await expect(
      createCronMcpToolsAllowDiagnostics({ ...params, agentId: "support" }),
    ).resolves.toBeUndefined();
    await expect(
      createCronMcpToolsAllowDiagnostics({ ...params, agentId: "research" }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });
});
