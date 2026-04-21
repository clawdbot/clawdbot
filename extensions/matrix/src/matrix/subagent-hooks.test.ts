import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted stubs referenced in vi.mock factories below
const bindMock = vi.hoisted(() => vi.fn());
const unbindMock = vi.hoisted(() => vi.fn());
const getManagerMock = vi.hoisted(() => vi.fn());
const listAllBindingsMock = vi.hoisted(() => vi.fn((): any[] => []));
const listBindingsForAccountMock = vi.hoisted(() => vi.fn((): any[] => []));
const removeBindingRecordMock = vi.hoisted(() => vi.fn(() => false));
const resolveMatrixBaseConfigMock = vi.hoisted(() => vi.fn((): any => ({})));
const findMatrixAccountConfigMock = vi.hoisted(() => vi.fn((): any => undefined));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ bind: bindMock, unbind: unbindMock }),
}));

vi.mock("./account-config.js", () => ({
  resolveMatrixBaseConfig: resolveMatrixBaseConfigMock,
  findMatrixAccountConfig: findMatrixAccountConfigMock,
}));

vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: getManagerMock,
  listAllBindings: listAllBindingsMock,
  listBindingsForAccount: listBindingsForAccountMock,
  removeBindingRecord: removeBindingRecordMock,
  resolveBindingKey: (params: {
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }) =>
    `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`,
}));

import {
  handleMatrixSubagentDeliveryTarget,
  handleMatrixSubagentEnded,
  handleMatrixSubagentSpawning,
} from "./subagent-hooks.js";

// A minimal fake api — only config is used by these hooks
const fakeApi = { config: {} } as never;

function makeSpawnEvent(
  overrides: Partial<{
    threadRequested: boolean;
    channel: string;
    accountId: string;
    to: string;
    childSessionKey: string;
    agentId: string;
    label: string;
  }> = {},
) {
  return {
    threadRequested: overrides.threadRequested ?? true,
    requester: {
      channel: overrides.channel ?? "matrix",
      accountId: overrides.accountId ?? "default",
      to: overrides.to ?? "room:!room123:example.org",
    },
    childSessionKey: overrides.childSessionKey ?? "agent:default:subagent:child",
    agentId: overrides.agentId ?? "worker",
    label: overrides.label,
  };
}

describe("handleMatrixSubagentSpawning", () => {
  beforeEach(() => {
    bindMock.mockReset();
    getManagerMock.mockReset();
    resolveMatrixBaseConfigMock.mockReset();
    findMatrixAccountConfigMock.mockReset();
    // Default: bindings enabled, spawn enabled
    resolveMatrixBaseConfigMock.mockReturnValue({
      threadBindings: { enabled: true, spawnSubagentSessions: true },
    });
    findMatrixAccountConfigMock.mockReturnValue(undefined);
    // Default: manager exists
    getManagerMock.mockReturnValue({ persist: vi.fn() });
    // Default: bind resolves ok
    bindMock.mockResolvedValue({
      conversation: {
        accountId: "default",
        conversationId: "$thread-root",
        parentConversationId: "!room123:example.org",
      },
    });
  });

  it("returns undefined when threadRequested is false", async () => {
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ threadRequested: false }),
    );
    expect(result).toBeUndefined();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("returns undefined when channel is not matrix", async () => {
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ channel: "slack" }),
    );
    expect(result).toBeUndefined();
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("proceeds past channel check when channel is 'matrix' with mixed casing", async () => {
    // channel.trim().toLowerCase() must equal "matrix" — mixed case is accepted
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ channel: " Matrix " }),
    );
    expect(result).not.toBeUndefined();
  });

  it("returns error when thread bindings are disabled", async () => {
    resolveMatrixBaseConfigMock.mockReturnValue({
      threadBindings: { enabled: false, spawnSubagentSessions: true },
    });
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("thread bindings are disabled"),
      }),
    );
  });

  it("returns error when spawnSubagentSessions is false", async () => {
    resolveMatrixBaseConfigMock.mockReturnValue({
      threadBindings: { enabled: true, spawnSubagentSessions: false },
    });
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("spawnSubagentSessions"),
      }),
    );
  });

  it("returns error when spawnSubagentSessions defaults to false (no config)", async () => {
    resolveMatrixBaseConfigMock.mockReturnValue({});
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("spawnSubagentSessions"),
      }),
    );
  });

  it("returns error when requester.to has no room target", async () => {
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ to: "@user:example.org" }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("no room target"),
      }),
    );
  });

  it("returns error when requester.to is empty", async () => {
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent({ to: "" }));
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("no room target"),
      }),
    );
  });

  it("returns error when no binding manager is available for the account", async () => {
    getManagerMock.mockReturnValue(null);
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("No Matrix thread binding manager"),
      }),
    );
  });

  it("calls bind with the resolved room id and returns ok", async () => {
    bindMock.mockResolvedValue({
      conversation: {
        accountId: "ops",
        conversationId: "$thread-ops",
        parentConversationId: "!roomAbc:technerik.com",
      },
    });
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({
        accountId: "ops",
        to: "room:!roomAbc:technerik.com",
        childSessionKey: "agent:ops:subagent:worker",
        agentId: "builder",
        label: "Build Agent",
      }),
    );

    expect(bindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:ops:subagent:worker",
        targetKind: "subagent",
        conversation: expect.objectContaining({
          channel: "matrix",
          accountId: "ops",
          conversationId: "!roomAbc:technerik.com",
        }),
        placement: "child",
        metadata: expect.objectContaining({
          agentId: "builder",
          label: "Build Agent",
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!roomAbc:technerik.com",
        threadId: "$thread-ops",
      },
    });
  });

  it("uses 'default' as accountId when requester.accountId is absent", async () => {
    bindMock.mockResolvedValue({
      conversation: {
        accountId: "default",
        conversationId: "$thread-default",
        parentConversationId: "!room123:example.org",
      },
    });
    await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent({ accountId: undefined as never }));
    expect(getManagerMock).toHaveBeenCalledWith("default");
    expect(bindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ accountId: "default" }),
      }),
    );
  });

  it("returns error when bind() throws", async () => {
    bindMock.mockRejectedValue(new Error("provider auth failed"));
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("provider auth failed"),
      }),
    );
  });

  it("respects per-account threadBindings override over base config", async () => {
    // Base says spawnSubagentSessions=false; account override says true
    resolveMatrixBaseConfigMock.mockReturnValue({
      threadBindings: { enabled: true, spawnSubagentSessions: false },
    });
    findMatrixAccountConfigMock.mockReturnValue({
      threadBindings: { spawnSubagentSessions: true },
    });
    bindMock.mockResolvedValue({ conversation: {} });

    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ accountId: "forge" }),
    );
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });
});

