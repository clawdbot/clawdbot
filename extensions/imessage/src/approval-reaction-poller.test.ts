// Imessage tests cover approval reaction poller plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pollPendingIMessageApprovalReactions } from "./approval-reaction-poller.js";
import {
  clearIMessageApprovalReactionTargetsForTest,
  registerIMessageApprovalReactionTarget as registerIMessageApprovalReactionTargetRaw,
} from "./approval-reactions.js";
import type { IMessageRpcClient } from "./client.js";

const resolverMocks = vi.hoisted(() => ({
  resolveIMessageApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

type IMessageTargetParams = Parameters<typeof registerIMessageApprovalReactionTargetRaw>[0];
const registerIMessageApprovalReactionTarget = (
  params: Omit<IMessageTargetParams, "approvalKind">,
) => registerIMessageApprovalReactionTargetRaw({ ...params, approvalKind: "exec" });

vi.mock("./approval-resolver.js", () => ({
  resolveIMessageApproval: resolverMocks.resolveIMessageApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

function createClient(request: ReturnType<typeof vi.fn>): IMessageRpcClient {
  return { request } as unknown as IMessageRpcClient;
}

function createRpcRequest(messages: unknown[], chatIds?: number[]) {
  return vi.fn(async (method: string) => {
    if (method === "chats.list" && chatIds) {
      return { chats: chatIds.map((id) => ({ id })) };
    }
    if (method === "messages.history") {
      return { messages };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

const APPROVER = "+15551230000";
const DEFAULT_CHAT_ID = 42;

function buildApprovalConfig(approver = APPROVER) {
  return { channels: { imessage: { allowFrom: [approver] } } };
}

function buildReaction(
  overrides: Partial<{
    id: number;
    sender: string;
    is_from_me: boolean;
    type: string;
    emoji: string;
    created_at: string;
  }> = {},
) {
  return {
    id: 7,
    sender: APPROVER,
    type: "like",
    emoji: "👍",
    created_at: "2026-05-27T21:00:00.000Z",
    ...overrides,
  };
}

function buildApprovalMessage(
  overrides: Partial<{
    guid: string;
    chat_id: number;
    chat_guid: string;
    chat_identifier: string | undefined;
    is_group: boolean;
    is_from_me: boolean;
    sender: string | undefined;
    text: string;
    reactions: ReturnType<typeof buildReaction>[];
  }> = {},
) {
  return {
    guid: "msg-1",
    chat_id: DEFAULT_CHAT_ID,
    chat_guid: `SMS;-;${APPROVER}`,
    chat_identifier: APPROVER,
    is_from_me: true,
    sender: APPROVER,
    text: [
      "Exec approval required",
      "ID: exec-1",
      "",
      "Reply with: /approve exec-1 allow-once|deny",
    ].join("\n"),
    reactions: [buildReaction({ is_from_me: true })],
    ...overrides,
  };
}

describe("iMessage approval reaction poller", () => {
  let accountSequence = 0;
  let accountId = "";

  type PollParams = Parameters<typeof pollPendingIMessageApprovalReactions>[0];

  function buildPollParams(
    request: ReturnType<typeof vi.fn>,
    overrides: Partial<Omit<PollParams, "client" | "accountId">> = {},
  ): PollParams {
    return {
      client: createClient(request),
      cfg: buildApprovalConfig(),
      accountId,
      ...overrides,
    };
  }

  function registerTarget(
    overrides: Partial<Omit<IMessageTargetParams, "accountId" | "approvalKind">> = {},
  ) {
    return registerIMessageApprovalReactionTarget({
      accountId,
      conversation: { chatId: DEFAULT_CHAT_ID, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
      ...overrides,
    });
  }

  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    accountSequence += 1;
    accountId = `test-${accountSequence}`;
    resolverMocks.resolveIMessageApproval.mockReset();
    resolverMocks.resolveIMessageApproval.mockImplementation(
      async ({ decision }: { decision: "allow-once" | "allow-always" | "deny" }) => ({
        applied: true,
        approval:
          decision === "deny"
            ? { status: "denied", decision, reason: "user" }
            : { status: "allowed", decision, reason: "user" },
      }),
    );
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("does not scan recent chats during fast polling with no pending targets", async () => {
    const request = vi.fn();

    await pollPendingIMessageApprovalReactions(buildPollParams(request));

    expect(request).not.toHaveBeenCalled();
  });

  it("does not scan recent chats during fast polling for handle-only targets", async () => {
    registerTarget({
      conversation: { handle: "+15551230000" },
    });
    const request = vi.fn();

    await pollPendingIMessageApprovalReactions(buildPollParams(request));

    expect(request).not.toHaveBeenCalled();
  });

  it("discovers observed approval prompts on the bounded recent-chat path", async () => {
    const request = createRpcRequest([buildApprovalMessage()], [42]);

    await pollPendingIMessageApprovalReactions(
      buildPollParams(request, { allowRecentChatDiscovery: true }),
    );

    expect(request).toHaveBeenCalledWith("chats.list", { limit: 50 }, { timeoutMs: 10_000 });
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: buildApprovalConfig(),
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("bounds no-target recent-chat discovery to one pass per account", async () => {
    const request = createRpcRequest([], [42]);

    const pollParams = buildPollParams(request, { allowRecentChatDiscovery: true });

    await pollPendingIMessageApprovalReactions(pollParams);
    await pollPendingIMessageApprovalReactions(pollParams);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("chats.list", { limit: 50 }, { timeoutMs: 10_000 });
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 42, limit: 30 },
      { timeoutMs: 10_000 },
    );
  });

  it("bounds no-target discovery after resolving an observed reaction", async () => {
    const request = vi.fn(async (method: string, payload?: { chat_id?: number }) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }, { id: 99 }] };
      }
      if (method === "messages.history" && payload?.chat_id === 42) {
        return { messages: [buildApprovalMessage()] };
      }
      if (method === "messages.history" && payload?.chat_id === 99) {
        return { messages: [] };
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(payload)}`);
    });

    const pollParams = buildPollParams(request, { allowRecentChatDiscovery: true });

    await pollPendingIMessageApprovalReactions(pollParams);
    await pollPendingIMessageApprovalReactions(pollParams);

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "messages.history")).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 99, limit: 30 },
      { timeoutMs: 10_000 },
    );
  });

  it("retries no-target discovery after resolver failures expire observed targets", async () => {
    resolverMocks.resolveIMessageApproval.mockRejectedValue(new Error("gateway down"));
    const request = createRpcRequest([buildApprovalMessage()], [42]);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    try {
      const pollParams = buildPollParams(request, { allowRecentChatDiscovery: true });

      await pollPendingIMessageApprovalReactions(pollParams);
      dateNow.mockReturnValue(1_800_000_301_000);
      await pollPendingIMessageApprovalReactions(pollParams);
    } finally {
      dateNow.mockRestore();
    }

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(2);
  });

  [
    {
      title: "retries no-target recent-chat discovery after the first chat list fails",
      failingMethod: "chats.list",
      errorMessage: "temporary imsg failure",
      pollCount: 2,
      expectFirstPollToReject: true,
      expectedChatLists: 2,
      expectedHistories: 1,
    },
    {
      title: "retries no-target recent-chat discovery after the first history fetch fails",
      failingMethod: "messages.history",
      errorMessage: "temporary history failure",
      pollCount: 3,
      expectFirstPollToReject: false,
      expectedChatLists: 2,
      expectedHistories: 2,
    },
  ].forEach((testCase) => {
    it(testCase.title, async () => {
      const request = vi.fn(async (method: string) => {
        if (method === "chats.list") {
          if (testCase.failingMethod !== method) {
            return { chats: [{ id: 42 }] };
          }
        }
        if (method !== "chats.list" && method !== "messages.history") {
          throw new Error(`unexpected method ${method}`);
        }
        const methodCalls = request.mock.calls.filter(([calledMethod]) => calledMethod === method);
        if (testCase.failingMethod === method && methodCalls.length === 1) {
          throw new Error(testCase.errorMessage);
        }
        return method === "chats.list" ? { chats: [{ id: 42 }] } : { messages: [] };
      });

      const pollParams = buildPollParams(request, { allowRecentChatDiscovery: true });
      const poll = () => pollPendingIMessageApprovalReactions(pollParams);

      if (testCase.expectFirstPollToReject) {
        await expect(poll()).rejects.toThrow(testCase.errorMessage);
      } else {
        await poll();
      }
      for (let index = 1; index < testCase.pollCount; index += 1) {
        await poll();
      }

      expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(
        testCase.expectedChatLists,
      );
      expect(request.mock.calls.filter(([method]) => method === "messages.history")).toHaveLength(
        testCase.expectedHistories,
      );
    });
  });

  it("does not bind observed approval prompts when the process clock is invalid", async () => {
    const request = createRpcRequest(
      [buildApprovalMessage({ text: "Exec approval required\nID: exec-1" })],
      [42],
    );
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    try {
      await pollPendingIMessageApprovalReactions(
        buildPollParams(request, { allowRecentChatDiscovery: true }),
      );
    } finally {
      dateNow.mockRestore();
    }

    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });

  it("uses learned chat ids for fast scoped polling after discovery", async () => {
    registerTarget({
      conversation: { handle: "+15551230000" },
    });
    registerTarget({
      conversation: { chatId: 42, chatGuid: "SMS;-;+15551230000" },
    });
    const request = createRpcRequest([]);

    await pollPendingIMessageApprovalReactions(buildPollParams(request));

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 42, limit: 30 },
      { timeoutMs: 10_000 },
    );
  });

  it("includes recent chats during discovery when scoped and unscoped targets are pending", async () => {
    registerTarget({
      conversation: { chatId: 42, chatGuid: "SMS;-;+15551230000" },
      messageId: "msg-scoped",
      approvalId: "exec-scoped",
    });
    registerTarget({
      conversation: { handle: "+15551239999" },
      messageId: "msg-handle",
      approvalId: "exec-handle",
    });
    const request = vi.fn(async (method: string, payload?: { chat_id?: number }) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }, { id: 99 }] };
      }
      if (method === "messages.history" && payload?.chat_id === 42) {
        return { messages: [] };
      }
      if (method === "messages.history" && payload?.chat_id === 99) {
        return {
          messages: [
            buildApprovalMessage({
              guid: "msg-handle",
              chat_id: 99,
              chat_guid: "SMS;-;+15551239999",
              chat_identifier: "+15551239999",
              sender: "+15551239999",
              text: "Exec approval required\nID: exec-handle",
              reactions: [
                buildReaction({
                  id: 8,
                  sender: "+15551239999",
                  is_from_me: true,
                  created_at: "2026-05-27T21:01:00.000Z",
                }),
              ],
            }),
          ],
        };
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(payload)}`);
    });

    await pollPendingIMessageApprovalReactions(
      buildPollParams(request, {
        cfg: buildApprovalConfig("+15551239999"),
        allowRecentChatDiscovery: true,
      }),
    );

    expect(request).toHaveBeenCalledWith("chats.list", { limit: 50 }, { timeoutMs: 10_000 });
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 42, limit: 30 },
      { timeoutMs: 10_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 99, limit: 30 },
      { timeoutMs: 10_000 },
    );
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: buildApprovalConfig("+15551239999"),
      approvalId: "exec-handle",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551239999",
      gatewayUrl: undefined,
    });
  });

  it("continues scanning after an unauthorized reaction leaves the approval pending", async () => {
    registerIMessageApprovalReactionTarget({
      accountId,
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = createRpcRequest([
      buildApprovalMessage({
        guid: "msg-1",
        chat_id: 42,
        chat_guid: "iMessage;+;chat-guid",
        chat_identifier: undefined,
        is_group: true,
        is_from_me: true,
        sender: undefined,
        text: "Exec approval required\nID: exec-1",
        reactions: [
          buildReaction({
            id: 8,
            sender: "+15550000000",
            created_at: "2026-05-27T21:01:00.000Z",
          }),
          buildReaction({
            id: 9,
            sender: "+15551230000",
            created_at: "2026-05-27T21:02:00.000Z",
          }),
        ],
      }),
    ]);

    await pollPendingIMessageApprovalReactions(
      buildPollParams(request, { cfg: buildApprovalConfig(APPROVER) }),
    );

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: buildApprovalConfig(APPROVER),
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("stops polling after another surface records the canonical winner", async () => {
    resolverMocks.resolveIMessageApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    registerIMessageApprovalReactionTarget({
      accountId,
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = createRpcRequest([
      buildApprovalMessage({
        guid: "msg-1",
        chat_id: 42,
        chat_guid: "iMessage;+;chat-guid",
        chat_identifier: undefined,
        is_group: true,
        is_from_me: true,
        sender: undefined,
        text: "Exec approval required\nID: exec-1",
        reactions: [
          buildReaction({
            id: 8,
            sender: "+15551230000",
            created_at: "2026-05-27T21:01:00.000Z",
          }),
          buildReaction({
            id: 9,
            sender: "+15551230000",
            type: "dislike",
            emoji: "👎",
            created_at: "2026-05-27T21:02:00.000Z",
          }),
        ],
      }),
    ]);
    const logVerboseMessage = vi.fn();
    const pollParams = buildPollParams(request, {
      cfg: buildApprovalConfig(APPROVER),
      logVerboseMessage,
    });

    await pollPendingIMessageApprovalReactions(pollParams);
    await pollPendingIMessageApprovalReactions(pollParams);

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "imessage: approval reaction already resolved id=exec-1 sender=+15551230000 status=denied decision=deny reason=user via messageId=msg-1",
    );
    expect(logVerboseMessage.mock.calls.flat().join(" ")).not.toContain("decision=allow-once");
  });

  it("stops scanning after an authorized resolver failure", async () => {
    resolverMocks.resolveIMessageApproval.mockRejectedValueOnce(new Error("gateway down"));
    registerIMessageApprovalReactionTarget({
      accountId,
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = createRpcRequest([
      buildApprovalMessage({
        guid: "msg-1",
        chat_id: 42,
        chat_guid: "iMessage;+;chat-guid",
        chat_identifier: undefined,
        is_group: true,
        is_from_me: true,
        sender: undefined,
        text: "Exec approval required\nID: exec-1",
        reactions: [
          buildReaction({
            id: 8,
            sender: "+15551230000",
            created_at: "2026-05-27T21:01:00.000Z",
          }),
          buildReaction({
            id: 9,
            sender: "+15551230000",
            type: "dislike",
            emoji: "👎",
            created_at: "2026-05-27T21:02:00.000Z",
          }),
        ],
      }),
    ]);

    await pollPendingIMessageApprovalReactions(
      buildPollParams(request, { cfg: buildApprovalConfig(APPROVER) }),
    );

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: buildApprovalConfig(APPROVER),
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });
});
