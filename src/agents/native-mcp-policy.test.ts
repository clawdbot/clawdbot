import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-materialize.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { prepareNativeMcpPolicy } from "./native-mcp-policy.js";

function catalog(): McpToolCatalog {
  const tools = [
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "read_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "read",
    },
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "delete_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "delete",
      excludedFromOpenClawCatalog: true as const,
    },
    {
      serverName: "docs?",
      safeServerName: "docs-2",
      toolName: "read_docs",
      inputSchema: Type.Object({}),
      fallbackDescription: "other read",
      deniedBySession: true as const,
    },
    {
      serverName: "docs!",
      safeServerName: "docs",
      toolName: "app_only",
      inputSchema: Type.Object({}),
      fallbackDescription: "app only",
      uiVisibility: ["app" as const],
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
  it("keeps default callable tools while denying hidden native inventory", async () => {
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(catalog()),
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({}),
      warn: () => {},
    });

    expect(prepared.servers["docs!"]).toMatchObject({
      allowedTools: ["read_docs"],
      deniedTools: ["app_only", "delete_docs"],
    });
    expect(prepared.servers["docs?"]).toMatchObject({
      allowedTools: [],
      deniedTools: ["read_docs"],
    });
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
      deniedTools: ["app_only", "delete_docs"],
    });
    expect(prepared.servers["docs?"]).toMatchObject({
      safeServerName: "docs-2",
      allowedTools: [],
      deniedTools: ["read_docs"],
    });
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

  it("preserves callable identities when an App-only raw name collides", async () => {
    const serverNames = [
      "docs.production.endpoint.with.a.long.shared.prefix.alpha",
      "docs.production.endpoint.with.a.long.shared.prefix.beta",
    ];
    const safeNames = assignSafeServerNames(serverNames);
    const rawTools = [
      "read.docs.with.a.long.shared.prefix.alpha",
      "read:docs:with:a:long:shared:prefix:alpha",
    ];
    const policyTools = [
      ...rawTools.map((toolName, index) => ({
        serverName: serverNames[1]!,
        safeServerName: safeNames.get(serverNames[1]!)!,
        toolName,
        inputSchema: Type.Object({}),
        fallbackDescription: toolName,
        ...(index === 1 ? { uiVisibility: ["app" as const] } : {}),
      })),
      {
        serverName: serverNames[1]!,
        safeServerName: safeNames.get(serverNames[1]!)!,
        toolName: "read_safe",
        inputSchema: Type.Object({}),
        fallbackDescription: "read safe",
      },
    ];
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
    const callableTools = buildBundleMcpToolsFromCatalog({ catalog: collisionCatalog });
    const visibleCollision = callableTools.find(
      (tool) => getPluginToolMeta(tool)?.mcp?.toolName === rawTools[0],
    );
    expect(visibleCollision).toBeDefined();
    const config = {
      tools: {
        allow: [`${safeNames.get(serverNames[1]!)}__*`],
        deny: [visibleCollision!.name],
      },
    };
    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(collisionCatalog),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers[serverNames[1]!]?.allowedTools).toEqual(["read_safe"]);
    expect(prepared.servers[serverNames[1]!]?.deniedTools).toEqual(rawTools);
    expect(safeNames.get(serverNames[0]!)).not.toBe(safeNames.get(serverNames[1]!));
  });

  it("reserves callable identities before every non-callable policy row", async () => {
    const callableTool = {
      serverName: "docs",
      safeServerName: "docs",
      toolName: "read:value",
      inputSchema: Type.Object({}),
      fallbackDescription: "callable",
    };
    const readTool = {
      ...callableTool,
      toolName: "read_safe",
      fallbackDescription: "read safe",
    };
    const hiddenTools = ["read value", "read.value", "read.value", "read/value"].map(
      (toolName) => ({
        serverName: "docs",
        safeServerName: "docs",
        toolName,
        inputSchema: Type.Object({}),
        fallbackDescription: "hidden policy inventory",
        excludedFromOpenClawCatalog: true as const,
      }),
    );
    const collisionCatalog: McpToolCatalog = {
      version: 1,
      generatedAt: 1,
      servers: {
        docs: { serverName: "docs", safeServerName: "docs", launchSummary: "test", toolCount: 2 },
      },
      tools: [callableTool, readTool],
      policyTools: [...hiddenTools, callableTool, readTool],
    };
    const callableProjection = buildBundleMcpToolsFromCatalog({ catalog: collisionCatalog });
    const policyName = callableProjection.find(
      (tool) => getPluginToolMeta(tool)?.mcp?.toolName === callableTool.toolName,
    )?.name;
    expect(policyName).toBeDefined();
    if (!policyName) {
      throw new Error("expected callable policy name");
    }
    const config = { tools: { allow: ["docs__*"], deny: [policyName] } };

    const prepared = await prepareNativeMcpPolicy({
      runtime: runtime(collisionCatalog),
      config,
      workspaceDir: "/tmp/openclaw-native-mcp-policy",
      capabilityProfile: resolveConversationCapabilityProfile({ config }),
      warn: () => {},
    });

    expect(prepared.servers.docs?.allowedTools).toEqual(["read_safe"]);
    expect(prepared.servers.docs?.deniedTools).toEqual([
      "read value",
      "read.value",
      "read/value",
      "read:value",
    ]);
  });
});