describe("handleMatrixSubagentEnded", () => {
  const mockManager = { persist: vi.fn() };

  beforeEach(() => {
    getManagerMock.mockReset();
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
    removeBindingRecordMock.mockReset();
    unbindMock.mockReset();
    mockManager.persist.mockReset();
  });

  it("does nothing when no matching bindings exist", async () => {
    listBindingsForAccountMock.mockReturnValue([]);
    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("removes matching bindings and calls persist on the manager", async () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(removeBindingRecordMock).toHaveBeenCalledWith(binding);
    expect(getManagerMock).toHaveBeenCalledWith("ops");
    expect(mockManager.persist).toHaveBeenCalled();
  });

  it("sends farewell through the binding service when requested", async () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);
    unbindMock.mockResolvedValue([
      {
        bindingId: "ops:!room:example:$thread",
        targetSessionKey: "agent:ops:subagent:child",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: "ops",
          conversationId: "$thread",
          parentConversationId: "!room:example",
        },
        status: "active",
        boundAt: 0,
      },
    ]);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      reason: "spawn-failed",
      sendFarewell: true,
    });

    expect(unbindMock).toHaveBeenCalledWith({
      bindingId: "ops:!room:example:$thread",
      reason: "spawn-failed",
    });
    expect(removeBindingRecordMock).not.toHaveBeenCalled();
    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("skips persist when removeBindingRecord returns false (binding not found in store)", async () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:orphan",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(false);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:orphan",
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(getManagerMock).not.toHaveBeenCalled();
  });

  it("falls back to listAllBindings when accountId is absent", async () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listAllBindingsMock.mockReturnValue([binding]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
    });

    expect(listAllBindingsMock).toHaveBeenCalled();
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
    expect(mockManager.persist).toHaveBeenCalled();
  });

  it("does not double-persist when multiple bindings share the same account", async () => {
    const mkBinding = (conversationId: string) => ({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId,
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    });
    listBindingsForAccountMock.mockReturnValue([mkBinding("$t1"), mkBinding("$t2")]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue(mockManager);
    mockManager.persist.mockResolvedValue(undefined);

    await handleMatrixSubagentEnded({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
    });

    // persist must be called exactly once per unique accountId, not once per binding
    expect(mockManager.persist).toHaveBeenCalledTimes(1);
  });
});

