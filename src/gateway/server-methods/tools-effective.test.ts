import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { McpToolCatalog, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
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
  resolveEffectiveToolInventoryRuntimeModelContext: vi.fn(() => ({
    modelApi: "openai-responses",
    runtimeModel: {
      id: "gpt-4.1",
      name: "GPT 4.1",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  })),
}));

vi.mock("./tools-effective.runtime.js", () => runtimeMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type ToolsEffectivePayload = {
  agentId?: string;
  profile?: string;
  notices?: Array<{ id?: string; severity?: string; message?: string }>;
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
    }>;
  }>;
};

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await toolsEffectiveHandlers["tools.effective"]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => ({}) } as never,
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
  return {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
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
    mockMcpConfigSummary();
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();

    expectPayloadGroupIds(respond, ["core"]);
    expect(expectPayloadNotice(respond, "mcp-not-yet-connected")?.message).toContain("reproProbe");
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
        },
      ],
    });
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
      catalog,
      reservedToolNames: ["exec"],
    });
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

  it("rejects agent ids that do not match the session agent", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    } as never);
    await invoke();
    expectInvalidResponse(respond, 'unknown agent id "other"');
  });
});
