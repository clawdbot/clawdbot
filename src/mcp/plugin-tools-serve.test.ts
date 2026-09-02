// Plugin MCP serve tests cover serving plugin tools over MCP.
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  consumeAdjustedParamsForToolCall,
  type HookContext,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import {
  consumeTrackedToolExecutionStarted,
  resetAdjustedParamsByToolCallIdForTests,
} from "../agents/agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

type ManifestContractSnapshotMock = {
  plugins: Array<Partial<Pick<PluginManifestRecord, "contracts" | "providers" | "toolMetadata">>>;
};

const callGatewayTool = vi.hoisted(() => vi.fn());
const connectToolsMcpServerToStdioMock = vi.hoisted(() => vi.fn());
const createToolsMcpServerMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })));
const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({ plugins: { enabled: true } })));
const ensureStandalonePluginToolRegistryLoadedMock = vi.hoisted(() => vi.fn());
const loadManifestContractSnapshotMock = vi.hoisted(() =>
  vi.fn<() => ManifestContractSnapshotMock>(() => ({ plugins: [] })),
);
const resolvePluginToolsMock = vi.hoisted(() => vi.fn<() => AnyAgentTool[]>(() => []));
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../agents/tools/gateway.js", () => ({
  callGatewayTool,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    ensureStandalonePluginToolRegistryLoaded: ensureStandalonePluginToolRegistryLoadedMock,
    resolvePluginTools: resolvePluginToolsMock,
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestContractSnapshot: loadManifestContractSnapshotMock,
}));

