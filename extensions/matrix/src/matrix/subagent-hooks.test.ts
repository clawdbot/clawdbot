import type { OpenClawPluginApi as MatrixEntryPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Matrix tests cover subagent hooks plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixSubagentHooks } from "../../subagent-hooks-api.js";

// Hoisted stubs referenced in vi.mock factories below
const bindMock = vi.hoisted(() => vi.fn());
const unbindMock = vi.hoisted(() => vi.fn());
const getCapabilitiesMock = vi.hoisted(() => vi.fn());
const getManagerMock = vi.hoisted(() => vi.fn());
const listAllBindingsMock = vi.hoisted(() => vi.fn((): any[] => []));
const listBindingsForAccountMock = vi.hoisted(() => vi.fn((): any[] => []));
const removeBindingRecordMock = vi.hoisted(() => vi.fn(() => false));
const resolveMatrixBaseConfigMock = vi.hoisted(() => vi.fn((): any => ({})));
const findMatrixAccountConfigMock = vi.hoisted(() => vi.fn((): any => undefined));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    bind: bindMock,
    getCapabilities: getCapabilitiesMock,
    unbind: unbindMock,
  }),
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

const fakeApi = { config: {} } as never;
const DEFAULT_CHILD_SESSION_KEY = "agent:ops:subagent:child";
const DEFAULT_ROOM_ID = "!room:example";

function registerHandlersForTest(config: Record<string, unknown> = {}) {
  return registerHookHandlersForTest<MatrixEntryPluginApi>({
    config,
    register: (api) => {
      registerMatrixSubagentHooks(api);
      api.on("subagent_spawning", (event) => handleMatrixSubagentSpawning(api, event));
    },
  });
}

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

function apiWithMatrixConfig(matrix: Record<string, unknown>) {
  return { config: { channels: { matrix } } } as never;
}

