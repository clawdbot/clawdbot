/** Verifies callback admission and the grammY terminal outcome handoff. */
import type { ServerResponse } from "node:http";
import { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { takeTelegramCallbackQueryAdmissionAnswer } from "./callback-query-answer-state.js";
import type { TelegramIngressDrainLifecycle } from "./telegram-ingress-drain.js";

const mocks = vi.hoisted(() => ({
  createTelegramIngressMonitor: vi.fn((params: unknown) => params),
  openTelegramIngressQueue: vi.fn(() => ({ kind: "test-queue" })),
  resolveTelegramAdoptionStallTimeoutMs: vi.fn(() => 5_000),
}));

vi.mock("./telegram-ingress-drain.js", () => ({
  createTelegramIngressMonitor: mocks.createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs: mocks.resolveTelegramAdoptionStallTimeoutMs,
}));

vi.mock("./telegram-ingress-spool.js", () => ({
  openTelegramIngressQueue: mocks.openTelegramIngressQueue,
}));

const { createTelegramTransportIngressMonitor } =
  await import("./telegram-ingress-drain-factory.js");

type CapturedMonitor = {
  onDurableAdmission: (update: unknown, context: { isNew: boolean }) => void | Promise<void>;
  dispatch: (
    update: unknown,
    lifecycle: TelegramIngressDrainLifecycle,
  ) => Promise<TelegramMessageProcessingResult | void>;
};

describe("Telegram transport ingress outcome handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "after a rejected new-row answer",
      rejectNewAnswer: true,
      startNewPending: false,
      consumePending: false,
      expectedRequests: 2,
    },
    {
      name: "for an existing durable row",
      rejectNewAnswer: false,
      startNewPending: false,
      consumePending: false,
      expectedRequests: 1,
    },
    {
      name: "while middleware consumes a pending answer",
      rejectNewAnswer: false,
      startNewPending: true,
      consumePending: true,
      expectedRequests: 1,
    },
    {
      name: "before middleware consumes a new-row answer",
      rejectNewAnswer: false,
      startNewPending: true,
      consumePending: false,
      expectedRequests: 1,
    },
  ])(
    "coalesces duplicate callback answers $name",
    async ({ rejectNewAnswer, startNewPending, consumePending, expectedRequests }) => {
      const callbackId = "callback-redelivered";
      const requestIds: string[] = [];
      const pendingResponses: ServerResponse[] = [];
      const answerRequests: Promise<true>[] = [];
      const pendingAnswer = createDeferred<void>();
      let releaseAnswers = false;
      const sendAnswer = (response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: true }));
      };
      await withServer(
        (request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            const payload = JSON.parse(body) as { callback_query_id: string };
            requestIds.push(payload.callback_query_id);
            if (rejectNewAnswer && requestIds.length === 1) {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ ok: false, error_code: 503, description: "ACK unavailable" }),
              );
              return;
            }
            pendingResponses.push(response);
            pendingAnswer.resolve();
            if (releaseAnswers) {
              sendAnswer(response);
            }
          });
        },
        async (baseUrl) => {
          const api = new Api("1000000:test-token", { apiRoot: baseUrl });
          const bot = {
            handleUpdate: vi.fn(async () => {}),
            api: {
              answerCallbackQuery: (id: string) => {
                const answer = api.answerCallbackQuery(id);
                answerRequests.push(answer);
                return answer;
              },
            },
          };
          createTelegramTransportIngressMonitor({
            spoolDir: "/tmp/telegram-ingress-proof",
            bot,
            cfg: {},
            accountId: "default",
          });
          const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
          const update = { update_id: 125, callback_query: { id: callbackId } };
          try {
            if (rejectNewAnswer) {
              await monitor.onDurableAdmission(update, { isNew: true });
              const initialAnswers = await Promise.allSettled(answerRequests);
              expect(initialAnswers).toMatchObject([{ status: "rejected" }]);
            }
            if (startNewPending) {
              await monitor.onDurableAdmission(update, { isNew: true });
              await pendingAnswer.promise;
              if (consumePending) {
                expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeDefined();
              }
            }
            await monitor.onDurableAdmission(update, { isNew: false });
            await pendingAnswer.promise;
            await monitor.onDurableAdmission(update, { isNew: false });
            releaseAnswers = true;
            for (const response of pendingResponses) {
              sendAnswer(response);
            }
            await Promise.allSettled(answerRequests);
            expect(requestIds).toEqual(Array.from({ length: expectedRequests }, () => callbackId));
            expect(bot.handleUpdate).not.toHaveBeenCalled();
            if (startNewPending && !consumePending) {
              expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeDefined();
            }
            // Tombstones never dispatch; their settled answers must not remain per bot.
            expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeUndefined();
          } finally {
            releaseAnswers = true;
            for (const response of pendingResponses) {
              if (!response.writableEnded) {
                sendAnswer(response);
              }
            }
            await Promise.allSettled(answerRequests);
          }
        },
      );
    },
  );

  it.each([
    { kind: "completed" as const },
    { kind: "skipped" as const },
    { kind: "failed-retryable" as const, error: new Error("retry the update") },
  ])(
    "returns the middleware-owned $kind outcome despite grammY returning void",
    async (outcome) => {
      const bot = {
        handleUpdate: vi.fn(async () => {
          await runWithTelegramUpdateProcessingFrame(async () => {
            recordTelegramMessageProcessingResult(outcome);
          });
        }),
        api: { answerCallbackQuery: vi.fn(async () => true) },
      };
      createTelegramTransportIngressMonitor({
        spoolDir: "/tmp/telegram-ingress-proof",
        bot,
        cfg: {},
        accountId: "default",
      });
      const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
      const update = { update_id: 123 };

      await expect(monitor.dispatch(update, {} as TelegramIngressDrainLifecycle)).resolves.toBe(
        outcome,
      );
      expect(bot.handleUpdate).toHaveBeenCalledWith(update);
    },
  );

  it("does not invent an outcome for deferred participant ownership", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {});
      }),
      api: { answerCallbackQuery: vi.fn(async () => true) },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {},
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(
      monitor.dispatch({ update_id: 124 }, {} as TelegramIngressDrainLifecycle),
    ).resolves.toBeUndefined();
  });

  it("keeps an existing explicit skip when middleware applies its completion default", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {
          recordTelegramMessageProcessingResult({ kind: "skipped" });
          ensureTelegramMessageProcessingResult({ kind: "completed" });
        });
      }),
      api: { answerCallbackQuery: vi.fn(async () => true) },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {},
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(
      monitor.dispatch({ update_id: 125 }, {} as TelegramIngressDrainLifecycle),
    ).resolves.toEqual({ kind: "skipped" });
  });
});
