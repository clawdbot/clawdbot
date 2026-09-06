import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalRecoveryPayloads,
} from "../auto-reply/reply/pending-final-delivery.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

describe("heartbeat pending-final delivery ownership", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  afterEach(() => {
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function createHeartbeatConfig(storePath: string, isolatedSession = false): OpenClawConfig {
    return {
      agents: { defaults: { heartbeat: { every: "5m", target: "telegram", isolatedSession } } },
      messages: { visibleReplies: "automatic" },
      channels: {
        telegram: { token: "test-token", allowFrom: ["*"], heartbeat: { showOk: false } },
      },
      session: { store: storePath },
    } as OpenClawConfig;
  }

  function heartbeatDeps(
    sendTelegram: ReturnType<typeof vi.fn>,
    replySpy: HeartbeatReplySpy,
    now: number,
  ): HeartbeatDeps {
    return {
      telegram: sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => now,
      getReplyFromConfig: replySpy,
    };
  }

  function readEntry(storePath: string, sessionKey: string) {
    return readSessionStoreForTest<SessionEntry>(storePath)[sessionKey];
  }

  // Model completion produces one intent and a prepared delivery per payload.
  // Let the real transport and finalizer settle it; the test never clears it.
  async function prepareFinal(
    storePath: string,
    sessionKey: string,
    payload: ReplyPayload,
    options: { siblingState?: "prepared" | "unknown" } = {},
  ) {
    const entry = loadSessionEntry({ storePath, sessionKey });
    if (!entry) {
      throw new Error("Expected heartbeat execution session");
    }
    const intentId = "heartbeat-intent";
    const deliveryId = "heartbeat-delivery";
    const recoveryText = buildRecoverablePendingFinalDeliveryText(
      normalizePendingFinalRecoveryPayloads([payload]),
    );
    const stripped = stripHeartbeatToken(recoveryText ?? "", {
      mode: "heartbeat",
      maxAckChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    });
    const pendingText = stripped.shouldSkip ? "" : stripped.text;
    await patchSessionEntryCore(
      { storePath, sessionKey },
      () => ({
        pendingFinalDelivery: {
          ...(pendingText
            ? { kind: "replayable" as const, text: pendingText }
            : { kind: "transport-only" as const }),
          createdAt: Date.now(),
          intentId,
          deliveries: [
            ...(options.siblingState
              ? [{ id: "other-delivery", state: options.siblingState }]
              : []),
            { id: deliveryId, state: "prepared" },
          ],
        },
      }),
      { preserveActivity: true },
    );
    return setReplyPayloadMetadata(payload, {
      pendingFinalDeliveryCompletion: {
        deliveryId,
        intentId,
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
      },
    });
  }

  async function seedSession(storePath: string, cfg: OpenClawConfig, updatedAt: number) {
    return seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
      updatedAt,
    });
  }

  it.each([false, true])(
    "clears the delivered execution intent with isolatedSession=%s",
    async (isolatedSession) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatConfig(storePath, isolatedSession);
        const now = Date.now();
        const previousUpdatedAt = now - 60_000;
        const sessionKey = await seedSession(storePath, cfg, previousUpdatedAt);
        const replyText = "Heartbeat update: everything is green.";
        const unrelatedFinal = {
          kind: "replayable" as const,
          text: "User final awaiting confirmation",
          createdAt: now,
          intentId: "base-user-intent",
          deliveries: [{ id: "base-user-delivery", state: "unknown" as const }],
        };
        let executionKey = "";
        replySpy.mockImplementation(async (ctx) => {
          executionKey = ctx.SessionKey!;
          if (isolatedSession) {
            await patchSessionEntryCore(
              { storePath, sessionKey },
              () => ({
                pendingFinalDelivery: unrelatedFinal,
              }),
              { preserveActivity: true },
            );
          }
          return prepareFinal(storePath, executionKey, { text: replyText });
        });
        const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

        const result = await runHeartbeatOnce({
          cfg,
          deps: heartbeatDeps(sendTelegram, replySpy, now),
        });

        expect(result.status).toBe("ran");
        expect(sendTelegram).toHaveBeenCalledOnce();
        expect(sendTelegram.mock.calls[0]?.[1]).toBe(replyText);
        expect(executionKey === sessionKey).toBe(!isolatedSession);
        expect(readEntry(storePath, executionKey)?.pendingFinalDelivery).toBeUndefined();
        expect(readEntry(storePath, sessionKey)).toMatchObject({
          lastHeartbeatText: replyText,
          lastHeartbeatSentAt: now,
        });
        if (isolatedSession) {
          expect(readEntry(storePath, sessionKey)).toMatchObject({
            updatedAt: previousUpdatedAt,
            pendingFinalDelivery: unrelatedFinal,
          });
        }
      });
    },
  );

  it.each([
    { name: "heartbeat ack", payload: () => ({ text: "HEARTBEAT_OK" }), sends: 0 },
    {
      name: "quiet tool response",
      payload: () =>
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      sends: 0,
    },
    {
      name: "visible tool response",
      payload: () =>
        createHeartbeatToolResponsePayload({
          outcome: "needs_attention",
          notify: true,
          summary: "Build blocked.",
          notificationText: "Build needs credentials.",
        }),
      sends: 1,
    },
  ])("settles the selected $name intent", async ({ payload, sends }) => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig(storePath, true);
      const now = Date.now();
      const previousUpdatedAt = now - 60_000;
      const sessionKey = await seedSession(storePath, cfg, previousUpdatedAt);
      let executionKey = "";
      replySpy.mockImplementation(async (ctx) => {
        executionKey = ctx.SessionKey!;
        return prepareFinal(storePath, executionKey, payload());
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: heartbeatDeps(sendTelegram, replySpy, now),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(sends);
      if (sends) {
        expect(sendTelegram.mock.calls[0]?.[1]).toBe("Build needs credentials.");
      }
      expect(readEntry(storePath, executionKey)?.pendingFinalDelivery).toBeUndefined();
      expect(readEntry(storePath, sessionKey)?.updatedAt).toBe(previousUpdatedAt);
      if (!sends) {
        expect(readEntry(storePath, executionKey)?.updatedAt).toBe(now);
      }
    });
  });

  it.each([undefined, "prepared", "unknown"] as const)(
    "suppresses only the selected duplicate with sibling=%s despite a response prefix",
    async (siblingState) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatConfig(storePath);
        cfg.channels!.telegram!.responsePrefix = "🤖";
        const now = Date.now();
        const previousUpdatedAt = now - 60_000;
        const body = "Heartbeat update: everything is green.";
        const deliveredText = `🤖 ${body}`;
        const sessionKey = await seedSession(storePath, cfg, previousUpdatedAt);
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({
            lastHeartbeatText: deliveredText,
            lastHeartbeatSentAt: previousUpdatedAt,
          }),
          { preserveActivity: true },
        );
        replySpy.mockImplementation(async (ctx) =>
          prepareFinal(storePath, ctx.SessionKey!, { text: body }, { siblingState }),
        );
        const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

        const result = await runHeartbeatOnce({
          cfg,
          deps: heartbeatDeps(sendTelegram, replySpy, now),
        });

        expect(result.status).toBe("ran");
        expect(sendTelegram).not.toHaveBeenCalled();
        const entry = readEntry(storePath, sessionKey);
        expect(entry).toMatchObject({
          lastHeartbeatText: deliveredText,
          lastHeartbeatSentAt: previousUpdatedAt,
          updatedAt: previousUpdatedAt,
        });
        if (siblingState) {
          expect(entry?.pendingFinalDelivery?.deliveries).toEqual([
            { id: "other-delivery", state: siblingState },
            { id: "heartbeat-delivery", state: "suppressed" },
          ]);
        } else {
          expect(entry?.pendingFinalDelivery).toBeUndefined();
        }
      });
    },
  );

  it.each(["send", "duplicate"] as const)(
    "preserves an unowned pending final during %s even when its timestamp matches this run",
    async (outcome) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatConfig(storePath);
        const now = Date.now();
        const previousUpdatedAt = now - 60_000;
        const sessionKey = await seedSession(storePath, cfg, previousUpdatedAt);
        const body = "Recurring heartbeat status line.";
        const pendingFinalDelivery = {
          kind: "replayable" as const,
          text: "A different final still awaiting delivery",
          createdAt: now,
          intentId: "unowned-intent",
          deliveries: [{ id: "unowned-delivery", state: "unknown" as const }],
        };
        replySpy.mockImplementation(async () => {
          await patchSessionEntryCore({ storePath, sessionKey }, () => ({ pendingFinalDelivery }), {
            preserveActivity: true,
          });
          return { text: body };
        });
        if (outcome === "duplicate") {
          await patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({
              lastHeartbeatText: body,
              lastHeartbeatSentAt: previousUpdatedAt,
            }),
            { preserveActivity: true },
          );
        }
        const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

        const result = await runHeartbeatOnce({
          cfg,
          deps: heartbeatDeps(sendTelegram, replySpy, now),
        });

        expect(result.status).toBe("ran");
        expect(sendTelegram).toHaveBeenCalledTimes(outcome === "send" ? 1 : 0);
        expect(readEntry(storePath, sessionKey)).toMatchObject({
          pendingFinalDelivery,
          lastHeartbeatText: body,
          updatedAt: previousUpdatedAt,
        });
      });
    },
  );
});
