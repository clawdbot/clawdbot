import { describe, expect, it, vi } from "vitest";
import {
  createCloseoutTracker,
  type CloseoutRecord,
  type CloseoutTrackerStore,
  type ConversationSend,
} from "./closeout-tracker.js";

function createMemoryStore(): CloseoutTrackerStore & { records: Map<string, CloseoutRecord> } {
  const records = new Map<string, CloseoutRecord>();
  const key = (agentId: string, closeoutId: string) => `${agentId}:${closeoutId}`;
  return {
    records,
    async get(agentId, closeoutId) {
      return records.get(key(agentId, closeoutId));
    },
    async create(record) {
      const recordKey = key(record.agentId, record.closeoutId);
      if (records.has(recordKey)) {
        return false;
      }
      records.set(recordKey, record);
      return true;
    },
    async put(record) {
      records.set(key(record.agentId, record.closeoutId), record);
    },
    async list(agentId, limit) {
      return [...records.values()].filter((record) => record.agentId === agentId).slice(0, limit);
    },
  };
}

const input = {
  closeoutId: "NAC-78",
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "NAC-78 is complete.",
};

describe("closeout tracker", () => {
  it("records one durable operation and confirms a send with a platform message id", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => ({
      status: "sent",
      conversationRef: input.conversationRef,
      channel: "telegram",
      messageId: "telegram-123",
      messageIdSource: "platform",
      queueId: "closeout:NAC-78",
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 1_000 });

    const confirmed = await tracker.send(input);
    const repeated = await tracker.send(input);
    const manualAfterConfirmed = await tracker.confirm(
      "main",
      "NAC-78",
      "redundant evidence",
      "user:kevin",
    );

    expect(confirmed).toMatchObject({
      closeoutId: "NAC-78",
      operationId: "closeout:NAC-78",
      status: "confirmed",
      messageId: "telegram-123",
      queueId: "closeout:NAC-78",
      attemptCount: 1,
    });
    expect(repeated).toEqual(confirmed);
    expect(manualAfterConfirmed).toEqual(confirmed);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      agentId: "main",
      sourceSessionKey: input.sourceSessionKey,
      operationId: "closeout:NAC-78",
      conversationRef: input.conversationRef,
      message: input.message,
    });
  });

  it("reconciles a queued operation by replaying the same idempotent operation id", async () => {
    const store = createMemoryStore();
    const send = vi
      .fn<ConversationSend>()
      .mockResolvedValueOnce({
        status: "queued",
        conversationRef: input.conversationRef,
        channel: "telegram",
        queueId: "queue-1",
      })
      .mockResolvedValueOnce({
        status: "sent",
        conversationRef: input.conversationRef,
        channel: "telegram",
        messageId: "telegram-456",
        messageIdSource: "platform",
        queueId: "queue-1",
      });
    const tracker = createCloseoutTracker({ store, send, now: () => 2_000 });

    const queued = await tracker.send(input);
    const confirmed = await tracker.reconcile("main", "NAC-78");

    expect(queued).toMatchObject({ status: "queued", queueId: "queue-1", attemptCount: 1 });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      messageId: "telegram-456",
      queueId: "queue-1",
      attemptCount: 2,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].operationId).toBe("closeout:NAC-78");
    expect(send.mock.calls[1]?.[0].operationId).toBe("closeout:NAC-78");
  });

  it("fails uncertain, blocks completion, and permits explicit manual confirmation", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => ({
      status: "unknown",
      conversationRef: input.conversationRef,
      channel: "telegram",
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 3_000 });

    const uncertain = await tracker.send(input);

    expect(uncertain).toMatchObject({ status: "uncertain", attemptCount: 1 });
    await expect(tracker.complete("main", "NAC-78")).rejects.toThrow(
      "closeout NAC-78 cannot complete from uncertain",
    );

    const manuallyConfirmed = await tracker.confirm(
      "main",
      "NAC-78",
      "verified Telegram message 789",
      "user:kevin",
    );
    const repeatedManualConfirmation = await tracker.confirm(
      "main",
      "NAC-78",
      "different evidence",
      "user:other",
    );
    const completed = await tracker.complete("main", "NAC-78");

    expect(manuallyConfirmed).toMatchObject({
      status: "manually_confirmed",
      manualEvidence: "verified Telegram message 789",
      manualConfirmedBy: "user:kevin",
      manualConfirmedAt: 3_000,
    });
    expect(repeatedManualConfirmation).toEqual(manuallyConfirmed);
    expect(completed.status).toBe("completed");
  });

  it("marks thrown delivery outcomes uncertain and rejects closeout id reuse with different input", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => {
      const error = new Error("gateway disconnected with token sk-secret");
      error.name = `SensitiveError-${"x".repeat(1_000)}`;
      throw error;
    });
    const tracker = createCloseoutTracker({ store, send, now: () => 4_000 });

    await expect(tracker.send(input)).resolves.toMatchObject({
      status: "uncertain",
      lastError: "gateway_request_failed",
      attemptCount: 1,
    });
    await expect(tracker.send({ ...input, message: "different closeout text" })).rejects.toThrow(
      "closeout NAC-78 was already recorded with different input",
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a sent result uncertain when no observable message id is returned", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => ({
      status: "sent",
      conversationRef: input.conversationRef,
      channel: "telegram",
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 5_000 });

    await expect(tracker.send(input)).resolves.toMatchObject({
      status: "uncertain",
      lastError: "delivery reported sent without a platform receipt",
    });
    await expect(tracker.complete("main", "NAC-78")).rejects.toThrow(
      "closeout NAC-78 cannot complete from uncertain",
    );
  });

  it("keeps a prepared local id uncertain because it is not a platform receipt", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => ({
      status: "sent",
      conversationRef: input.conversationRef,
      channel: "telegram",
      messageId: "prepared-local-1",
      messageIdSource: "prepared" as const,
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 5_100 });

    await expect(tracker.send(input)).resolves.toMatchObject({
      status: "uncertain",
      messageId: "prepared-local-1",
      lastError: "delivery reported sent without a platform receipt",
    });
    await expect(tracker.complete("main", "NAC-78")).rejects.toThrow(
      "closeout NAC-78 cannot complete from uncertain",
    );
  });

  it("serializes delivery and manual confirmation so a stale send cannot regress evidence", async () => {
    const store = createMemoryStore();
    let finishSend: ((result: Awaited<ReturnType<ConversationSend>>) => void) | undefined;
    const send = vi.fn<ConversationSend>(
      async () =>
        await new Promise((resolve) => {
          finishSend = resolve;
        }),
    );
    const tracker = createCloseoutTracker({ store, send, now: () => 5_250 });

    const sending = tracker.send(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const confirming = tracker.confirm(
      "main",
      "NAC-78",
      "verified Telegram message 789",
      "user:kevin",
    );
    finishSend?.({
      status: "unknown",
      conversationRef: input.conversationRef,
      channel: "telegram",
    });

    await expect(sending).resolves.toMatchObject({ status: "uncertain" });
    await expect(confirming).resolves.toMatchObject({ status: "manually_confirmed" });
    await expect(tracker.get("main", "NAC-78")).resolves.toMatchObject({
      status: "manually_confirmed",
      manualConfirmedBy: "user:kevin",
    });
  });

  it("rejects oversized gateway metadata without persisting it", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async () => ({
      status: "sent",
      conversationRef: input.conversationRef,
      channel: "t".repeat(65),
      messageId: "m".repeat(513),
      queueId: "q".repeat(513),
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 5_500 });

    const result = await tracker.send(input);

    expect(result).toMatchObject({
      status: "uncertain",
      lastError: "gateway_response_invalid",
      attemptCount: 1,
    });
    expect(result).not.toHaveProperty("channel");
    expect(result).not.toHaveProperty("messageId");
    expect(result).not.toHaveProperty("queueId");
  });

  it("isolates the same closeout id by agent and caps stored message size", async () => {
    const store = createMemoryStore();
    const send = vi.fn<ConversationSend>(async ({ conversationRef }) => ({
      status: "sent",
      conversationRef,
      channel: "telegram",
      messageId: "telegram-isolated",
      messageIdSource: "platform",
    }));
    const tracker = createCloseoutTracker({ store, send, now: () => 6_000 });
    const scoped = tracker as unknown as {
      get: (agentId: string, closeoutId: string) => Promise<CloseoutRecord | undefined>;
      list: (agentId: string, limit?: number) => Promise<CloseoutRecord[]>;
    };

    await tracker.send(input);
    await expect(
      tracker.send({
        ...input,
        agentId: "secondary",
        message: "Secondary agent closeout.",
      }),
    ).resolves.toMatchObject({ agentId: "secondary", status: "confirmed" });

    await expect(scoped.get("main", "NAC-78")).resolves.toMatchObject({ agentId: "main" });
    await expect(scoped.get("secondary", "NAC-78")).resolves.toMatchObject({
      agentId: "secondary",
    });
    await expect(scoped.list("main", 10)).resolves.toEqual([
      expect.objectContaining({ agentId: "main" }),
    ]);
    await expect(
      tracker.send({ ...input, closeoutId: "too-long", message: "x".repeat(16_001) }),
    ).rejects.toThrow("message exceeds 16000 characters");
  });
});
