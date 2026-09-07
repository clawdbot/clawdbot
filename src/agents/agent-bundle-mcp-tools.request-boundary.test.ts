/** Tests configured MCP tools survive policy/splitting to the outbound request boundary. */
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { splitSdkTools } from "./embedded-agent-runner/tool-split.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";

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
    peekCatalog: () => ({
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
    conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: params.cfg }),
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
    const cfg: OpenClawConfig = { tools: { profile: "coding" } };
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: runtime.tools,
      config: cfg,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({ config: cfg }),
      warn: () => {},
    });
    const { customTools } = splitSdkTools({ tools: filtered, sandboxEnabled: false });

    expect(customTools.map((tool) => tool.name)).toEqual([
      "userMcp__alpha_tool",
      "userMcp__mu_tool",
      "userMcp__zeta_tool",
    ]);
  });
  it("exposes MCP resource and prompt utility tools when advertised", async () => {
    const base = makeConfiguredRuntime({ toolNames: [], serverName: "knowledge" });
    const publicResults = {
      prompts_get: {
        description: "Brief the user",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Summarize MCP",
              annotations: { audience: ["assistant"] },
              _meta: { promptBlock: "preserved" },
            },
          },
        ],
      },
      prompts_list: {
        prompts: [{ name: "brief", _meta: { promptEntry: "preserved" } }],
        nextCursor: "prompt-page-two",
      },
      resources_list: {
        resources: [
          {
            uri: "memo://one",
            name: "memo",
            annotations: { priority: 0.5 },
            _meta: { resourceEntry: "preserved" },
          },
        ],
        nextCursor: "resource-page-two",
      },
      resources_read: {
        contents: [{ uri: "memo://one", text: "memo text", _meta: { content: "preserved" } }],
      },
    };
    const privateResults = Object.fromEntries(
      Object.entries(publicResults).map(([operation, value]) => [
        operation,
        { ...value, _meta: { privateState: `${operation}-must-not-leak` } },
      ]),
    );
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: true },
              prompts: { listChanged: true },
            },
          },
          tools: [],
        }),
        listResources: async () => privateResults.resources_list,
        readResource: async () => privateResults.resources_read,
        listPrompts: async () => privateResults.prompts_list,
        getPrompt: async () => GetPromptResultSchema.parse(privateResults.prompts_get),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    for (const [operation, args] of [
      ["prompts_get", { name: "brief" }],
      ["prompts_list", {}],
      ["resources_list", {}],
      ["resources_read", { uri: "memo://one" }],
    ] as const) {
      const tool = expectDefined(
        runtime.tools.find((candidate) => candidate.name === `knowledge__${operation}`),
        `${operation} utility tool`,
      );
      const result = await tool.execute(`call-${operation}`, args, undefined, undefined);
      if (operation === "prompts_get") {
        expect(result.content).toEqual([
          { type: "text", text: "Brief the user" },
          { type: "text", text: "user:" },
          { type: "text", text: "Summarize MCP" },
        ]);
      } else {
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(publicResults[operation], null, 2) },
        ]);
      }
      expect(consumeMcpCodeModeGuestResult(result)).toEqual(publicResults[operation]);
      expect(result.details).toMatchObject({
        mcpServer: "knowledge",
        mcpOperation: operation,
        untrustedMcpOutput: true,
      });
      expect(tool.resultContentSource).toBe("network");
      expect(expectDefined(privateResults[operation], `${operation} private source`)._meta).toEqual(
        {
          privateState: `${operation}-must-not-leak`,
        },
      );
    }

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });

  it("presents prompt images with their roles while preserving the raw guest template", async () => {
    const image = {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      mimeType: "image/png",
    } as const;
    const prompt = GetPromptResultSchema.parse({
      description: "Describe the supplied diagram",
      messages: [
        { role: "user", content: { type: "text", text: "Explain this image." } },
        { role: "user", content: image },
        { role: "assistant", content: { type: "text", text: "An example answer." } },
      ],
    });
    const base = makeConfiguredRuntime({ toolNames: [], serverName: "diagrams" });
    const catalog = await base.getCatalog();
    catalog.servers.diagrams!.prompts = {};
    const materialized = await materializeBundleMcpToolsForRun({
      runtime: { ...base, getCatalog: async () => catalog, getPrompt: async () => prompt },
    });
    const tool = expectDefined(
      materialized.tools.find((candidate) => candidate.name === "diagrams__prompts_get"),
      "prompt utility",
    );
    const result = await tool.execute("prompt-image", { name: "diagram" }, undefined, undefined);

    expect(result.content).toEqual([
      { type: "text", text: "Describe the supplied diagram" },
      { type: "text", text: "user:" },
      { type: "text", text: "Explain this image." },
      { type: "text", text: "user:" },
      image,
      { type: "text", text: "assistant:" },
      { type: "text", text: "An example answer." },
    ]);
    const originalPrompt = structuredClone(prompt);
    prompt.description = "A later server-side edit";
    expect(consumeMcpCodeModeGuestResult(result)).toEqual(originalPrompt);
  });
});