describe("handleMatrixSubagentDeliveryTarget", () => {
  beforeEach(() => {
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
  });

  it("returns undefined when expectsCompletionMessage is false", () => {
    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops" },
      expectsCompletionMessage: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when requester channel is not matrix", () => {
    listBindingsForAccountMock.mockReturnValue([]);
    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "slack", accountId: "ops" },
      expectsCompletionMessage: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no bindings match the child session key", () => {
    listBindingsForAccountMock.mockReturnValue([
      {
        targetSessionKey: "agent:ops:subagent:OTHER",
        targetKind: "subagent",
        accountId: "ops",
        conversationId: "$thread",
        parentConversationId: "!room:example",
        boundAt: 0,
        lastActivityAt: 0,
      },
    ]);
    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops" },
      expectsCompletionMessage: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns origin with threadId when binding has a distinct parentConversationId", () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread123",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops", threadId: "$thread123" },
      expectsCompletionMessage: true,
    });

    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!room:example",
        threadId: "$thread123",
      },
    });
  });

  it("returns origin without threadId when conversationId equals parentConversationId", () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "!room:example",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops" },
      expectsCompletionMessage: true,
    });

    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!room:example",
      },
    });
    expect(result?.origin).not.toHaveProperty("threadId");
  });

  it("returns origin without threadId when binding has no parentConversationId", () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops" },
      expectsCompletionMessage: true,
    });

    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!room:example",
      },
    });
  });

  it("falls back to the single binding when requesterOrigin threadId does not match any binding", () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread123",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops", threadId: "$threadOTHER" },
      expectsCompletionMessage: true,
    });

    // No threadId match, but single binding → falls back to it
    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: "room:!room:example",
        threadId: "$thread123",
      },
    });
  });

  it("returns undefined when multiple bindings exist and threadId matches none", () => {
    const mkBinding = (threadId: string) => ({
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: threadId,
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    });
    listBindingsForAccountMock.mockReturnValue([mkBinding("$t1"), mkBinding("$t2")]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix", accountId: "ops", threadId: "$tNONE" },
      expectsCompletionMessage: true,
    });

    expect(result).toBeUndefined();
  });

  it("uses listAllBindings when requesterOrigin has no accountId", () => {
    const binding = {
      targetSessionKey: "agent:ops:subagent:child",
      targetKind: "subagent",
      accountId: "ops",
      conversationId: "$thread123",
      parentConversationId: "!room:example",
      boundAt: 0,
      lastActivityAt: 0,
    };
    listAllBindingsMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget({
      childSessionKey: "agent:ops:subagent:child",
      requesterOrigin: { channel: "matrix" },
      expectsCompletionMessage: true,
    });

    expect(listAllBindingsMock).toHaveBeenCalled();
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});

describe("concurrent spawns across accounts", () => {
  function spawnForAccount(accountId: "ops" | "forge") {
    return handleMatrixSubagentSpawning(fakeApi, {
      threadRequested: true,
      requester: {
        channel: "matrix",
        accountId,
        to: `room:!room-${accountId}:example.org`,
      },
      childSessionKey: `agent:${accountId}:subagent:child-${accountId}`,
      agentId: `worker-${accountId}`,
    });
  }

  beforeEach(() => {
    bindMock.mockReset();
    getManagerMock.mockReset();
    resolveMatrixBaseConfigMock.mockReset();
    findMatrixAccountConfigMock.mockReset();
    resolveMatrixBaseConfigMock.mockReturnValue({
      threadBindings: { enabled: true, spawnSubagentSessions: true },
    });
    findMatrixAccountConfigMock.mockReturnValue(undefined);
    getManagerMock.mockReturnValue({ persist: vi.fn() });
  });

  it("resolves both spawns independently when two accounts fire simultaneously", async () => {
    // Each account gets its own bind call that resolves with a distinct conversation
    bindMock
      .mockResolvedValueOnce({ conversation: { accountId: "ops", conversationId: "$t-ops" } })
      .mockResolvedValueOnce({ conversation: { accountId: "forge", conversationId: "$t-forge" } });

    const [opsResult, forgeResult] = await Promise.all([
      spawnForAccount("ops"),
      spawnForAccount("forge"),
    ]);

    expect(opsResult).toMatchObject({ status: "ok", threadBindingReady: true });
    expect(forgeResult).toMatchObject({ status: "ok", threadBindingReady: true });
    expect(bindMock).toHaveBeenCalledTimes(2);

    // Each bind call targeted the correct account's room
    expect(bindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:ops:subagent:child-ops",
        conversation: expect.objectContaining({
          accountId: "ops",
          conversationId: "!room-ops:example.org",
        }),
      }),
    );
    expect(bindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:forge:subagent:child-forge",
        conversation: expect.objectContaining({
          accountId: "forge",
          conversationId: "!room-forge:example.org",
        }),
      }),
    );
  });

  it("one account bind failure does not affect the other account's spawn", async () => {
    bindMock
      .mockRejectedValueOnce(new Error("ops provider auth failed"))
      .mockResolvedValueOnce({ conversation: { accountId: "forge", conversationId: "$t-forge" } });

    const [opsResult, forgeResult] = await Promise.all([
      spawnForAccount("ops"),
      spawnForAccount("forge"),
    ]);

    expect(opsResult).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("ops provider auth failed"),
      }),
    );
    expect(forgeResult).toMatchObject({ status: "ok", threadBindingReady: true });
  });
});
