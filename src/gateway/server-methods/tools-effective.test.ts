// Effective tools tests cover session-scoped tool inventory, MCP catalog state,
// caching behavior, delivery context, and policy filtering.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { setPluginToolMeta } from "../../plugins/tools.js";
import { testing, toolsEffectiveHandlers } from "./tools-effective.js";

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
  applyFinalEffectiveToolPolicy: vi.fn(
    (params: { bundledTools: unknown[] }) => params.bundledTools,
  ),
  buildBundleMcpToolsFromCatalog: vi.fn(() => [] as unknown[]),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  getRegisteredAgentHarness: vi.fn(),
  resolveRuntimeConfigCacheKey: vi.fn(() => "runtime:1:test"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
  listAgentIds: vi.fn(() => ["main"]),
  getRuntimeConfig: vi.fn(() => ({})),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    canonicalKey: "main:abc",
    entry: {
      sessionId: "session-1",
      updatedAt: 1,
      lastChannel: "telegram",
      lastAccountId: "acct-1",
      lastThreadId: "thread-2",
      lastTo: "channel-1",
      groupId: "group-4",
      groupChannel: "#ops",
      space: "workspace-5",
      chatType: "group",
      modelProvider: "openai",
      model: "gpt-4.1",
      spawnedBy: "agent:main:telegram:group:parent-group",
      spawnedWorkspaceDir: undefined as string | undefined,
    },
  })),
  peekSessionMcpRuntime: vi.fn<
    () => Pick<SessionMcpRuntime, "configFingerprint" | "peekCatalog" | "workspaceDir"> | undefined
  >(() => undefined),
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:1:test",
    serverNames: [] as string[],
  })),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveEffectiveToolInventory: vi.fn(),
  resolveReplyToMode: vi.fn(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
  resolveEffectiveToolInventoryRuntimeModelContext: vi.fn((_params?: unknown) => ({
    modelApi: "openai-responses",
    runtimeModel: {
      id: "gpt-4.1",
      name: "GPT 4.1",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  })),
  resolveEffectiveToolInventoryRuntimeModelContextAsync: vi.fn(async (params: unknown) =>
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext(params),
  ),
}));

vi.mock("./tools-effective.runtime.js", () => ({
  ...runtimeMocks,
  loadGatewaySessionEntryReadOnly: runtimeMocks.loadSessionEntry,
}));

const nodePluginToolSnapshotMocks = vi.hoisted(() => ({
  version: 1,
  getConnectedNodePluginToolsVersion: vi.fn(() => nodePluginToolSnapshotMocks.version),
}));

vi.mock("../node-plugin-tool-snapshot.js", () => nodePluginToolSnapshotMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type ToolsEffectivePayload = {
  agentId?: string;
  profile?: string;
  notices?: Array<{ id?: string; severity?: string; message?: string; servers?: string[] }>;
  groups?: Array<{
    id?: string;
    label?: string;
    source?: string;
    tools?: Array<{
      id?: string;
      label?: string;
      description?: string;
      rawDescription?: string;
      source?: string;
      pluginId?: string;
      mcpServer?: string;
      mcpToolName?: string;
      deniedBySession?: true;
    }>;
  }>;
};

function createInvokeParams(params: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        toolsEffectiveHandlers["tools.effective"],
        'toolsEffectiveHandlers["tools.effective"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => cfg } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

function resolveEffectiveToolInventoryArg(callIndex = 0): Record<string, unknown> | undefined {
  const calls = runtimeMocks.resolveEffectiveToolInventory.mock.calls as unknown as Array<
    [Record<string, unknown>]
  >;
  return calls[callIndex]?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function makeMcpTool(params: Record<string, unknown> = { type: "object", properties: {} }) {
  const tool = {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "reproProbe",
      safeServerName: "reproProbe",
      toolName: "probe_tool",
      operation: "tool",
    },
  });
  return tool;
}

function makeCoreInventory(
  tool: { id: string; label: string; description: string; rawDescription?: string } = {
    id: "exec",
    label: "Exec",
    description: "Run shell commands",
  },
): ToolsEffectivePayload {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: tool.id,
            label: tool.label,
            description: tool.description,
            rawDescription: tool.rawDescription ?? tool.description,
            source: "core",
          },
        ],
      },
    ],
  };
}

function makeMcpCatalog(): McpToolCatalog {
  return { version: 1, generatedAt: 1, servers: {}, tools: [] };
}

function mockMcpConfigSummary(params: { fingerprint?: string; serverNames?: string[] } = {}): void {
  runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValueOnce({
    fingerprint: params.fingerprint ?? "mcp:1:test",
    serverNames: params.serverNames ?? ["reproProbe"],
  });
}

