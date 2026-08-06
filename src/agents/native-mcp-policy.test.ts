import { describe, expect, it } from "vitest";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { prepareNativeMcpPolicy, requiresPreparedNativeMcpPolicy } from "./native-mcp-policy.js";

function catalog(): McpToolCatalog {
  const tools = [
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "read_docs",
      inputSchema: { type: "object" } as never,
      fallbackDescription: "read",
    },
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "delete_docs",
      inputSchema: { type: "object" } as never,
      fallbackDescription: "delete",
      excludedByConfiguredFilter: true as const,
    },
    {
      serverName: "docs?",
      safeServerName: "docs-2",
      toolName: "read_docs",
      inputSchema: { type: "object" } as never,
      fallbackDescription: "other read",
      deniedBySession: true as const,
    },
  ];
  return {
    version: 1,
    generatedAt: 1,
    servers: {
      "docs!": { serverName: "docs!", safeServerName: "docs", launchSummary: "test", toolCount: 1 },
      "docs?": {
        serverName: "docs?",
        safeServerName: "docs-2",
        launchSummary: "test",
        toolCount: 0,
      },
    },
    tools: [tools[0]!],
    sessionDeniedTools: [tools[2]!],
    policyTools: tools,
  };
}

function runtime(value: McpToolCatalog): SessionMcpRuntime {
  return {
    sessionId: "session-1",
    workspaceDir: "/tmp/openclaw-native-mcp-policy",
    configFingerprint: "test",
    createdAt: 1,
    lastUsedAt: 1,
    getCatalog: async () => value,
    peekCatalog: () => value,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
  };
}

describe("prepareNativeMcpPolicy", () => {
  it("requires catalog preparation for configured MCP filters without a global tool policy", () => {
    expect(
      requiresPreparedNativeMcpPolicy({
        capabilityProfile: resolveConversationCapabilityProfile({}),
        mcpServers: { docs: { toolFilter: { include: ["read_*"] } } },
      }),
    ).toBe(true);
  });

  it("preserves raw/safe identities and intersects effective, configured, and session policy", async () => {
    const config = { tools: { allow: ["docs__*"], deny: ["docs__delete_*"] } };
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(catalog()),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers["docs!"]).toMatchObject({
      safeServerName: "docs",
      allowedTools: ["read_docs"],
      deniedTools: ["delete_docs"],
    });
    expect(prepared.servers["docs?"]).toMatchObject({
      safeServerName: "docs-2",
      allowedTools: [],
      deniedTools: ["read_docs"],
    });
    expect(prepared.servers["docs!"]?.tools).toEqual([
      {
        rawName: "delete_docs",
        safeName: "docs__delete_docs",
        allowed: false,
        excludedBy: ["configured-filter", "effective-policy"],
      },
      { rawName: "read_docs", safeName: "docs__read_docs", allowed: true, excludedBy: [] },
    ]);
    expect(prepared.servers["docs?"]?.tools[0]?.excludedBy).toEqual([
      "session-override",
      "effective-policy",
    ]);
  });

  it("treats an empty runtime allowlist as an exact deny-all cap", async () => {
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(catalog()),
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({}),
      runtimeToolsAllow: [],
      warn: () => {},
    });
    expect(Object.values(prepared.servers).flatMap((server) => server.allowedTools)).toEqual([]);
  });

  it("uses catalog-assigned identities for truncated server and colliding tool names", async () => {
    const serverNames = [
      "docs.production.endpoint.with.a.long.shared.prefix.alpha",
      "docs.production.endpoint.with.a.long.shared.prefix.beta",
    ];
    const safeNames = assignSafeServerNames(serverNames);
    const rawTools = [
      "read.docs.with.a.long.shared.prefix.alpha",
      "read:docs:with:a:long:shared:prefix:alpha",
    ];
    const policyTools = rawTools.map((toolName) => ({
      serverName: serverNames[1]!,
      safeServerName: safeNames.get(serverNames[1]!)!,
      toolName,
      inputSchema: { type: "object" } as never,
      fallbackDescription: toolName,
    }));
    const collisionCatalog: McpToolCatalog = {
      version: 1,
      generatedAt: 1,
      servers: Object.fromEntries(
        serverNames.map((serverName) => [
          serverName,
          {
            serverName,
            safeServerName: safeNames.get(serverName)!,
            launchSummary: "test",
            toolCount: serverName === serverNames[1] ? policyTools.length : 0,
          },
        ]),
      ),
      tools: policyTools,
      policyTools,
    };
    const inventory = await prepareNativeMcpPolicy({
      runtime: runtime(collisionCatalog),
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({}),
      warn: () => {},
    });
    const target = inventory.servers[serverNames[1]!]?.tools.find((tool) =>
      tool.safeName.endsWith("-2"),
    );
    expect(target).toBeDefined();
    const config = { tools: { allow: [target!.safeName] } };
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(collisionCatalog),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers[serverNames[1]!]?.allowedTools).toEqual([target?.rawName]);
    expect(safeNames.get(serverNames[0]!)).not.toBe(safeNames.get(serverNames[1]!));
  });
});
