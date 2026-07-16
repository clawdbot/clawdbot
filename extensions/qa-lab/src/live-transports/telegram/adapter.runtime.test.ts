import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  assertQaGatewayCredentialLeaseQuarantine: vi.fn(),
  callTelegramApi: vi.fn(),
  flushTelegramUpdates: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseHeartbeat: vi.fn(),
  leaseRelease: vi.fn(),
  shouldRetainQaGatewayCredentialLease: vi.fn(),
  waitForTelegramChannelRunning: vi.fn(),
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
  }),
}));

vi.mock("../../gateway-process-boundary.js", () => ({
  assertQaGatewayCredentialLeaseQuarantine: mocks.assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease: mocks.shouldRetainQaGatewayCredentialLease,
}));

vi.mock("./telegram-api.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telegram-api.runtime.js")>()),
  callTelegramApi: mocks.callTelegramApi,
  flushTelegramUpdates: mocks.flushTelegramUpdates,
  waitForTelegramChannelRunning: mocks.waitForTelegramChannelRunning,
}));

import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";

describe("Telegram QA transport adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireQaCredentialLease.mockResolvedValue({
      payload: {
        groupId: "-100123",
        driverToken: "placeholder",
        sutToken: "placeholder",
      },
      source: "env",
      heartbeat: mocks.leaseHeartbeat,
      release: mocks.leaseRelease,
    });
    mocks.flushTelegramUpdates.mockResolvedValue(0);
    mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValue(false);
  });

  it("rejects credentials that do not identify two distinct bots", async () => {
    mocks.callTelegramApi.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "bot",
      username: "same_bot",
    });

    await expect(
      createTelegramQaTransportAdapter({ adapterOptions: {}, messages: {} } as never),
    ).rejects.toThrow("requires two distinct bots");
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
    expect(mocks.flushTelegramUpdates).not.toHaveBeenCalled();
  });

  it("maps native sends, replies, edits, and cleanup inside the adapter", async () => {
    const pollResolvers: Array<(updates: unknown[]) => void> = [];
    let getMeCalls = 0;
    let sendMessageCalls = 0;
    mocks.callTelegramApi.mockImplementation(
      async (_token: string, method: string): Promise<unknown> => {
        if (method === "getMe") {
          getMeCalls += 1;
          return getMeCalls === 1
            ? { id: 1, is_bot: true, first_name: "driver", username: "driver_bot" }
            : { id: 2, is_bot: true, first_name: "sut", username: "sut_bot" };
        }
        if (method === "sendMessage") {
          sendMessageCalls += 1;
          return { message_id: sendMessageCalls === 1 ? 10 : 12 };
        }
        if (method === "getUpdates") {
          return await new Promise<unknown[]>((resolve) => {
            pollResolvers.push(resolve);
          });
        }
        throw new Error(`unexpected Telegram API method: ${method}`);
      },
    );
    const addInboundMessage = vi.fn().mockResolvedValue({ id: "in-1" });
    const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const editMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: { sutAccountId: "sut" },
      messages: { addInboundMessage, addOutboundMessage, editMessage },
    } as never);

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));
    await adapter.sendInbound?.({
      conversation: { id: "logical-room", kind: "group" },
      senderId: "driver",
      text: "@openclaw reply exactly: QA-MARKER",
    });
    expect(mocks.callTelegramApi).toHaveBeenCalledWith(
      "placeholder",
      "sendMessage",
      expect.objectContaining({
        chat_id: "-100123",
        text: "@sut_bot reply exactly: QA-MARKER",
      }),
    );

    pollResolvers[0]?.([
      {
        update_id: 1,
        message: {
          message_id: 11,
          date: 100,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "sut_bot" },
          text: "preview",
          reply_to_message: { message_id: 10 },
        },
      },
    ]);
    await vi.waitFor(() => expect(addOutboundMessage).toHaveBeenCalledOnce());
    expect(addOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "group:logical-room",
        text: "preview",
        replyToId: "in-1",
      }),
    );
    await adapter.sendInbound?.({
      conversation: { id: "logical-room", kind: "group" },
      senderId: "driver",
      text: "follow-up",
      replyToId: "out-1",
    });
    expect(mocks.callTelegramApi).toHaveBeenCalledWith(
      "placeholder",
      "sendMessage",
      expect.objectContaining({
        reply_parameters: {
          message_id: 11,
          allow_sending_without_reply: true,
        },
      }),
    );

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(2));
    pollResolvers[1]?.([
      {
        update_id: 2,
        edited_message: {
          message_id: 11,
          date: 101,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "sut_bot" },
          text: "final",
        },
      },
    ]);
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledOnce());
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "out-1", text: "final", timestamp: 101_000 }),
    );

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(3));
    const cleanup = adapter.cleanup?.();
    pollResolvers[2]?.([]);
    await cleanup;
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });
});