function mockWarmMcpRuntime(
  catalog: McpToolCatalog,
  params: { workspaceDir?: string; configFingerprint?: string } = {},
): void {
  runtimeMocks.peekSessionMcpRuntime.mockReturnValueOnce({
    workspaceDir: params.workspaceDir ?? "/tmp/workspace-main",
    configFingerprint: params.configFingerprint ?? "mcp:1:test",
    peekCatalog: () => catalog,
  });
}

function mockWarmMcpTool(params: Record<string, unknown> = { type: "object", properties: {} }) {
  const mcpTool = makeMcpTool(params);
  const catalog = makeMcpCatalog();
  mockMcpConfigSummary();
  mockWarmMcpRuntime(catalog);
  runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([mcpTool]);
  return { catalog, mcpTool };
}

function expectInvalidResponse(respond: ReturnType<typeof vi.fn>, message: string): void {
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(message);
}

async function expectInvalidToolsParams(
  params: Record<string, unknown>,
  message: string,
): Promise<void> {
  const { respond, invoke } = createInvokeParams(params);
  await invoke();
  expectInvalidResponse(respond, message);
}

function expectPayloadGroupIds(respond: ReturnType<typeof vi.fn>, ids: string[]): void {
  const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
  expect(payload?.groups?.map((group) => group.id)).toEqual(ids);
}

function expectResponsesOk(...responds: Array<ReturnType<typeof vi.fn>>): void {
  for (const respond of responds) {
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  }
}

