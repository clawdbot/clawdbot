import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: () => undefined,
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: mocks.createBundleMcpToolRuntime,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

const { collectRuntimeToolSchemaFindings } = await import("./doctor-core-checks.runtime.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockResolvedValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockResolvedValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports active bundle MCP tool schemas that would be quarantined before a model turn", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [
        bundleMcpTool("dofbot__healthy", { type: "object", properties: {} }),
        bundleMcpTool("dofbot__dofbot_move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent main tool dofbot__dofbot_move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "dofbot__dofbot_move_angles",
      requirement: 'dofbot__dofbot_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports bundle MCP runtime diagnostics when tool listing fails schema validation", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "dofbot",
          safeServerName: "dofbot",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        'Configured MCP server "dofbot" could not expose runtime tools for schema validation.',
      path: "mcp.servers.dofbot",
      requirement: 'tools[0].inputSchema.type: Invalid input: expected "object"',
      fixHint:
        "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports bundle MCP runtime diagnostics for exact MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "dofbot",
          safeServerName: "dofbot",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["dofbot__healthy"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.dofbot",
      }),
    );
  });

  it("reports exact MCP allowlists when the safe server name contains the separator", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "my__server",
          safeServerName: "my__server",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["my__server__healthy"] },
        mcp: {
          servers: {
            my__server: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.my__server",
      }),
    );
  });

  it("reports bundle MCP runtime diagnostics for glob MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "dofbot",
          safeServerName: "dofbot",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["*__healthy"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.dofbot",
      }),
    );
  });

  it("reports unsupported schemas exposed only to a non-default configured agent", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "worker"
        ? [tool("dofbot_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/shared-workspace" },
            { id: "worker", workspace: "/tmp/shared-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool dofbot_move_angles has an unsupported input schema for runtime projection.",
      path: "tools.dofbot_move_angles",
      target: "dofbot_move_angles",
      requirement: 'dofbot_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("skips ACP-only agents because they do not use embedded tool projection", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "acp-worker"
        ? [tool("dofbot_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("acp")
          ? [bundleMcpTool("dofbot__bad", { type: "array", items: { type: "number" } })]
          : [],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            {
              id: "acp-worker",
              workspace: "/tmp/acp-workspace",
              runtime: { type: "acp" },
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
  });

  it("loads bundled MCP runtime once per distinct agent workspace", async () => {
    mocks.createOpenClawCodingTools.mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("worker")
          ? [
              bundleMcpTool("dofbot__dofbot_move_angles", {
                type: "array",
                items: { type: "number" },
              }),
            ]
          : [bundleMcpTool("healthy", { type: "object", properties: {} })],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            { id: "worker", workspace: "/tmp/worker-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool dofbot__dofbot_move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "dofbot__dofbot_move_angles",
      requirement: 'dofbot__dofbot_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("worker-workspace") }),
    );
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not report bundle MCP schemas filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [
        bundleMcpTool("dofbot__dofbot_move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "dofbot",
          safeServerName: "dofbot",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by server-level deny policy", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "dofbot",
          safeServerName: "dofbot",
          launchSummary: "node dofbot-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["dofbot__*"] },
        mcp: {
          servers: {
            dofbot: { command: "node", args: ["dofbot-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });
});
