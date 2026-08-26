import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronMcpToolsAllowDiagnostics as createCronToolsAllowPreflightDiagnostics } from "./run-delivery-trace.js";
import { logWarn } from "./run.runtime.js";

const mcpConfigMocks = vi.hoisted(() => ({
  resolveStaticSessionMcpSafeServerNames: vi.fn(),
  resolveStaticSessionMcpServerNames: vi.fn(),
}));

vi.mock("../../agents/agent-bundle-mcp-runtime-config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/agent-bundle-mcp-runtime-config.js")>();
  mcpConfigMocks.resolveStaticSessionMcpSafeServerNames.mockImplementation(
    actual.resolveStaticSessionMcpSafeServerNames,
  );
  mcpConfigMocks.resolveStaticSessionMcpServerNames.mockImplementation(
    actual.resolveStaticSessionMcpServerNames,
  );
  return {
    ...actual,
    resolveStaticSessionMcpSafeServerNames: mcpConfigMocks.resolveStaticSessionMcpSafeServerNames,
    resolveStaticSessionMcpServerNames: mcpConfigMocks.resolveStaticSessionMcpServerNames,
  };
});

vi.mock("./run.runtime.js", () => ({ logWarn: vi.fn() }));

const cfg = {
  mcp: {
    servers: {
      notes: { transport: "stdio", command: "notes-mcp" },
    },
  },
} as OpenClawConfig;

const MCP_SUPPRESSION_WARNING =
  "This automation's explicit toolsAllow omits every configured MCP selector, so no configured MCP tools will be exposed. Add bundle-mcp, group:plugins, a matching <server>__<tool> selector, or * to enable configured MCP tools.";

beforeEach(async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/agent-bundle-mcp-runtime-config.js")
  >("../../agents/agent-bundle-mcp-runtime-config.js");
  mcpConfigMocks.resolveStaticSessionMcpSafeServerNames.mockReset();
  mcpConfigMocks.resolveStaticSessionMcpSafeServerNames.mockImplementation(
    actual.resolveStaticSessionMcpSafeServerNames,
  );
  mcpConfigMocks.resolveStaticSessionMcpServerNames.mockReset();
  mcpConfigMocks.resolveStaticSessionMcpServerNames.mockImplementation(
    actual.resolveStaticSessionMcpServerNames,
  );
  vi.mocked(logWarn).mockReset();
});

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
    { name: "cross-namespace MCP glob", toolsAllow: ["*__read"] },
    { name: "server namespace MCP glob", toolsAllow: ["notes__*"] },
  ])("does not warn for $name", async ({ toolsAllow }) => {
    await expect(
      createCronToolsAllowPreflightDiagnostics(makePreflightParams(toolsAllow)),
    ).resolves.toBeUndefined();
  });

  it("warns when an exact selector belongs to another tool namespace", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics(makePreflightParams(["other__read"])),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });

  it.each(["notes__foo.bar", "notes__123", "notes____read", `notes__${"a".repeat(58)}`])(
    "warns when %s cannot name a model-facing MCP tool",
    async (selector) => {
      await expect(
        createCronToolsAllowPreflightDiagnostics(makePreflightParams([selector])),
      ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
    },
  );

  it("accepts a glob with a valid model-facing MCP tool witness", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics(makePreflightParams(["notes__*123"])),
    ).resolves.toBeUndefined();
  });

  it("matches the static server's full-set collision-safe tool prefix", async () => {
    const collidingCfg = {
      mcp: {
        servers: {
          "notes prod": {
            transport: "streamable-http",
            url: "https://notes.example.test/mcp",
            auth: "oauth",
            oauth: { identity: "per-requester" },
          },
          "notes.prod": { transport: "stdio", command: "notes-mcp" },
        },
      },
    } as OpenClawConfig;
    const base = { ...makePreflightParams(["notes-prod-2__read"]), cfg: collidingCfg };

    await expect(createCronToolsAllowPreflightDiagnostics(base)).resolves.toBeUndefined();
    await expect(
      createCronToolsAllowPreflightDiagnostics({
        ...base,
        agentPayload: { kind: "agentTurn", message: "run", toolsAllow: ["notes-prod__read"] },
      }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });

  it("matches an exact selector when the safe server name contains the separator", async () => {
    await expect(
      createCronToolsAllowPreflightDiagnostics({
        ...makePreflightParams(["notes__prod__read"]),
        cfg: {
          mcp: {
            servers: {
              notes__prod: { transport: "stdio", command: "notes-mcp" },
            },
          },
        } as OpenClawConfig,
      }),
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

  it("does not fail a core-only run when configured MCP inspection fails", async () => {
    mcpConfigMocks.resolveStaticSessionMcpSafeServerNames.mockImplementationOnce(() => {
      throw new Error("stale plugin root");
    });

    await expect(
      createCronToolsAllowPreflightDiagnostics(makePreflightParams(["read"])),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "[cron:job-explicit-cap] Failed to inspect configured MCP state for toolsAllow diagnostics: Error: stale plugin root",
    );
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

  it("does not fail a legacy Codex run when configured MCP inspection fails", async () => {
    mcpConfigMocks.resolveStaticSessionMcpServerNames.mockImplementationOnce(() => {
      throw new Error("stale plugin root");
    });

    await expect(
      createCronToolsAllowPreflightDiagnostics({
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
      }),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "[cron:job-1] Failed to inspect configured MCP state for toolsAllow diagnostics: Error: stale plugin root",
    );
  });

  it.each([
    { name: "explicit cap", toolsAllowIsDefault: false },
    { name: "inherited cap", toolsAllowIsDefault: true },
  ])("applies Codex agent scoping to an $name", async ({ toolsAllowIsDefault }) => {
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
        ...(toolsAllowIsDefault ? { toolsAllowIsDefault: true as const } : {}),
      },
    };

    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...base, agentId: "support" }),
    ).resolves.toBeUndefined();
    await expect(
      createCronToolsAllowPreflightDiagnostics({ ...base, agentId: "research" }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });

  it("uses runtime-neutral MCP discovery for non-Codex runs", async () => {
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

    await expect(
      createCronToolsAllowPreflightDiagnostics({
        ...makePreflightParams(["read"]),
        cfg: agentScopedCfg,
        agentId: "support",
        agentRuntime: "pi",
      }),
    ).resolves.toMatchObject({ entries: [expect.objectContaining({ severity: "warn" })] });
  });
});
