import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-materialize.js";
import type { McpCatalogTool, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";
import { applyFinalEffectiveToolPolicy } from "./pi-embedded-runner/effective-tool-policy.js";
import { splitSdkTools } from "./pi-embedded-runner/tool-split.js";

// Regression coverage for #76063. The reporter's evidence was a captured
// outbound provider request body that contained only built-in OpenClaw tools
// and no `server__*` MCP tool definitions, even though `cfg.mcp.servers`
// declared healthy stdio servers. The materialize/policy/split units each
// have their own focused tests, but ClawSweeper noted that the full request-
// boundary path was uncovered: configured (`cfg.mcp.servers.<name>`) tools
// must materialize, survive `applyFinalEffectiveToolPolicy`, and reach
// `splitSdkTools().customTools` (the value passed to the SDK as
// `customTools`, which is what the provider receives). This test asserts
// that boundary behavior with a fake session MCP runtime so it can run
// against current main without booting a real stdio child.

function makeConfiguredRuntime(
  params: {
    serverName?: string;
    toolNames?: string[];
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "userMcp";
  const toolNames = params.toolNames ?? ["list_inbox", "send_reply"];
  const tools: McpCatalogTool[] = toolNames.map((toolName) => ({
    serverName,
    safeServerName: serverName,
    toolName,
    description: `${serverName}.${toolName}`,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: `${serverName}.${toolName}`,
  }));
  return {
    sessionId: "session-request-boundary",
    workspaceDir: "/workspace",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools,
    }),
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-CONFIG" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

async function buildConfiguredMcpToolNamesAtRequestBoundary(params: {
  cfg: OpenClawConfig;
}): Promise<string[]> {
  const runtime = await createBundleMcpToolRuntime({
    workspaceDir: "/workspace",
    cfg: params.cfg,
    createRuntime: () => makeConfiguredRuntime(),
  });
  const filtered = applyFinalEffectiveToolPolicy({
    bundledTools: runtime.tools,
    config: params.cfg,
    warn: () => {},
  });
  const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });
  return customTools.map((tool) => tool.name);
}

describe("configured MCP tools reach the request boundary (#76063)", () => {
  it("includes server__* tools in customTools under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("includes server__* tools in customTools under the messaging profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "messaging" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual(["userMcp__list_inbox", "userMcp__send_reply"]);
  });

  it("removes configured server__* tools from customTools under the minimal profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "minimal" },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("respects an explicit tools.deny: ['bundle-mcp'] entry under the coding profile", async () => {
    const names = await buildConfiguredMcpToolNamesAtRequestBoundary({
      cfg: {
        tools: { profile: "coding", deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            userMcp: {
              command: "node",
              args: ["user-mcp.mjs"],
            },
          },
        },
      },
    });

    expect(names).toEqual([]);
  });

  it("preserves materialize ordering at the request boundary so prompt cache keys stay stable", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeConfiguredRuntime({
        toolNames: ["zeta_tool", "alpha_tool", "mu_tool"],
      }),
    });
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: runtime.tools,
      config: { tools: { profile: "coding" } },
      warn: () => {},
    });
    const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });

    expect(customTools.map((tool) => tool.name)).toEqual([
      "userMcp__alpha_tool",
      "userMcp__mu_tool",
      "userMcp__zeta_tool",
    ]);
  });
});
