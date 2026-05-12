import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { __testing, toolsEffectiveHandlers } from "./tools-effective.js";

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
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
    },
  })),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  resolveRuntimeConfigCacheKey: vi.fn(() => "runtime:1:test"),
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
  })),
  resolveReplyToMode: vi.fn(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
}));

vi.mock("./tools-effective.runtime.js", () => runtimeMocks);

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
type ToolsEffectivePayload = {
  agentId?: string;
  profile?: string;
  groups?: Array<{
    id?: string;
    source?: string;
    tools?: Array<{ id?: string; source?: string }>;
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
  return calls.at(callIndex)?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls.at(0) as RespondCall | undefined;
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.resetToolsEffectiveCacheForTest();
    __testing.resetToolsEffectiveNowForTest();
    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
    runtimeMocks.getActivePluginRegistryVersion.mockReturnValue(1);
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects missing sessionKey", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    const { respond, invoke } = createInvokeParams({ senderIsOwner: true });
    await invoke();
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "unknown-agent",
    });
    await invoke();
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
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
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown session key "missing-session"');
  });

  it("returns the effective runtime inventory", async () => {
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
    expect(payload?.groups?.[0]?.tools?.[0]?.source).toBe("core");
    const inventoryParams = resolveEffectiveToolInventoryArg();
    expect(inventoryParams?.senderIsOwner).toBe(false);
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
  });

  it("serves repeated requests from the fresh inventory cache", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(first.respond)?.[0]).toBe(true);
    expect(firstRespondCall(second.respond)?.[0]).toBe(true);
  });

  it("invalidates the cache when only the channel registry version changes", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    await first.invoke();

    runtimeMocks.getActivePluginChannelRegistryVersion.mockReturnValue(2);
    const second = createInvokeParams({ sessionKey: "main:abc" });
    await second.invoke();

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    expect(firstRespondCall(second.respond)?.[0]).toBe(true);
  });

  it("coalesces identical cache misses while inventory resolution is pending", async () => {
    const first = createInvokeParams({ sessionKey: "main:abc" });
    const second = createInvokeParams({ sessionKey: "main:abc" });

    await Promise.all([first.invoke(), second.invoke()]);

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(first.respond)?.[0]).toBe(true);
    expect(firstRespondCall(second.respond)?.[0]).toBe(true);
  });

  it("returns stale cached inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    __testing.setToolsEffectiveNowForTest(() => now);
    const stalePayload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "read",
              label: "Read",
              description: "Read files",
              rawDescription: "Read files",
              source: "core",
            },
          ],
        },
      ],
    };
    const refreshedPayload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              rawDescription: "Run shell commands",
              source: "core",
            },
          ],
        },
      ],
    };
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

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = createInvokeParams({ sessionKey: "main:abc" });
    await fresh.invoke();
    expect(firstRespondCall(fresh.respond)?.[1]).toBe(refreshedPayload);
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

  it("passes senderIsOwner=true for admin-scoped callers", async () => {
    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "main:abc" },
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: {
        connect: { scopes: ["operator.admin"] },
      } as never,
      req: { type: "req", id: "req-1", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    expect(resolveEffectiveToolInventoryArg()?.senderIsOwner).toBe(true);
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
    const call = firstRespondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "other"');
  });
});