function makeBinding(
  overrides: Partial<{
    targetSessionKey: string;
    targetKind: string;
    accountId: string;
    conversationId: string;
    parentConversationId: string | undefined;
  }> = {},
) {
  return {
    targetSessionKey: DEFAULT_CHILD_SESSION_KEY,
    targetKind: "subagent",
    accountId: "ops",
    conversationId: "$thread",
    parentConversationId: DEFAULT_ROOM_ID,
    boundAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

function makeDeliveryEvent(
  overrides: Partial<{
    childSessionKey: string;
    channel: string;
    accountId: string | undefined;
    to: string;
    threadId: string;
    expectsCompletionMessage: boolean;
  }> = {},
) {
  const requesterOrigin: {
    channel: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  } = { channel: overrides.channel ?? "matrix" };
  if (!("accountId" in overrides) || overrides.accountId !== undefined) {
    requesterOrigin.accountId = overrides.accountId ?? "ops";
  }
  if (overrides.to !== undefined) {
    requesterOrigin.to = overrides.to;
  }
  if (overrides.threadId !== undefined) {
    requesterOrigin.threadId = overrides.threadId;
  }
  return {
    childSessionKey: overrides.childSessionKey ?? DEFAULT_CHILD_SESSION_KEY,
    requesterOrigin,
    expectsCompletionMessage: overrides.expectsCompletionMessage ?? true,
  };
}

function makeDeliveryResult(
  overrides: Partial<{ accountId: string; to: string; threadId: string }> = {},
) {
  return {
    origin: {
      channel: "matrix",
      accountId: "ops",
      to: `room:${DEFAULT_ROOM_ID}`,
      ...overrides,
    },
  };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectResultFields(result: unknown, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(result, "hook result"), fields);
}

function expectErrorResult(result: unknown, messagePart: string) {
  const record = requireRecord(result, "hook result");
  expect(record.status).toBe("error");
  expect(String(record.error).toLowerCase()).toContain(messagePart.toLowerCase());
}

function requireBindCallWithTarget(targetSessionKey: string) {
  const calls = bindMock.mock.calls;
  const call = calls.find(([params]) => {
    const record = params as { targetSessionKey?: string };
    return record.targetSessionKey === targetSessionKey;
  });
  if (!call) {
    throw new Error(`missing bind call for ${targetSessionKey}`);
  }
  return requireRecord(call[0], "bind params");
}

function resetSpawningMocks() {
  bindMock.mockReset();
  getCapabilitiesMock.mockReset();
  getManagerMock.mockReset();
  resolveMatrixBaseConfigMock.mockReset();
  findMatrixAccountConfigMock.mockReset();
  resolveMatrixBaseConfigMock.mockReturnValue({
    threadBindings: { enabled: true, spawnSessions: true },
  });
  findMatrixAccountConfigMock.mockReturnValue(undefined);
  getCapabilitiesMock.mockReturnValue({
    adapterAvailable: true,
    bindSupported: true,
    placements: ["current", "child"],
    unbindSupported: true,
  });
  getManagerMock.mockReturnValue({ persist: vi.fn() });
  bindMock.mockResolvedValue({
    conversation: {
      accountId: "default",
      conversationId: "$thread-root",
      parentConversationId: "!room123:example.org",
    },
  });
}

describe("handleMatrixSubagentSpawning", () => {
  beforeEach(() => {
    resetSpawningMocks();
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
    expectResultFields(result, { status: "ok", threadBindingReady: true });
  });

  it("returns error when thread bindings are disabled", async () => {
    const result = await handleMatrixSubagentSpawning(
      apiWithMatrixConfig({ threadBindings: { enabled: false, spawnSessions: true } }),
      makeSpawnEvent(),
    );
    expectErrorResult(result, "thread bindings are disabled");
  });

  it("returns error when spawnSessions is false", async () => {
    const result = await handleMatrixSubagentSpawning(
      apiWithMatrixConfig({ threadBindings: { enabled: true, spawnSessions: false } }),
      makeSpawnEvent(),
    );
    expectErrorResult(result, "spawnSessions");
  });

  it("allows thread-bound subagent spawn by default", async () => {
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expectResultFields(result, { status: "ok", threadBindingReady: true });
  });

  it("returns error when requester.to has no room target", async () => {
    const result = await handleMatrixSubagentSpawning(
      fakeApi,
      makeSpawnEvent({ to: "@user:example.org" }),
    );
    expectErrorResult(result, "no room target");
  });

  it("returns error when requester.to is empty", async () => {
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent({ to: "" }));
    expectErrorResult(result, "no room target");
  });

  it("returns error when no binding adapter is available for the account", async () => {
    getCapabilitiesMock.mockReturnValue({
      adapterAvailable: false,
      bindSupported: false,
      placements: [],
      unbindSupported: false,
    });
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expectErrorResult(result, "No Matrix session binding adapter");
    expect(bindMock).not.toHaveBeenCalled();
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

    const bindParams = requireBindCallWithTarget("agent:ops:subagent:worker");
    expectRecordFields(bindParams, {
      targetKind: "subagent",
      placement: "child",
    });
    expectRecordFields(requireRecord(bindParams.conversation, "bind conversation"), {
      channel: "matrix",
      accountId: "ops",
      conversationId: "!roomAbc:technerik.com",
    });
    expectRecordFields(requireRecord(bindParams.metadata, "bind metadata"), {
      agentId: "builder",
      label: "Build Agent",
    });
    expectResultFields(result, {
      status: "ok",
      threadBindingReady: true,
    });
    expectRecordFields(
      requireRecord(requireRecord(result, "hook result").deliveryOrigin, "delivery origin"),
      {
        channel: "matrix",
        accountId: "ops",
        to: "room:!roomAbc:technerik.com",
        threadId: "$thread-ops",
      },
    );
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
    expect(getCapabilitiesMock).toHaveBeenCalledWith({
      channel: "matrix",
      accountId: "default",
    });
    const bindParams = requireBindCallWithTarget("agent:default:subagent:child");
    expect(requireRecord(bindParams.conversation, "bind conversation").accountId).toBe("default");
  });

  it("returns error when bind() throws", async () => {
    bindMock.mockRejectedValue(new Error("provider auth failed"));
    const result = await handleMatrixSubagentSpawning(fakeApi, makeSpawnEvent());
    expectErrorResult(result, "provider auth failed");
  });

  it("respects per-account threadBindings override over base config", async () => {
    bindMock.mockResolvedValue({ conversation: {} });

    const result = await handleMatrixSubagentSpawning(
      apiWithMatrixConfig({
        threadBindings: { enabled: true, spawnSessions: false },
        accounts: { forge: { threadBindings: { spawnSessions: true } } },
      }),
      makeSpawnEvent({ accountId: "forge" }),
    );
    expectResultFields(result, { status: "ok", threadBindingReady: true });
  });
});

describe("matrix subagent hook registration", () => {
  beforeEach(() => {
    resetSpawningMocks();
    listBindingsForAccountMock.mockReset();
    listAllBindingsMock.mockReset();
  });

  it("binds thread routing through the lazy registration barrel", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    const result = await handler(makeSpawnEvent(), {});

    expect(bindMock).toHaveBeenCalledTimes(1);
    expectResultFields(result, {
      status: "ok",
      threadBindingReady: true,
    });
    expectRecordFields(
      requireRecord(requireRecord(result, "hook result").deliveryOrigin, "delivery origin"),
      {
        channel: "matrix",
        accountId: "default",
        to: "room:!room123:example.org",
        threadId: "$thread-root",
      },
    );
  });

  it("resolves delivery targets through the lazy registration barrel", async () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({
        conversationId: "$thread-ops",
        parentConversationId: "!roomAbc:technerik.com",
        targetSessionKey: "agent:ops:subagent:worker",
      }),
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(
      handler(
        makeDeliveryEvent({
          childSessionKey: "agent:ops:subagent:worker",
          to: "room:!roomAbc:technerik.com",
          threadId: "$thread-ops",
        }),
        {},
      ),
    ).resolves.toEqual(
      makeDeliveryResult({ to: "room:!roomAbc:technerik.com", threadId: "$thread-ops" }),
    );
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
    const binding = makeBinding();
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
    const binding = makeBinding();
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
    const binding = makeBinding({ targetSessionKey: "agent:ops:subagent:orphan" });
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
    const binding = makeBinding();
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
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$t1" }),
      makeBinding({ conversationId: "$t2" }),
    ]);
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
    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ expectsCompletionMessage: false }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when requester channel is not matrix", () => {
    listBindingsForAccountMock.mockReturnValue([]);
    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ channel: "slack" }));
    expect(result).toBeUndefined();
  });

  it("returns undefined when no bindings match the child session key", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ targetSessionKey: "agent:ops:subagent:OTHER" }),
    ]);
    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());
    expect(result).toBeUndefined();
  });

  it("returns origin with threadId when binding has a distinct parentConversationId", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ threadId: "$thread123" }),
    );

    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
  });

  it("returns origin without threadId when conversationId equals parentConversationId", () => {
    const binding = makeBinding({ conversationId: DEFAULT_ROOM_ID });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());

    expect(result).toEqual(makeDeliveryResult());
    expect(result?.origin).not.toHaveProperty("threadId");
  });

  it("returns origin without threadId when binding has no parentConversationId", () => {
    const binding = makeBinding({
      conversationId: DEFAULT_ROOM_ID,
      parentConversationId: undefined,
    });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent());

    expect(result).toEqual(makeDeliveryResult());
  });

  it("falls back to the single binding when requesterOrigin threadId does not match any binding", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listBindingsForAccountMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(
      makeDeliveryEvent({ threadId: "$threadOTHER" }),
    );

    // No threadId match, but single binding → falls back to it
    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
  });

  it("returns undefined when multiple bindings exist and threadId matches none", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$t1" }),
      makeBinding({ conversationId: "$t2" }),
    ]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ threadId: "$tNONE" }));

    expect(result).toBeUndefined();
  });

  it("uses listAllBindings when requesterOrigin has no accountId", () => {
    const binding = makeBinding({ conversationId: "$thread123" });
    listAllBindingsMock.mockReturnValue([binding]);

    const result = handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ accountId: undefined }));

    expect(listAllBindingsMock).toHaveBeenCalled();
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
    expect(result).toEqual(makeDeliveryResult({ threadId: "$thread123" }));
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
    resetSpawningMocks();
    bindMock.mockReset();
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

    expectResultFields(opsResult, { status: "ok", threadBindingReady: true });
    expectResultFields(forgeResult, { status: "ok", threadBindingReady: true });
    expect(bindMock).toHaveBeenCalledTimes(2);

    // Each bind call targeted the correct account's room
    expectRecordFields(
      requireRecord(
        requireBindCallWithTarget("agent:ops:subagent:child-ops").conversation,
        "ops bind conversation",
      ),
      {
        accountId: "ops",
        conversationId: "!room-ops:example.org",
      },
    );
    expectRecordFields(
      requireRecord(
        requireBindCallWithTarget("agent:forge:subagent:child-forge").conversation,
        "forge bind conversation",
      ),
      {
        accountId: "forge",
        conversationId: "!room-forge:example.org",
      },
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

    expectErrorResult(opsResult, "ops provider auth failed");
    expectResultFields(forgeResult, { status: "ok", threadBindingReady: true });
  });
});
