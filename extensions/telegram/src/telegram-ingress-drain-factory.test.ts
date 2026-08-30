/** Verifies the grammY-to-durable-ingress terminal outcome handoff. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
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

  it("reuses an in-flight callback answer for duplicate durable admission", async () => {
    const answerCallbackQuery = vi.fn(() => new Promise<true>(() => {}));
    const bot = {
      handleUpdate: vi.fn(async () => {}),
      api: { answerCallbackQuery },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
    const update = { update_id: 122, callback_query: { id: "callback-122" } };

    await monitor.onDurableAdmission(update, { isNew: true });
    await monitor.onDurableAdmission(update, { isNew: false });

    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(answerCallbackQuery).toHaveBeenCalledWith("callback-122");
  });

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
        cfg: {} as OpenClawConfig,
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
      cfg: {} as OpenClawConfig,
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
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(
      monitor.dispatch({ update_id: 125 }, {} as TelegramIngressDrainLifecycle),
    ).resolves.toEqual({ kind: "skipped" });
  });
});