function expectPayloadNotice(respond: ReturnType<typeof vi.fn>, id: string) {
  const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
  const notice = payload?.notices?.[0];
  expect(notice?.id).toBe(id);
  return notice;
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testing.resetToolsEffectiveCacheForTest();
    testing.resetToolsEffectiveNowForTest();
    nodePluginToolSnapshotMocks.version = 1;
    runtimeMocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace-main");
    runtimeMocks.resolveAgentDir.mockReturnValue("/tmp/agents/main/agent");
    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
    runtimeMocks.getActivePluginRegistryVersion.mockReturnValue(1);
    runtimeMocks.resolveRuntimeConfigCacheKey.mockReturnValue("runtime:1:test");
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext.mockReturnValue({
      modelApi: "openai-responses",
      runtimeModel: {
        id: "gpt-4.1",
        name: "GPT 4.1",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
      fingerprint: "mcp:1:test",
      serverNames: [] as string[],
    });
    runtimeMocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValue(undefined);
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValue([]);
    runtimeMocks.applyFinalEffectiveToolPolicy.mockImplementation(
      (params: { bundledTools: unknown[] }) => params.bundledTools,
    );
    runtimeMocks.resolveEffectiveToolInventory.mockReturnValue(makeCoreInventory());
  });

  it("rejects invalid params", async () => {
    await expectInvalidToolsParams({ includePlugins: false }, "invalid tools.effective params");
  });

  it("rejects missing sessionKey", async () => {
    await expectInvalidToolsParams({}, "invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    await expectInvalidToolsParams({ senderIsOwner: true }, "invalid tools.effective params");
  });

  it("rejects unknown agent ids", async () => {
    await expectInvalidToolsParams(
      {
        sessionKey: "main:abc",
        agentId: "unknown-agent",
      },
      "unknown agent id",
    );
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    expectInvalidResponse(respond, 'unknown session key "missing-session"');
  });

  it("returns the read-only effective runtime inventory without MCP startup", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as ToolsEffectivePayload | undefined;
    expect(payload?.agentId).toBe("main");
    expect(payload?.profile).toBe("coding");
    expect(payload?.groups?.[0]?.id).toBe("core");
    expect(payload?.groups?.[0]?.source).toBe("core");
    expect(payload?.groups?.[0]?.tools?.[0]?.id).toBe("exec");
    const inventoryParams = resolveEffectiveToolInventoryArg();
    expect(inventoryParams?.currentChannelId).toBe("channel-1");
    expect(inventoryParams?.currentThreadTs).toBe("thread-2");
    expect(inventoryParams?.accountId).toBe("acct-1");
    expect(inventoryParams?.groupId).toBe("group-4");
    expect(inventoryParams?.groupChannel).toBe("#ops");
    expect(inventoryParams?.groupSpace).toBe("workspace-5");
    expect(inventoryParams?.replyToMode).toBe("first");
    expect(inventoryParams?.messageProvider).toBe("telegram");
    expect(inventoryParams?.modelProvider).toBe("openai");
    expect(inventoryParams?.modelId).toBe("gpt-4.1");
    expect(inventoryParams?.agentDir).toBe("/tmp/agents/main/agent");
    expect(inventoryParams?.workspaceDir).toBe("/tmp/workspace-main");
    expect(inventoryParams?.modelApi).toBe("openai-responses");
    expect(inventoryParams?.runtimeModel).toMatchObject({
      id: "gpt-4.1",
      api: "openai-responses",
      provider: "openai",
    });
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/tmp/agents/main/agent",
        workspaceDir: "/tmp/workspace-main",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("serves repeated requests from the fresh base inventory cache while still peeking MCP state", async () => {
    runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValue({
      fingerprint: "mcp:1:test",
      serverNames: ["reproProbe"],
    });
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.peekSessionMcpRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.resolveSessionMcpConfigSummary).toHaveBeenCalledTimes(1);
    expectResponsesOk(first.respond, second.respond);
  });

  it("recomputes fresh base inventory when connected node plugin tools change", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    nodePluginToolSnapshotMocks.version = 2;
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).toHaveBeenCalledTimes(2);
    expectResponsesOk(first.respond, second.respond);
  });

  it("keeps separate base inventory cache entries for spawned workspaces", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    const loaded = runtimeMocks.loadSessionEntry();
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: {
        ...loaded.entry,
        spawnedWorkspaceDir: "/tmp/workspace-sandbox",
      },
    });
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveToolInventoryArg(1)?.workspaceDir).toBe("/tmp/workspace-sandbox");
  });

  it("invalidates the base inventory cache when only the channel registry version changes", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(2);
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(second.respond)?.[0]).toBe(true);
  });

  it("does not resolve runtime model context for fresh base inventory cache hits", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext.mockReturnValueOnce({
      modelApi: "openai-completions",
      runtimeModel: {
        id: "gpt-4.1",
        name: "GPT 4.1",
        provider: "openai",
        api: "openai-completions",
      },
    } as never);
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(second.respond)?.[0]).toBe(true);
  });

  it("coalesces identical base inventory cache misses while inventory resolution is pending", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    const second = createInvokeParams({ sessionKey: "main:abc" });

    await Promise.all([first.invoke(), second.invoke()]);

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expectResponsesOk(first.respond, second.respond);
  });

  it("returns stale cached base inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    testing.setToolsEffectiveNowForTest(() => now);
    const stalePayload = makeCoreInventory({
      id: "read",
      label: "Read",
      description: "Read files",
    });
    const refreshedPayload = makeCoreInventory();
    runtimeMocks.resolveEffectiveToolInventory
      .mockReturnValueOnce(stalePayload)
      .mockReturnValueOnce(refreshedPayload);

    const initial = createInvokeParams({ sessionKey: "main:abc" });
    await initial.invoke();
    now += 11_000;

    const stale = createInvokeParams({ sessionKey: "main:abc" });
    await stale.invoke();

    expect(firstRespondCall(stale.respond)?.[1]).toBe(stalePayload);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = createInvokeParams({ sessionKey: "main:abc" });
    await fresh.invoke();
    expect(firstRespondCall(fresh.respond)?.[1]).toBe(refreshedPayload);
  });

  it("reports configured MCP servers as not connected without starting them", async () => {
    mockMcpConfigSummary({ serverNames: ["zeta", "alpha"] });
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    const notice = expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(notice?.message).toContain('"alpha", "zeta"');
    expect(notice?.servers).toEqual(["alpha", "zeta"]);
  });

  it("projects MCP tools from an already-populated session runtime catalog", async () => {
    const { catalog } = mockWarmMcpTool();

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
    expectPayloadGroupIds(respond, ["core", "mcp"]);
    expect(payload?.groups?.[1]).toEqual({
      id: "mcp",
      label: "MCP server tools",
      source: "mcp",
      tools: [
        {
          id: "reproProbe__probe_tool",
          label: "Probe Tool",
          description: "Probe from MCP",
          rawDescription: "Probe from MCP",
          source: "mcp",
          pluginId: "bundle-mcp",
          mcpServer: "reproProbe",
          mcpToolName: "probe_tool",
        },
      ],
    });
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
      catalog,
      reservedToolNames: ["exec"],
      includeSessionDenied: true,
    });
  });

  it("uses async model context while projecting a warm MCP catalog", async () => {
    mockWarmMcpTool();
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext.mockImplementation(() => {
      throw new Error("synchronous model context should not be used");
    });
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync.mockResolvedValue({
      modelApi: "openai-responses",
      runtimeModel: {
        id: "gpt-4.1",
        name: "GPT 4.1",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(
      runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync,
    ).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).not.toHaveBeenCalled();
  });

  it("does not retry synchronous model context when async resolution has no model", async () => {
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext.mockImplementation(() => {
      throw new Error("synchronous model context should not be used");
    });
    runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync.mockResolvedValue(
      {} as never,
    );

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(
      runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync,
    ).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContext).not.toHaveBeenCalled();
  });

  it("projects MCP tools from the session-owning native harness catalog", async () => {
    const loaded = runtimeMocks.loadSessionEntry();
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: {
        ...loaded.entry,
        agentHarnessId: "codex",
        toolOverrides: { mcpToolsDeny: { docs: ["delete"] } },
      },
    } as never);
    mockMcpConfigSummary();
    const catalog = makeMcpCatalog();
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(catalog);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([makeMcpTool()]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(loadMcpToolCatalog).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "main:abc",
      workspaceDir: "/tmp/workspace-main",
      mcpServerNames: ["reproProbe"],
      toolOverrides: { mcpToolsDeny: { docs: ["delete"] } },
    });
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
      catalog,
      reservedToolNames: ["exec"],
      includeSessionDenied: true,
    });
    expectPayloadGroupIds(respond, ["core", "mcp"]);
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("does not substitute the core MCP catalog when native inventory is unavailable", async () => {
    const loaded = runtimeMocks.loadSessionEntry();
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      ...loaded,
      entry: { ...loaded.entry, agentHarnessId: "codex" },
    } as never);
    runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValueOnce({
      fingerprint: "mcp:1:test",
      serverNames: ["reproProbe"],
    });
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(undefined);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    runtimeMocks.peekSessionMcpRuntime.mockReturnValue({
      workspaceDir: "/tmp/workspace-main",
      configFingerprint: "mcp:1:test",
      peekCatalog: () => makeMcpCatalog(),
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("preserves raw MCP identities and session denials across sanitized collisions", async () => {
    const enabled = makeMcpTool();
    enabled.name = "collision__alpha-";
    enabled.label = "Alpha bang";
    setPluginToolMeta(enabled, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "collision",
        safeServerName: "collision",
        toolName: "alpha!",
        operation: "tool",
      },
    });
    const denied = makeMcpTool();
    denied.name = "collision__alpha--2";
    denied.label = "Alpha question";
    setPluginToolMeta(denied, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "collision",
        safeServerName: "collision",
        toolName: "alpha?",
        operation: "tool",
        deniedBySession: true,
      },
    });
    const catalog = makeMcpCatalog();
    mockMcpConfigSummary({ serverNames: ["collision"] });
    mockWarmMcpRuntime(catalog);
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([enabled, denied]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
    expect(payload?.groups?.[0]?.tools?.[0]).toEqual({
      id: "exec",
      label: "Exec",
      description: "Run shell commands",
      rawDescription: "Run shell commands",
      source: "core",
    });
    expect(payload?.groups?.[1]?.tools).toEqual([
      expect.objectContaining({
        id: "collision__alpha-",
        mcpServer: "collision",
        mcpToolName: "alpha!",
      }),
      expect.objectContaining({
        id: "collision__alpha--2",
        mcpServer: "collision",
        mcpToolName: "alpha?",
        deniedBySession: true,
      }),
    ]);
  });

  it("uses the warm runtime workspace when comparing sandboxed MCP catalogs", async () => {
    const mcpTool = makeMcpTool();
    const catalog = makeMcpCatalog();
    runtimeMocks.resolveSessionMcpConfigSummary.mockImplementationOnce(
      ({ workspaceDir } = { workspaceDir: "" }) => ({
        fingerprint: workspaceDir === "/tmp/sandbox-copy" ? "mcp:1:sandbox" : "mcp:1:workspace",
        serverNames: ["reproProbe"],
      }),
    );
    mockWarmMcpRuntime(catalog, {
      workspaceDir: "/tmp/sandbox-copy",
      configFingerprint: "mcp:1:sandbox",
    });
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([mcpTool]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core", "mcp"]);
    expect(runtimeMocks.resolveSessionMcpConfigSummary).toHaveBeenCalledWith({
      workspaceDir: "/tmp/sandbox-copy",
      cfg: {},
    });
    expect(
      runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync,
    ).toHaveBeenCalledTimes(2);
    expect(
      runtimeMocks.resolveEffectiveToolInventoryRuntimeModelContextAsync,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/sandbox-copy",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("does not project warm MCP tools filtered out by final policy", async () => {
    mockWarmMcpTool();
    runtimeMocks.applyFinalEffectiveToolPolicy.mockReturnValueOnce([]);

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
  });

  it("quarantines warm MCP tools with schemas the runtime cannot project", async () => {
    mockWarmMcpTool({ type: "array", items: { type: "string" } });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "unsupported-tool-schema:reproProbe__probe_tool");
  });

  it("does not project stale MCP catalogs after config changes", async () => {
    mockMcpConfigSummary({ fingerprint: "mcp:2:test" });
    mockWarmMcpRuntime(makeMcpCatalog(), {
      configFingerprint: "mcp:1:test",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-stale-catalog");
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).not.toHaveBeenCalled();
  });

  it("falls back to origin.threadId when delivery context omits thread metadata", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-origin-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastAccountId: "acct-1",
        lastTo: "channel-1",
        origin: {
          provider: "telegram",
          accountId: "acct-1",
          threadId: 42,
        },
        groupId: "group-4",
        groupChannel: "#ops",
        space: "workspace-5",
        chatType: "group",
        modelProvider: "openai",
        model: "gpt-4.1",
      },
    } as never);
    runtimeMocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "telegram",
      to: "channel-1",
      accountId: "acct-1",
      threadId: "42",
    });

    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expect(resolveEffectiveToolInventoryArg()?.currentThreadTs).toBe("42");
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  });

  it("rejects unknown agent ids before loading the session", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    // `other` is not configured, so the handler rejects before reaching
    // loadSessionEntry; no session mock is queued here on purpose.
    await invoke();
    expectInvalidResponse(respond, 'unknown agent id "other"');
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("loads global sessions with the requested agent id before matching session agent", async () => {
    runtimeMocks.listAgentIds.mockReturnValueOnce(["main", "work"]);
    runtimeMocks.loadSessionEntry.mockImplementationOnce(
      () =>
        ({
          cfg: {},
          canonicalKey: "global",
          entry: {
            sessionId: "session-work-global",
            updatedAt: 1,
            modelProvider: "openai",
            model: "gpt-4.1",
          },
          storePath: "/tmp/work/sessions.json",
          store: {},
          storeKeys: ["global"],
        }) as never,
    );
    runtimeMocks.resolveSessionAgentId.mockReturnValueOnce("work");
    runtimeMocks.resolveAgentDir.mockReturnValueOnce("/tmp/agents/work/agent");
    runtimeMocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/workspace-work");
    runtimeMocks.resolveEffectiveToolInventory.mockReturnValueOnce(makeCoreInventory());

    const { respond, invoke } = createInvokeParams(
      {
        sessionKey: "global",
        agentId: "work",
      },
      { agents: { list: [{ id: "main" }, { id: "work" }] } },
    );
    await invoke();

    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(runtimeMocks.resolveSessionAgentId).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
      }),
    );
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(true);
    expect(resolveEffectiveToolInventoryArg()?.agentId).toBe("work");
    expect(runtimeMocks.resolveAgentDir).toHaveBeenCalledWith({}, "work");
  });

  it("loads a bare session through the persisted fixed-store owner", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "global",
      entry: { sessionId: "session-ops-global", updatedAt: 1 },
      storePath: "/tmp/shared-sessions.sqlite",
    } as never);
    runtimeMocks.resolveSessionAgentId.mockReturnValueOnce("ops");
    runtimeMocks.resolveEffectiveToolInventory.mockReturnValueOnce(makeCoreInventory());

    const { respond, invoke } = createInvokeParams(
      { sessionKey: "global" },
      {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          list: [{ id: "ops" }, { id: "research" }],
          defaults: { sessionStore: { agentId: "ops" } },
        },
      },
    );
    await invoke();

    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  });

  it("does not let a requested agent override ownership of a non-global session key", async () => {
    runtimeMocks.listAgentIds.mockReturnValueOnce(["main", "work"]);
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "agent:main:abc",
      entry: { sessionId: "session-main", updatedAt: 1 },
    } as never);
    // Persisted owner of the non-global key.
    runtimeMocks.resolveSessionAgentId.mockReturnValueOnce("main");

    const { respond, invoke } = createInvokeParams(
      {
        sessionKey: "agent:main:abc",
        agentId: "work",
      },
      { agents: { list: [{ id: "main" }, { id: "work" }] } },
    );
    await invoke();

    expectInvalidResponse(respond, 'agent "work" does not match session key agent "main"');
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveSessionAgentId).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveEffectiveToolInventory).not.toHaveBeenCalled();
  });
});
