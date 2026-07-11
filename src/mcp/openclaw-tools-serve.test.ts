// OpenClaw MCP tools tests cover core tool server startup and registration.
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashCrestodianOperation } from "../agents/tools/crestodian-tool.js";
import {
  buildCrestodianToolsMcpServerConfig,
  OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV,
  OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV,
  OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV,
  resolveOpenClawToolsMcpCrestodianSurface,
  resolveOpenClawToolsMcpToolSelection,
} from "./openclaw-tools-serve-config.js";
import {
  OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveOpenClawToolsForMcp,
  resolveOpenClawToolsMcpAgentSessionKey,
} from "./openclaw-tools-serve.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenClaw tools MCP server", () => {
  it("exposes cron", async () => {
    const handlers = createPluginToolsMcpHandlers(
      resolveOpenClawToolsForMcp({ agentSessionKey: "agent:worker:main" }),
    );

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("cron");
  });

  it("requires the managed bridge to pass a real agent session key", () => {
    expect(() => resolveOpenClawToolsForMcp({ agentSessionKey: "" })).toThrow(
      OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
    );
  });

  it("reads the managed bridge agent session key from env", () => {
    expect(
      resolveOpenClawToolsMcpAgentSessionKey({
        [OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV]: " agent:worker:main ",
      }),
    ).toBe("agent:worker:main");
  });

  it("serves the ring-zero crestodian tool without an agent session key", async () => {
    const handlers = createPluginToolsMcpHandlers(
      resolveOpenClawToolsForMcp({ tools: ["crestodian"], crestodianSurface: "cli" }),
    );

    const listed = await handlers.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["crestodian"]);
  });

  it("returns approved CLI MCP mutations to the host instead of applying them", async () => {
    const operation = { kind: "config-set", path: "gateway.port", value: "19001" } as const;
    vi.stubEnv(OPENCLAW_TOOLS_MCP_CRESTODIAN_APPROVAL_ARMED_ENV, "1");
    vi.stubEnv(OPENCLAW_TOOLS_MCP_CRESTODIAN_PROPOSAL_ENV, hashCrestodianOperation(operation));
    const handlers = createPluginToolsMcpHandlers(
      resolveOpenClawToolsForMcp({ tools: ["crestodian"], crestodianSurface: "cli" }),
    );

    const result = await handlers.callTool({
      name: "crestodian",
      arguments: {
        action: "config_set",
        path: "gateway.port",
        value: "19001",
        approved: true,
      },
    });

    expect(JSON.stringify(result)).toContain("directive:approved-operation:");
  });

  it("parses the served tool selection from env and defaults to cron", () => {
    expect(resolveOpenClawToolsMcpToolSelection({})).toEqual(["cron"]);
    expect(
      resolveOpenClawToolsMcpToolSelection({
        [OPENCLAW_TOOLS_MCP_TOOLS_ENV]: " crestodian , cron ",
      }),
    ).toEqual(["crestodian", "cron"]);
    expect(() =>
      resolveOpenClawToolsMcpToolSelection({ [OPENCLAW_TOOLS_MCP_TOOLS_ENV]: "exec" }),
    ).toThrow(OPENCLAW_TOOLS_MCP_TOOLS_ENV);
  });

  it("parses the crestodian surface from env and defaults to cli", () => {
    expect(resolveOpenClawToolsMcpCrestodianSurface({})).toBe("cli");
    expect(
      resolveOpenClawToolsMcpCrestodianSurface({
        [OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV]: "gateway",
      }),
    ).toBe("gateway");
    expect(() =>
      resolveOpenClawToolsMcpCrestodianSurface({
        [OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV]: "remote",
      }),
    ).toThrow(OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV);
  });

  it("builds a crestodian-only stdio server config under the openclaw name", () => {
    const config = buildCrestodianToolsMcpServerConfig({ surface: "gateway" });

    expect(Object.keys(config.mcpServers)).toEqual(["openclaw"]);
    const server = config.mcpServers.openclaw as {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
    expect(server.command).toBe(process.execPath);
    expect(server.args?.at(-1)).toMatch(/openclaw-tools-serve\.(js|ts)$/);
    expect(server.env).toEqual({
      [OPENCLAW_TOOLS_MCP_TOOLS_ENV]: "crestodian",
      [OPENCLAW_TOOLS_MCP_CRESTODIAN_SURFACE_ENV]: "gateway",
    });
  });
});
