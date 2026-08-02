// Telegram ingress drain adapter: dispatch result propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GrammyError } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import { resolveTelegramIngressNonRetryableFailure } from "./telegram-ingress-non-retryable.js";
import { telegramSpooledUpdateLaneKey } from "./telegram-ingress-spool.js";
import {
  TelegramIngressPayloadError,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["111"],
      dmPolicy: "allowlist",
    },
  },
} as OpenClawConfig;

function updatePayload(updateId: number): TelegramSpooledUpdatePayload {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: {
        text: "hello",
        from: { id: 111 },
        chat: { id: 111, type: "private" },
      },
    },
  };
}

function telegramSendError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    { chat_id: 111 },
  );
}

describe("resolveTelegramIngressNonRetryableFailure", () => {
  it.each([
    "Forbidden: bot was blocked by the user",
    "Forbidden: bot was kicked from the group chat",
    "Forbidden: user is deactivated",
  ])("classifies permanent Telegram recipient rejection: %s", (description) => {
    expect(resolveTelegramIngressNonRetryableFailure(telegramSendError(403, description))).toEqual({
      reason: "recipient-unreachable",
      message: expect.stringContaining(description),
    });
  });

  it("classifies a permanent recipient error nested inside a dispatch failure", () => {
    const cause = telegramSendError(403, "Forbidden: bot was blocked by the user");

    expect(
      resolveTelegramIngressNonRetryableFailure(new Error("pairing reply failed", { cause })),
    ).toEqual({
      reason: "recipient-unreachable",
      message: expect.stringContaining("bot was blocked by the user"),
    });
  });

  it("keeps recoverable Telegram permission failures eligible for retry", () => {
    const error = telegramSendError(403, "Forbidden: not enough rights to send text messages");

    expect(resolveTelegramIngressNonRetryableFailure(error)).toBeNull();
  });

  it("keeps flood-control failures eligible for retry", () => {
    const error = telegramSendError(429, "Too Many Requests: retry after 30");

    expect(resolveTelegramIngressNonRetryableFailure(error)).toBeNull();
  });
});

describe("createTelegramIngressMonitor", () => {
  it("dead-letters a real blocked-recipient Telegram API error without retrying it", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "3".padStart(16, "0");
      const payload = updatePayload(3);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const error = telegramSendError(403, "Forbidden: bot was blocked by the user");
      const dispatch = vi.fn(async () => ({ kind: "failed-retryable" as const, error }));
      const monitor = createTelegramIngressMonitor({ queue, cfg, accountId: "default", dispatch });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: eventId,
          reason: "recipient-unreachable",
          message: expect.stringContaining("bot was blocked by the user"),
        }),
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);

      await monitor.stop();
    });
  });

  it("propagates failed-retryable dispatch results as claim release (not tombstone)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "1".padStart(16, "0");
      const payload = updatePayload(1);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const retryError = new Error("provider blip");
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => ({ kind: "failed-retryable", error: retryError }),
      });

      monitor.start();
      await monitor.waitForIdle();

      // Failed-retryable must release, not complete — re-enqueue is pending, not tombstone.
      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).not.toBe("completed");
      expect(status.kind === "accepted" || status.kind === "pending").toBe(true);

      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === eventId)).toBe(true);

      await monitor.stop();
    });
  });

  it("applies a late deferred retry failure with the real error", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "4".padStart(16, "0");
      const payload = updatePayload(4);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => {
          participant.current =
            createTelegramSpooledReplayDeferredParticipant("test:late-retry") ?? undefined;
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(participant.current).toBeDefined());
      expect(await queue.listClaims()).toHaveLength(1);
      participant.current?.settle({
        kind: "failed-retryable",
        error: new Error("late provider blip"),
      });

      await vi.waitFor(async () =>
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: eventId, attempts: 1, lastError: "late provider blip" },
        ]),
      );
      await monitor.stop();
    });
  });

  it("dead-letters a late deferred non-retryable failure", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "5".padStart(16, "0");
      const payload = updatePayload(5);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => {
          participant.current =
            createTelegramSpooledReplayDeferredParticipant("test:late-fatal") ?? undefined;
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(participant.current).toBeDefined());
      participant.current?.settle({
        kind: "failed-retryable",
        error: new TelegramIngressPayloadError("late invalid payload"),
      });

      await vi.waitFor(async () =>
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: eventId, reason: "invalid-event", message: "late invalid payload" },
        ]),
      );
      await monitor.stop();
    });
  });

  it.each(["completed", "skipped"] as const)(
    "releases an aborted deferred claim after a late %s settlement",
    async (terminalKind) => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
          channelId: "telegram",
          accountId: "default",
          stateDir,
        });
        const updateId = terminalKind === "completed" ? 6 : 7;
        const eventId = String(updateId).padStart(16, "0");
        const payload = updatePayload(updateId);
        const laneKey = telegramSpooledUpdateLaneKey(payload.update);
        await queue.enqueue(eventId, payload, { laneKey });
        const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
        const monitor = createTelegramIngressMonitor({
          queue,
          cfg,
          accountId: "default",
          dispatch: async () => {
            participant.current =
              createTelegramSpooledReplayDeferredParticipant(`test:late-${terminalKind}`) ??
              undefined;
          },
        });

        monitor.start();
        await vi.waitFor(() => expect(participant.current).toBeDefined());
        await monitor.stop();
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([eventId]);

        participant.current?.settle({ kind: terminalKind });
        await vi.waitFor(async () =>
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            {
              id: eventId,
              attempts: 1,
              lastError: "Telegram ingress monitor is stopped.",
            },
          ]),
        );
        expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
      });
    },
  );

  it("releases when dispatch settles only after its owner was aborted", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "8".padStart(16, "0");
      const payload = updatePayload(8);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      let finishDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });
      let ownerSignal: AbortSignal | undefined;
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          ownerSignal = lifecycle.abortSignal;
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:abort-before-settlement",
          );
          await dispatchGate;
          participant?.settle({ kind: "completed" });
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(ownerSignal).toBeDefined());
      const stopped = monitor.stop();
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      finishDispatch();
      await stopped;

      await vi.waitFor(async () =>
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: eventId,
            attempts: 1,
            lastError: "Telegram ingress monitor is stopped.",
          },
        ]),
      );
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });

  it("tombstones completed dispatch results", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "2".padStart(16, "0");
      const payload = updatePayload(2);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).toBe("completed");
      await monitor.stop();
    });
  });

  it("logs a diagnostic when dispatch records no outcome and defers no participant", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "3".padStart(16, "0");
      const payload = updatePayload(3);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const logs: string[] = [];
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => {},
        onLog: (message) => logs.push(message),
      });

      monitor.start();
      await monitor.waitForIdle();

      // Silent consumption still completes (skip semantics), but must leave a trace.
      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).toBe("completed");
      expect(
        logs.some((line) => line.includes("completed without a recorded processing outcome")),
      ).toBe(true);
      await monitor.stop();
    });
  });
});
