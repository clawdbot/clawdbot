// Matrix tests cover current subagent delivery and cleanup hooks.
import type { OpenClawPluginApi as MatrixEntryPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixSubagentHooks } from "../../subagent-hooks-api.js";

const unbindMock = vi.hoisted(() => vi.fn());
const getManagerMock = vi.hoisted(() => vi.fn());
const listAllBindingsMock = vi.hoisted(() => vi.fn((): any[] => []));
const listBindingsForAccountMock = vi.hoisted(() => vi.fn((): any[] => []));
const removeBindingRecordMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ unbind: unbindMock }),
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

import { handleMatrixSubagentDeliveryTarget, handleMatrixSubagentEnded } from "./subagent-hooks.js";

const CHILD_SESSION_KEY = "agent:ops:subagent:child";
const ROOM_ID = "!room:example";

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
    targetSessionKey: CHILD_SESSION_KEY,
    targetKind: "subagent",
    accountId: "ops",
    conversationId: "$thread",
    parentConversationId: ROOM_ID,
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
    threadId: string;
    expectsCompletionMessage: boolean;
  }> = {},
) {
  const requesterOrigin: { channel: string; accountId?: string; threadId?: string } = {
    channel: overrides.channel ?? "matrix",
  };
  if (!("accountId" in overrides) || overrides.accountId !== undefined) {
    requesterOrigin.accountId = overrides.accountId ?? "ops";
  }
  if (overrides.threadId !== undefined) {
    requesterOrigin.threadId = overrides.threadId;
  }
  return {
    childSessionKey: overrides.childSessionKey ?? CHILD_SESSION_KEY,
    requesterOrigin,
    expectsCompletionMessage: overrides.expectsCompletionMessage ?? true,
  };
}

describe("matrix subagent hook registration", () => {
  beforeEach(() => {
    listBindingsForAccountMock.mockReset();
  });

  it("resolves delivery targets through the lazy registration barrel", async () => {
    listBindingsForAccountMock.mockReturnValue([makeBinding()]);
    const handlers = registerHookHandlersForTest<MatrixEntryPluginApi>({
      config: {},
      register: registerMatrixSubagentHooks,
    });
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(handler(makeDeliveryEvent(), {})).resolves.toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: `room:${ROOM_ID}`,
        threadId: "$thread",
      },
    });
  });
});

describe("handleMatrixSubagentDeliveryTarget", () => {
  beforeEach(() => {
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
  });

  it("returns undefined when completion delivery is not requested", () => {
    expect(
      handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ expectsCompletionMessage: false })),
    ).toBeUndefined();
  });

  it("returns undefined for another channel or a missing binding", () => {
    expect(
      handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ channel: "discord" })),
    ).toBeUndefined();
    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent())).toBeUndefined();
  });

  it("returns the bound Matrix room and thread", () => {
    listBindingsForAccountMock.mockReturnValue([makeBinding()]);

    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent())).toEqual({
      origin: {
        channel: "matrix",
        accountId: "ops",
        to: `room:${ROOM_ID}`,
        threadId: "$thread",
      },
    });
  });

  it("omits threadId for a top-level room binding", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: ROOM_ID, parentConversationId: ROOM_ID }),
    ]);

    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent())).toEqual({
      origin: { channel: "matrix", accountId: "ops", to: `room:${ROOM_ID}` },
    });
  });

  it("fails closed when multiple bindings do not match the requester thread", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$thread-1" }),
      makeBinding({ conversationId: "$thread-2" }),
    ]);

    expect(
      handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ threadId: "$other" })),
    ).toBeUndefined();
  });

  it("scans all bindings when requester accountId is absent", () => {
    listAllBindingsMock.mockReturnValue([makeBinding()]);

    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ accountId: undefined }))).toEqual(
      {
        origin: {
          channel: "matrix",
          accountId: "ops",
          to: `room:${ROOM_ID}`,
          threadId: "$thread",
        },
      },
    );
    expect(listAllBindingsMock).toHaveBeenCalledTimes(1);
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
  });
});

describe("handleMatrixSubagentEnded", () => {
  beforeEach(() => {
    unbindMock.mockReset();
    getManagerMock.mockReset();
    listAllBindingsMock.mockReset();
    listBindingsForAccountMock.mockReset();
    removeBindingRecordMock.mockReset();
  });

  it("removes matching bindings and persists each affected account once", async () => {
    const persist = vi.fn(async () => {});
    listBindingsForAccountMock.mockReturnValue([
      makeBinding(),
      makeBinding({ targetSessionKey: "agent:ops:subagent:other" }),
    ]);
    removeBindingRecordMock.mockReturnValue(true);
    getManagerMock.mockReturnValue({ persist });

    await handleMatrixSubagentEnded({
      targetSessionKey: CHILD_SESSION_KEY,
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(removeBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("uses the binding service for requested farewell cleanup", async () => {
    const binding = makeBinding();
    listBindingsForAccountMock.mockReturnValue([binding]);
    unbindMock.mockResolvedValue([{ ...binding, bindingId: "ops:!room:example:$thread" }]);

    await handleMatrixSubagentEnded({
      targetSessionKey: CHILD_SESSION_KEY,
      targetKind: "subagent",
      accountId: "ops",
      reason: "subagent-complete",
      sendFarewell: true,
    });

    expect(unbindMock).toHaveBeenCalledWith({
      bindingId: "ops:!room:example:$thread",
      reason: "subagent-complete",
      scope: { channel: "matrix", accountId: "ops" },
    });
    expect(removeBindingRecordMock).not.toHaveBeenCalled();
  });
});