vi.mock("./tools-stdio-server.js", () => ({
  connectToolsMcpServerToStdio: connectToolsMcpServerToStdioMock,
  createToolsMcpServer: createToolsMcpServerMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayTool.mockReset();
  connectToolsMcpServerToStdioMock.mockReset();
  createToolsMcpServerMock.mockClear();
  ensureStandalonePluginToolRegistryLoadedMock.mockReset();
  loadManifestContractSnapshotMock.mockReset();
  loadManifestContractSnapshotMock.mockReturnValue({ plugins: [] });
  getRuntimeConfigMock.mockClear();
  resolvePluginToolsMock.mockReset();
  resolvePluginToolsMock.mockReturnValue([]);
  routeLogsToStderrMock.mockReset();
  resetAdjustedParamsByToolCallIdForTests();
  resetGlobalHookRunner();
});

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function requireToolPolicyParams(mock: ReturnType<typeof vi.fn>) {
  const params = requireFirstMockCall(mock.mock.calls, "plugin tool policy")[0] as
    | { toolAllowlist?: string[]; toolDenylist?: string[] }
    | undefined;
  if (!params) {
    throw new Error("expected plugin tool policy params");
  }
  return params;
}

describe("plugin tools MCP server", () => {
  it.each([
    { agentSessionKey: "agent:research:acp:session-1", agentId: undefined, owner: "research" },
    { agentSessionKey: "global", agentId: "work", owner: "work" },
  ])(
    "passes $agentSessionKey owner into plugin tool factories",
    async ({ agentSessionKey, agentId, owner }) => {
      const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");
      const runtimeRegistry = createMockPluginRegistry([]);
      ensureStandalonePluginToolRegistryLoadedMock.mockReturnValue(runtimeRegistry);
      const config = { plugins: { enabled: true } } as never;

      resolvePluginToolsForMcp({
        config,
        agentSessionKey,
        agentId,
      });

      const expectedContext = {
        config,
        agentId: owner,
        sessionKey: agentSessionKey,
      };
      expect(ensureStandalonePluginToolRegistryLoadedMock).toHaveBeenCalledWith({
        context: expectedContext,
      });
      expect(resolvePluginToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({ context: expectedContext, runtimeRegistry }),
      );
    },
  );

  it("rejects a non-agent session identity from the managed bridge", async () => {
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    expect(() =>
      resolvePluginToolsForMcp({
        config: { plugins: { enabled: true } } as never,
        agentSessionKey: "research-session",
      }),
    ).toThrow("must be a canonical agent session key");
  });

  it("intersects agentless manifest profile grants with the global allowlist", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [
        {
          contracts: { tools: ["profile_plugin_tool", "benign_plugin_tool"] },
          toolMetadata: {
            profile_plugin_tool: { profiles: ["coding"] },
            benign_plugin_tool: { profiles: ["coding"] },
          },
        },
      ],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "profile_plugin_tool",
        description: "Profile tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      tools: { profile: "coding", allow: ["benign_plugin_tool"] },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({ config });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolAllowlist).toContain("profile_plugin_tool");
    expect(loadPolicy.toolAllowlist).toContain("benign_plugin_tool");
    expect(tools.map((tool) => tool.name)).toEqual(["benign_plugin_tool"]);
  });

  it("applies global provider policy to agentless tools with exact model identity", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [{ providers: ["openai"] }],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "provider_denied_tool",
        description: "Provider-denied tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      models: { providers: { openai: {} } },
      tools: { byProvider: { "openai/gpt-5.6": { deny: ["provider_denied_tool"] } } },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({ config, modelRef: "openai/gpt-5.6" });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolDenylist).toContain("provider_denied_tool");
    expect(tools.map((tool) => tool.name)).toEqual(["benign_plugin_tool"]);
  });

  it("denies list and call for a migrated non-OpenAI provider identity", async () => {
    const deniedExecute = vi.fn().mockResolvedValue({ content: "unexpected" });
    const benignExecute = vi.fn().mockResolvedValue({ content: "allowed" });
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [{ providers: ["azure_foundry"] }],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "provider_denied_tool",
        description: "Provider-denied tool",
        parameters: { type: "object", properties: {} },
        execute: deniedExecute,
      },
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: benignExecute,
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      models: { providers: { azure_foundry: {} } },
      tools: {
        byProvider: {
          "azure_foundry/legacy-model": { deny: ["provider_denied_tool"] },
        },
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      modelRef: "azure_foundry/legacy-model",
    });
    const handlers = createPluginToolsMcpHandlers(tools);

    await expect(handlers.listTools()).resolves.toMatchObject({
      tools: [{ name: "benign_plugin_tool" }],
    });
    await expect(handlers.callTool({ name: "provider_denied_tool" })).resolves.toMatchObject({
      isError: true,
    });
    expect(deniedExecute).not.toHaveBeenCalled();
    await expect(handlers.callTool({ name: "benign_plugin_tool" })).resolves.toMatchObject({
      content: [{ type: "text", text: "allowed" }],
    });
    expect(benignExecute).toHaveBeenCalledOnce();
  });

  it("routes logs to stderr before resolving tools for stdio", async () => {
    const { servePluginToolsMcp } = await import("./plugin-tools-serve.js");
    const runtimeRegistry = createMockPluginRegistry([]);
    ensureStandalonePluginToolRegistryLoadedMock.mockReturnValue(runtimeRegistry);
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "memory_recall",
        label: "Recall memory",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ]);

    await servePluginToolsMcp();

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(ensureStandalonePluginToolRegistryLoadedMock).toHaveBeenCalledWith({
      context: { config: { plugins: { enabled: true } } },
    });
    expect(resolvePluginToolsMock).toHaveBeenCalledTimes(1);
    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeRegistry }),
    );
    expect(ensureStandalonePluginToolRegistryLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(routeLogsToStderrMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginToolsMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(connectToolsMcpServerToStdioMock).toHaveBeenCalledOnce();
  });

  it("threads global and managed-agent plugin tool policy into plugin resolution", async () => {
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "dangerous_plugin_tool",
        description: "Denied tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        name: "benign_plugin_tool",
        description: "Allowed tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      tools: {
        allow: ["dangerous_plugin_tool", "benign_plugin_tool"],
        deny: ["memory_forget"],
      },
      agents: {
        list: [
          {
            id: "research",
            tools: {
              allow: ["benign_plugin_tool"],
              deny: ["dangerous_plugin_tool"],
            },
          },
        ],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      agentSessionKey: "agent:research:acp:session-1",
    });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolAllowlist).toEqual(["dangerous_plugin_tool", "benign_plugin_tool"]);
    expect(loadPolicy.toolDenylist).toEqual(["memory_forget", "dangerous_plugin_tool"]);
    const resolvePolicy = requireToolPolicyParams(resolvePluginToolsMock);
    expect(resolvePolicy.toolAllowlist).toEqual(["dangerous_plugin_tool", "benign_plugin_tool"]);
    expect(resolvePolicy.toolDenylist).toEqual(["memory_forget", "dangerous_plugin_tool"]);
    expect(tools.map((tool) => tool.name)).toEqual(["benign_plugin_tool"]);
  });

  it("applies provider policy and manifest profile grants for the managed ACP model", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [
        {
          contracts: { tools: ["profile_plugin_tool"] },
          toolMetadata: { profile_plugin_tool: { profiles: ["coding"] } },
        },
      ],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "profile_plugin_tool",
        description: "Profile tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        name: "provider_denied_tool",
        description: "Provider-denied tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      tools: { profile: "coding" },
      agents: {
        list: [
          {
            id: "research",
            tools: { byProvider: { "openai/gpt-5.6": { deny: ["provider_denied_tool"] } } },
          },
        ],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      agentSessionKey: "agent:research:acp:session-1",
      modelRef: "openai/gpt-5.6",
    });

    expect(loadManifestContractSnapshotMock).toHaveBeenCalledWith({ config });
    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolAllowlist).toContain("profile_plugin_tool");
    expect(loadPolicy.toolDenylist).toContain("provider_denied_tool");
    expect(tools.map((tool) => tool.name)).toEqual(["profile_plugin_tool"]);
  });

  it.each([undefined, "gpt-5.6", "openai/   ", "openai/*"])(
    "fails closed for provider policy without valid recognized ACP identity (%s)",
    async (modelRef) => {
      resolvePluginToolsMock.mockReturnValue([
        {
          name: "provider_denied_tool",
          description: "Provider-denied tool",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
        {
          name: "benign_plugin_tool",
          description: "Benign tool",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ] as unknown as AnyAgentTool[]);
      const config = {
        plugins: { enabled: true },
        tools: { allow: ["provider_denied_tool", "benign_plugin_tool"] },
        agents: {
          list: [
            {
              id: "research",
              tools: { byProvider: { openai: { deny: ["provider_denied_tool"] } } },
            },
          ],
        },
      } as never;
      const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

      const tools = resolvePluginToolsForMcp({
        config,
        agentSessionKey: "agent:research:acp:session-1",
        ...(modelRef ? { modelRef } : {}),
      });

      const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
      expect(loadPolicy.toolDenylist).toContain("*");
      expect(tools).toEqual([]);
    },
  );

  it("stops fail-closed calls before plugin execution when ACP identity is unverifiable", async () => {
    const execute = vi.fn().mockResolvedValue({ content: "unexpected" });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "provider_controlled_tool",
        description: "Provider-controlled tool",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      tools: { byProvider: { openai: { allow: ["provider_controlled_tool"] } } },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({ config });
    const handlers = createPluginToolsMcpHandlers(tools);

    await expect(handlers.listTools()).resolves.toEqual({ tools: [] });
    await expect(handlers.callTool({ name: "provider_controlled_tool" })).resolves.toMatchObject({
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies provider-wide policy without applying unrelated provider policy", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [{ providers: ["openai"] }],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
      {
        name: "provider_denied_tool",
        description: "Provider-denied tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      models: { providers: { openai: {} } },
      agents: {
        list: [
          {
            id: "research",
            tools: {
              byProvider: {
                anthropic: { deny: ["*"] },
                openai: { deny: ["provider_denied_tool"] },
              },
            },
          },
        ],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      agentSessionKey: "agent:research:acp:session-1",
      modelRef: "openai",
    });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolDenylist).toEqual(["provider_denied_tool"]);
    expect(tools.map((tool) => tool.name)).toEqual(["benign_plugin_tool"]);
  });

  it("fails closed when a known ACP provider has unresolved model-specific policy", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [{ providers: ["openai"] }],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      models: { providers: { openai: {} } },
      agents: {
        list: [{ id: "research", tools: { byProvider: { "openai/gpt-5.6": { deny: ["*"] } } } }],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      agentSessionKey: "agent:research:acp:session-1",
      modelRef: "openai",
    });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolDenylist).toContain("*");
    expect(tools).toEqual([]);
  });

  it("fails closed for an unrecognized qualified ACP provider", async () => {
    loadManifestContractSnapshotMock.mockReturnValue({
      plugins: [{ providers: ["openai"] }],
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "benign_plugin_tool",
        description: "Benign tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ] as unknown as AnyAgentTool[]);
    const config = {
      plugins: { enabled: true },
      models: { providers: { openai: {} } },
      agents: {
        list: [{ id: "research", tools: { byProvider: { openai: { deny: ["*"] } } } }],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({
      config,
      agentSessionKey: "agent:research:acp:session-1",
      modelRef: "opneai/gpt-5.6",
    });

    const loadPolicy = requireToolPolicyParams(ensureStandalonePluginToolRegistryLoadedMock);
    expect(loadPolicy.toolDenylist).toContain("*");
    expect(tools).toEqual([]);
  });

  it("applies stored ACP session caps after configured agent policy", async () => {
    const dangerousExecute = vi.fn().mockResolvedValue({ content: "unexpected" });
    const benignExecute = vi.fn().mockResolvedValue({ content: "allowed" });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "dangerous_plugin_tool",
        description: "Denied tool",
        parameters: { type: "object", properties: {} },
        execute: dangerousExecute,
      },
      {
        name: "benign_plugin_tool",
        description: "Allowed tool",
        parameters: { type: "object", properties: {} },
        execute: benignExecute,
      },
    ] as unknown as AnyAgentTool[]);
    const stateRoot = tempDirs.make("openclaw-plugin-tools-mcp-policy-");
    const storeTemplate = path.join(stateRoot, "agents", "{agentId}", "sessions", "sessions.json");
    const agentSessionKey = "agent:research:acp:session-1";
    await replaceSessionEntry(
      {
        sessionKey: agentSessionKey,
        storePath: storeTemplate.replace("{agentId}", "research"),
      },
      {
        sessionId: "session-1",
        updatedAt: Date.now(),
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["benign_plugin_tool"],
        inheritedToolDeny: ["dangerous_plugin_tool"],
      } as SessionEntry,
    );
    const config = {
      session: { store: storeTemplate },
      plugins: { enabled: true },
      tools: { allow: ["dangerous_plugin_tool", "benign_plugin_tool"] },
      agents: {
        list: [
          {
            id: "research",
            tools: { allow: ["dangerous_plugin_tool", "benign_plugin_tool"] },
          },
        ],
      },
    } as never;
    const { resolvePluginToolsForMcp } = await import("./plugin-tools-serve.js");

    const tools = resolvePluginToolsForMcp({ config, agentSessionKey });

    expect(tools.map((tool) => tool.name)).toEqual(["benign_plugin_tool"]);
    const handlers = createPluginToolsMcpHandlers(tools);
    await expect(handlers.listTools()).resolves.toMatchObject({
      tools: [{ name: "benign_plugin_tool" }],
    });
    await expect(handlers.callTool({ name: "dangerous_plugin_tool" })).resolves.toMatchObject({
      isError: true,
    });
    expect(dangerousExecute).not.toHaveBeenCalled();
    await expect(handlers.callTool({ name: "benign_plugin_tool" })).resolves.toMatchObject({
      content: [{ type: "text", text: "allowed" }],
    });
    expect(benignExecute).toHaveBeenCalledOnce();
  });

  it("lists registered plugin tools and serializes non-array tool content", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const listed = await handlers.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("memory_recall");
    expect(listed.tools[0]?.description).toBe("Recall stored memory");
    const inputSchema = listed.tools[0]?.inputSchema as
      | { type?: unknown; required?: unknown }
      | undefined;
    expect(inputSchema?.type).toBe("object");
    expect(inputSchema?.required).toEqual(["query"]);

    const result = await handlers.callTool({
      name: "memory_recall",
      arguments: { query: "remember this" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const executeCall = requireFirstMockCall(execute.mock.calls, "plugin tool execute");
    const requestId = executeCall[0];
    expect(typeof requestId).toBe("string");
    expect(requestId).toMatch(
      /^mcp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(executeCall[1]).toEqual({ query: "remember this" });
    expect(executeCall[2]).toBeUndefined();
    expect(executeCall[3]).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Stored." }]);
  });

  it("uses unique ids and releases execution tracking after repeated direct MCP calls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const executeSuccess = vi.fn().mockResolvedValue({ content: "Stored." });
    const executeFailure = vi.fn().mockRejectedValue(new Error("unavailable"));
    const handlers = createPluginToolsMcpHandlers([
      {
        name: "memory_recall",
        description: "Recall stored memory",
        parameters: { type: "object", properties: {} },
        execute: executeSuccess,
      } as unknown as AnyAgentTool,
      {
        name: "memory_forget",
        description: "Forget stored memory",
        parameters: { type: "object", properties: {} },
        execute: executeFailure,
      } as unknown as AnyAgentTool,
    ]);

    for (let index = 0; index < 32; index += 1) {
      await handlers.callTool({ name: "memory_recall", arguments: { index } });
      await handlers.callTool({ name: "memory_forget", arguments: { index } });
    }

    expect(executeSuccess).toHaveBeenCalledTimes(32);
    expect(executeFailure).toHaveBeenCalledTimes(32);
    const toolCallIds = [...executeSuccess.mock.calls, ...executeFailure.mock.calls].map(
      ([toolCallId]) => String(toolCallId),
    );
    expect(new Set(toolCallIds).size).toBe(toolCallIds.length);
    for (const toolCallId of toolCallIds) {
      expect(consumeTrackedToolExecutionStarted(toolCallId)).toBeUndefined();
      expect(consumeAdjustedParamsForToolCall(toolCallId)).toBeUndefined();
    }
  });

  it("serializes source-shaped image tool content with pinned MCP image blocks", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "browser screenshot" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ],
    });
    const tool = {
      name: "browser_screenshot",
      description: "Capture a browser screenshot",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "browser_screenshot",
      arguments: {},
    });

    expect(result.content).toEqual([
      { type: "text", text: "browser screenshot" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });

  it("delivers source-shaped images through a real MCP client", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "browser screenshot" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ],
    });
    const tool = {
      name: "browser_screenshot",
      description: "Capture a browser screenshot",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;
    const { createToolsMcpServer } =
      await vi.importActual<typeof import("./tools-stdio-server.js")>("./tools-stdio-server.js");
    const server = createToolsMcpServer({ name: "plugin-tools-image-test", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "plugin-tools-image-test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "browser_screenshot", arguments: {} });
      expect(result.content).toEqual([
        { type: "text", text: "browser screenshot" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serializes plugin tool results that do not use the MCP content envelope", async () => {
    const execute = vi.fn().mockResolvedValue({
      provider: "kitchen-sink-search",
      results: [{ title: "Kitchen Sink image fixture" }],
    });
    const tool = {
      name: "kitchen_sink_search",
      description: "Search Kitchen Sink fixture content",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "kitchen_sink_search",
      arguments: { query: "kitchen sink" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          provider: "kitchen-sink-search",
          results: [{ title: "Kitchen Sink image fixture" }],
        }),
      },
    ]);
  });

  it.each([
    ["failed status", { status: "failed", error: "backend unavailable" }, true],
    ["blocked status", { status: "blocked" }, true],
    ["timeout flag", { timedOut: true }, true],
    ["explicit failure", { ok: false }, true],
    ["successful status", { status: "success" }, undefined],
    ["completed nonzero shell exit", { status: "completed", exitCode: 23 }, undefined],
  ])(
    "projects a resolved %s through the canonical error contract",
    async (_label, details, isError) => {
      const content = [{ type: "text", text: "original tool result" }];
      const execute = vi.fn().mockResolvedValue({ content, details });
      const handlers = createPluginToolsMcpHandlers([
        {
          name: "result_probe",
          description: "Return a structured result",
          parameters: { type: "object", properties: {} },
          execute,
        } as unknown as AnyAgentTool,
      ]);

      const result = await handlers.callTool({ name: "result_probe", arguments: {} });

      expect(result.content).toEqual(content);
      expect(result.isError).toBe(isError);
    },
  );

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      name: "memory_forget",
      description: "Forget memory",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([failingTool]);
    const unknown = await handlers.callTool({
      name: "missing_tool",
      arguments: {},
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toEqual([{ type: "text", text: "Unknown tool: missing_tool" }]);

    const failed = await handlers.callTool({
      name: "memory_forget",
      arguments: {},
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: "text", text: "Tool error: boom" }]);
  });

  it("releases run-scoped adjusted arguments after a pre-wrapped direct MCP call", async () => {
    const runId = "run-direct-mcp";
    const execute = vi.fn().mockResolvedValue({ content: "Stored." });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ params: { text: "adjusted" } }),
        },
      ]),
    );
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "memory_store",
        description: "Store memory",
        parameters: { type: "object", properties: {} },
        execute,
      } as unknown as AnyAgentTool,
      { runId, sessionKey: "session-direct-mcp" },
    );

    const handlers = createPluginToolsMcpHandlers([tool]);
    await handlers.callTool({
      name: "memory_store",
      arguments: { text: "original" },
    });

    const executeCall = requireFirstMockCall(execute.mock.calls, "plugin tool execute");
    const toolCallId = String(executeCall[0]);
    expect(executeCall[1]).toEqual({ text: "adjusted" });
    expect(consumeAdjustedParamsForToolCall(toolCallId, runId)).toBeUndefined();
  });

  it("reports approval requirements without opening plugin approvals on the MCP bridge", async () => {
    let hookCalls = 0;
    const onResolution = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => {
            hookCalls += 1;
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
                onResolution,
              },
            };
          },
        },
      ]),
    );
    const tool = {
      name: "memory_store",
      description: "Store memory",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "memory_store",
      arguments: { text: "remember this" },
    });
    expect(hookCalls).toBe(1);
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool error: Approval required" }]);
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
  });

  it("switches pre-wrapped plugin tools to approval report mode on the MCP bridge", async () => {
    const onResolution = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const originalContext = {
      agentId: "agent-with-plugins",
      sessionKey: "session-with-plugins",
    } satisfies HookContext;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async (_event, ctx) => {
            const hookContext = ctx as HookContext | undefined;
            if (hookContext?.sessionKey !== originalContext.sessionKey) {
              return undefined;
            }
            return {
              requireApproval: {
                pluginId: "test-plugin",
                title: "Approval required",
                description: "Approval required",
                onResolution,
              },
            };
          },
        },
      ]),
    );
    callGatewayTool.mockRejectedValue(new Error("gateway unavailable"));
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "memory_store",
        description: "Store memory",
        parameters: { type: "object", properties: {} },
        execute,
      } as unknown as AnyAgentTool,
      originalContext,
    );

    const handlers = createPluginToolsMcpHandlers([tool]);
    const result = await handlers.callTool({
      name: "memory_store",
      arguments: { text: "remember this" },
    });
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool error: Approval required" }]);
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);

    await expect(tool.execute("agent-tool-call", { text: "remember this" })).rejects.toThrow(
      "Plugin approval required (gateway unavailable)",
    );
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenCalledTimes(2);
    expect(onResolution).toHaveBeenLastCalledWith(PluginApprovalResolutions.CANCELLED);
    expect(execute).not.toHaveBeenCalled();
  });
});
