// Imessage tests cover approval reaction poller plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionPollerStateForTest,
  pollPendingIMessageApprovalReactions,
} from "./approval-reaction-poller.js";
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

describe("iMessage approval reaction poller", () => {
  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    clearIMessageApprovalReactionPollerStateForTest();
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

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("does not scan recent chats during fast polling for handle-only targets", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = vi.fn();

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("discovers observed approval prompts on the bounded recent-chat path", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "SMS;-;+15551230000",
              chat_identifier: "+15551230000",
              is_from_me: true,
              sender: "+15551230000",
              text: [
                "Exec approval required",
                "ID: exec-1",
                "",
                "Reply with: /approve exec-1 allow-once|deny",
              ].join("\n"),
              reactions: [
                {
                  id: 7,
                  sender: "+15551230000",
                  is_from_me: true,
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:00:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    });

    expect(request).toHaveBeenCalledWith("chats.list", { limit: 50 }, { timeoutMs: 10_000 });
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("bounds no-target recent-chat discovery to one pass per account", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const pollParams = {
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    };

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
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "SMS;-;+15551230000",
              chat_identifier: "+15551230000",
              is_from_me: true,
              sender: "+15551230000",
              text: [
                "Exec approval required",
                "ID: exec-1",
                "",
                "Reply with: /approve exec-1 allow-once|deny",
              ].join("\n"),
              reactions: [
                {
                  id: 7,
                  sender: "+15551230000",
                  is_from_me: true,
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:00:00.000Z",
                },
              ],
            },
          ],
        };
      }
      if (method === "messages.history" && payload?.chat_id === 99) {
        return { messages: [] };
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(payload)}`);
    });

    const pollParams = {
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    };

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
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "SMS;-;+15551230000",
              chat_identifier: "+15551230000",
              is_from_me: true,
              sender: "+15551230000",
              text: [
                "Exec approval required",
                "ID: exec-1",
                "",
                "Reply with: /approve exec-1 allow-once|deny",
              ].join("\n"),
              reactions: [
                {
                  id: 7,
                  sender: "+15551230000",
                  is_from_me: true,
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:00:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    try {
      const pollParams = {
        client: createClient(request),
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        accountId: "default",
        allowRecentChatDiscovery: true,
      };

      await pollPendingIMessageApprovalReactions(pollParams);
      dateNow.mockReturnValue(1_800_000_301_000);
      await pollPendingIMessageApprovalReactions(pollParams);
    } finally {
      dateNow.mockRestore();
    }

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(2);
  });

  it("retries no-target recent-chat discovery after the first chat list fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        const chatListCalls = request.mock.calls.filter(
          ([calledMethod]) => calledMethod === "chats.list",
        );
        if (chatListCalls.length === 1) {
          throw new Error("temporary imsg failure");
        }
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const pollParams = {
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    };

    await expect(pollPendingIMessageApprovalReactions(pollParams)).rejects.toThrow(
      "temporary imsg failure",
    );
    await pollPendingIMessageApprovalReactions(pollParams);

    expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "messages.history")).toHaveLength(1);
  });

  it("retries no-target recent-chat discovery after the first history fetch fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        const historyCalls = request.mock.calls.filter(
          ([calledMethod]) => calledMethod === "messages.history",
        );
        if (historyCalls.length === 1) {
          throw new Error("temporary history failure");
        }
        return { messages: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const pollParams = {
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    };

    await pollPendingIMessageApprovalReactions(pollParams);
    await pollPendingIMessageApprovalReactions(pollParams);
    await pollPendingIMessageApprovalReactions(pollParams);

    expect(request.mock.calls.filter(([method]) => method === "chats.list")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "messages.history")).toHaveLength(2);
  });

  it("does not bind observed approval prompts when the process clock is invalid", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chats.list") {
        return { chats: [{ id: 42 }] };
      }
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "SMS;-;+15551230000",
              chat_identifier: "+15551230000",
              is_from_me: true,
              sender: "+15551230000",
              text: "Exec approval required\nID: exec-1",
              reactions: [
                {
                  id: 7,
                  sender: "+15551230000",
                  is_from_me: true,
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:00:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);

    try {
      await pollPendingIMessageApprovalReactions({
        client: createClient(request),
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        accountId: "default",
        allowRecentChatDiscovery: true,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });

  it("uses learned chat ids for fast scoped polling after discovery", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatId: 42, chatGuid: "SMS;-;+15551230000" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "messages.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "messages.history",
      { chat_id: 42, limit: 30 },
      { timeoutMs: 10_000 },
    );
  });

  it("includes recent chats during discovery when scoped and unscoped targets are pending", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatId: 42, chatGuid: "SMS;-;+15551230000" },
      messageId: "msg-scoped",
      approvalId: "exec-scoped",
      allowedDecisions: ["allow-once", "deny"],
    });
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551239999" },
      messageId: "msg-handle",
      approvalId: "exec-handle",
      allowedDecisions: ["allow-once", "deny"],
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
            {
              guid: "msg-handle",
              chat_id: 99,
              chat_guid: "SMS;-;+15551239999",
              chat_identifier: "+15551239999",
              is_from_me: true,
              sender: "+15551239999",
              text: "Exec approval required\nID: exec-handle",
              reactions: [
                {
                  id: 8,
                  sender: "+15551239999",
                  is_from_me: true,
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:01:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected request ${method} ${JSON.stringify(payload)}`);
    });

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551239999"] } } },
      accountId: "default",
      allowRecentChatDiscovery: true,
    });

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
      cfg: { channels: { imessage: { allowFrom: ["+15551239999"] } } },
      approvalId: "exec-handle",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551239999",
      gatewayUrl: undefined,
    });
  });

  it("continues scanning after an unauthorized reaction leaves the approval pending", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "iMessage;+;chat-guid",
              is_group: true,
              is_from_me: true,
              text: "Exec approval required\nID: exec-1",
              reactions: [
                {
                  id: 8,
                  sender: "+15550000000",
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:01:00.000Z",
                },
                {
                  id: 9,
                  sender: "+15551230000",
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:02:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
    });

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
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
      accountId: "default",
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "iMessage;+;chat-guid",
              is_group: true,
              is_from_me: true,
              text: "Exec approval required\nID: exec-1",
              reactions: [
                {
                  id: 8,
                  sender: "+15551230000",
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:01:00.000Z",
                },
                {
                  id: 9,
                  sender: "+15551230000",
                  type: "dislike",
                  emoji: "👎",
                  created_at: "2026-05-27T21:02:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const logVerboseMessage = vi.fn();
    const pollParams = {
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      logVerboseMessage,
    };

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
      accountId: "default",
      conversation: { chatId: 42, chatGuid: "iMessage;+;chat-guid" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    const request = vi.fn(async (method: string) => {
      if (method === "messages.history") {
        return {
          messages: [
            {
              guid: "msg-1",
              chat_id: 42,
              chat_guid: "iMessage;+;chat-guid",
              is_group: true,
              is_from_me: true,
              text: "Exec approval required\nID: exec-1",
              reactions: [
                {
                  id: 8,
                  sender: "+15551230000",
                  type: "like",
                  emoji: "👍",
                  created_at: "2026-05-27T21:01:00.000Z",
                },
                {
                  id: 9,
                  sender: "+15551230000",
                  type: "dislike",
                  emoji: "👎",
                  created_at: "2026-05-27T21:02:00.000Z",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await pollPendingIMessageApprovalReactions({
      client: createClient(request),
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
    });

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });
});
