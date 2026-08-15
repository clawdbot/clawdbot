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
  waitForTelegramPollRetryDelay: vi.fn(),
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
  waitForTelegramPollRetryDelay: mocks.waitForTelegramPollRetryDelay,
  waitForTelegramChannelRunning: mocks.waitForTelegramChannelRunning,
}));

import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";
import { TelegramQaApiError } from "./telegram-api.runtime.js";

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
    mocks.waitForTelegramPollRetryDelay.mockResolvedValue(undefined);
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

  it("surfaces a duplicate getUpdates conflict without retrying it", async () => {
    let getMeCalls = 0;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return getMeCalls === 1
          ? { id: 1, is_bot: true, first_name: "driver", username: "driver_bot" }
          : { id: 2, is_bot: true, first_name: "sut", username: "sut_bot" };
      }
      throw new TelegramQaApiError(
        "getUpdates",
        409,
        "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        undefined,
        409,
      );
    });

    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);

    await vi.waitFor(() => expect(() => adapter.assertTransportHealthy?.()).toThrow(/Conflict/u));
    expect(
      mocks.callTelegramApi.mock.calls.filter(([, method]) => method === "getUpdates"),
    ).toHaveLength(1);
    const diagnostics = adapter.describeTransportState?.() ?? "";
    expect(diagnostics).toContain("polls=1");
    expect(diagnostics).toContain(
      "terminal error={name=TelegramQaApiError,method=getUpdates,error_code=409,status=409}",
    );
    expect(diagnostics).not.toContain("placeholder");
    expect(diagnostics).not.toContain("-100123");

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("backs off consecutive observer failures and resets after a successful poll", async () => {
    let resolveTerminalPoll: ((updates: unknown[]) => void) | undefined;
    const terminalPoll = new Promise<unknown[]>((resolve) => {
      resolveTerminalPoll = resolve;
    });
    const failures = [
      new TelegramQaApiError("getUpdates", 502, "Bad Gateway", undefined, 502),
      new Error("fetch failed"),
      new TelegramQaApiError("getUpdates", 500, "Server Error", undefined, 500),
    ] as const;
    let getMeCalls = 0;
    let pollCalls = 0;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return getMeCalls === 1
          ? { id: 1, is_bot: true, first_name: "driver", username: "driver_bot" }
          : { id: 2, is_bot: true, first_name: "sut", username: "sut_bot" };
      }
      pollCalls += 1;
      if (pollCalls === 1) {
        throw failures[0];
      }
      if (pollCalls === 2) {
        throw failures[1];
      }
      if (pollCalls === 3) {
        return [];
      }
      if (pollCalls === 4) {
        throw failures[2];
      }
      return await terminalPoll;
    });

    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);

    await vi.waitFor(() => expect(mocks.waitForTelegramPollRetryDelay).toHaveBeenCalledTimes(3));
    expect(mocks.waitForTelegramPollRetryDelay.mock.calls).toEqual([
      [failures[0], 1, expect.any(AbortSignal)],
      [failures[1], 2, expect.any(AbortSignal)],
      [failures[2], 1, expect.any(AbortSignal)],
    ]);

    const cleanup = adapter.cleanup?.();
    resolveTerminalPoll?.([]);
    await cleanup;
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("aborts an observer retry delay during cleanup", async () => {
    let getMeCalls = 0;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return getMeCalls === 1
          ? { id: 1, is_bot: true, first_name: "driver", username: "driver_bot" }
          : { id: 2, is_bot: true, first_name: "sut", username: "sut_bot" };
      }
      throw new Error("fetch failed");
    });
    mocks.waitForTelegramPollRetryDelay.mockImplementation(
      async (_error: unknown, _attempt: number, signal: AbortSignal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);
    await vi.waitFor(() => expect(mocks.waitForTelegramPollRetryDelay).toHaveBeenCalledOnce());
    const signal = mocks.waitForTelegramPollRetryDelay.mock.calls[0]?.[2] as AbortSignal;

    await adapter.cleanup?.();

    expect(signal.aborted).toBe(true);
    expect(() => adapter.assertTransportHealthy?.()).not.toThrow();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("summarizes matched and filtered update kinds without native identifiers", async () => {
    const pollResolvers: Array<(updates: unknown[]) => void> = [];
    let getMeCalls = 0;
    mocks.callTelegramApi.mockImplementation(async (_token: string, method: string) => {
      if (method === "getMe") {
        getMeCalls += 1;
        return getMeCalls === 1
          ? { id: 1, is_bot: true, first_name: "driver", username: "driver_bot" }
          : { id: 2, is_bot: true, first_name: "sut", username: "sut_bot" };
      }
      if (method === "getUpdates") {
        return await new Promise<unknown[]>((resolve) => {
          pollResolvers.push(resolve);
        });
      }
      throw new Error(`unexpected Telegram API method: ${method}`);
    });
    const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {
        addOutboundMessage,
        editMessage: vi.fn(),
      },
    } as never);

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));
    pollResolvers[0]?.([
      { update_id: 101 },
      {
        update_id: 102,
        message: {
          message_id: 201,
          date: 100,
          chat: { id: -100999 },
          from: { id: 2, is_bot: true },
          text: "wrong chat",
        },
      },
      {
        update_id: 103,
        message: {
          message_id: 202,
          date: 100,
          chat: { id: -100123 },
          from: { id: 3, is_bot: true },
          text: "wrong sender",
        },
      },
      {
        update_id: 104,
        edited_message: {
          message_id: 203,
          date: 100,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true },
          text: "private matched content",
        },
      },
    ]);
    await vi.waitFor(() => expect(addOutboundMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(2));

    const diagnostics = adapter.describeTransportState?.() ?? "";
    expect(diagnostics).toContain("polls=2");
    expect(diagnostics).toContain("updates=4");
    expect(diagnostics).toContain("filtered=3");
    expect(diagnostics).toContain("matched=1");
    expect(diagnostics).toContain("update kinds=[other,message,edited_message]");
    expect(diagnostics).not.toMatch(
      /-100123|10[1-4]|20[1-3]|wrong chat|wrong sender|private matched content/u,
    );

    const cleanup = adapter.cleanup?.();
    pollResolvers[1]?.([]);
    await cleanup;
    await adapter.cleanupAfterGatewayStop?.();
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
            : { id: 2, is_bot: true, first_name: "sut", username: "openclaw_qa_bot" };
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
      adapterOptions: {
        sutAccountId: "sut",
        transportPolicy: { requireGroupMention: true },
      },
      messages: { addInboundMessage, addOutboundMessage, editMessage },
    } as never);

    expect(adapter.createGatewayConfig?.({ baseUrl: "http://127.0.0.1:1234" })).toMatchObject({
      channels: {
        telegram: {
          accounts: {
            sut: {
              groups: {
                "-100123": {
                  requireMention: true,
                },
              },
            },
          },
        },
      },
    });

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
        text: "@openclaw_qa_bot reply exactly: QA-MARKER",
      }),
    );
    await adapter.sendInbound?.({
      conversation: { id: "logical-room", kind: "group" },
      senderId: "driver",
      text: "/status",
      nativeCommand: { name: "status" },
    });
    expect(mocks.callTelegramApi).toHaveBeenCalledWith(
      "placeholder",
      "sendMessage",
      expect.objectContaining({
        chat_id: "-100123",
        text: "/status@openclaw_qa_bot",
      }),
    );

    pollResolvers[0]?.([
      {
        update_id: 1,
        message: {
          message_id: 11,
          date: 100,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "openclaw_qa_bot" },
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
          from: { id: 2, is_bot: true, username: "openclaw_qa_bot" },
          text: "final",
        },
      },
    ]);
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledOnce());
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "out-1", text: "final", timestamp: 101_000 }),
    );

    await adapter.resetTransport?.();
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(3));
    await adapter.sendInbound?.({
      conversation: { id: "next-room", kind: "group" },
      senderId: "driver",
      text: "next",
    });
    pollResolvers[2]?.([
      {
        update_id: 3,
        edited_message: {
          message_id: 13,
          date: 102,
          chat: { id: -100123 },
          from: { id: 2, is_bot: true, username: "openclaw_qa_bot" },
          text: "orphan final",
        },
      },
    ]);
    await vi.waitFor(() => expect(addOutboundMessage).toHaveBeenCalledTimes(2));
    expect(addOutboundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "group:next-room",
        text: "orphan final",
        timestamp: 102_000,
      }),
    );

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(4));
    mocks.heartbeatStop.mockRejectedValueOnce(new Error("heartbeat stop failed"));
    const cleanup = adapter.cleanup?.();
    pollResolvers[3]?.([]);
    await cleanup;
    expect(mocks.shouldRetainQaGatewayCredentialLease).not.toHaveBeenCalled();
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow("heartbeat stop failed");
    expect(mocks.shouldRetainQaGatewayCredentialLease).toHaveBeenCalledOnce();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });
});
