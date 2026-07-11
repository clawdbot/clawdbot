import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

type StoredEntry = Record<string, unknown> | undefined;

describe("runHeartbeatOnce clears stuck pendingFinalDelivery state once delivery is satisfied", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  function createHeartbeatConfig(storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
        },
      },
      session: { store: storePath },
    } as unknown as OpenClawConfig;
  }

  function heartbeatDeps(
    sendTelegram: ReturnType<typeof vi.fn>,
    replySpy: HeartbeatReplySpy,
    now?: number,
  ): HeartbeatDeps {
    return {
      telegram: sendTelegram as unknown,
      getQueueSize: () => 0,
      // A fixed clock lets a test seed pendingFinalDeliveryCreatedAt relative to
      // the run's startedAt, which is what the ownership guard compares against.
      nowMs: () => now ?? Date.now(),
      getReplyFromConfig: replySpy,
    } satisfies HeartbeatDeps;
  }

  // seedMainSessionStore exposes only part of the pendingFinalDelivery* family;
  // patch in lastHeartbeat* and the three unexposed pending fields so each test can
  // prove all eight recovery fields get cleared.
  async function patchEntry(
    storePath: string,
    sessionKey: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await patchSessionEntry({ storePath, sessionKey }, () => patch, { preserveActivity: true });
  }

  async function readEntry(storePath: string, sessionKey: string): Promise<StoredEntry> {
    return readSessionStoreForTest<Record<string, unknown>>(storePath)[sessionKey];
  }

  function expectPendingFinalDeliveryCleared(entry: StoredEntry): void {
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(entry?.pendingFinalDeliveryText).toBeUndefined();
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(entry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(entry?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(entry?.pendingFinalDeliveryContext).toBeUndefined();
    expect(entry?.pendingFinalDeliveryIntentId).toBeUndefined();
  }

  it("nulls every pendingFinalDelivery* field after delivering substantive heartbeat content", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig(storePath);
      const NOW = Date.now();

      // Seed a stuck pendingFinalDelivery this run owns: createdAt at run start
      // marks it as produced by this heartbeat (the case the original fix
      // targets). pendingFinalDeliveryText is a heartbeat-ack token so the
      // pendingFinalDelivery defer gate does not bail before the send.
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        updatedAt: NOW,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK",
        pendingFinalDeliveryCreatedAt: NOW,
        pendingFinalDeliveryAttemptCount: 3,
        pendingFinalDeliveryLastError: "prior-error",
      });
      await patchEntry(storePath, sessionKey, {
        pendingFinalDeliveryLastAttemptAt: NOW,
        pendingFinalDeliveryContext: { foo: "bar" },
        pendingFinalDeliveryIntentId: "intent-send-success",
      });

      // Substantive reply text forces the post-success store write path
      // (heartbeat-runner.ts:~2120, `if (visibleSendSucceeded && !shouldSkipMain ...)`).
      const replyText = "Heartbeat update: everything is green.";
      replySpy.mockResolvedValue({ text: replyText });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: heartbeatDeps(sendTelegram, replySpy, NOW),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);

      const entry = await readEntry(storePath, sessionKey);
      expect(entry?.lastHeartbeatText).toBe(replyText);
      expect(typeof entry?.lastHeartbeatSentAt).toBe("number");
      expectPendingFinalDeliveryCleared(entry);
    });
  });

  it("clears pendingFinalDelivery* on a duplicate skip even when responsePrefix diverges the stored text", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      // The send-success clear never runs here: the run reproduces a payload we
      // already delivered, so the duplicate-suppression branch
      // (heartbeat-runner.ts:~1944) returns before any send.
      //
      // agent-runner stores pendingFinalDeliveryText as the token-stripped body
      // WITHOUT the responsePrefix (agent-runner.ts:~2490), while
      // normalizeHeartbeatReply re-adds the prefix to the delivered text
      // (heartbeat-runner.ts:~838). So the stored pending text legitimately
      // differs from lastHeartbeatText for the same payload, and the clear must
      // not depend on a byte-equal text match or prefixed agents stay stuck.
      const cfg = {
        ...createHeartbeatConfig(storePath),
        messages: { responsePrefix: "🤖" },
      } as unknown as OpenClawConfig;

      const body = "Heartbeat update: everything is green.";
      const deliveredText = `🤖 ${body}`;
      const NOW = Date.now();
      // updatedAt is well past the 30s defer window so the pendingFinalDelivery
      // gate does not bail before the duplicate branch (the pending text is
      // substantive, not a heartbeat ack).
      const staleAt = NOW - 60_000;

      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        updatedAt: staleAt,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: body, // prefix-less; diverges from deliveredText
        // createdAt at run start: this run produced the pending (real runs stamp
        // a fresh createdAt during the agent turn the defer gate ran ahead of).
        pendingFinalDeliveryCreatedAt: NOW,
        pendingFinalDeliveryAttemptCount: 3,
        pendingFinalDeliveryLastError: "prior-error",
      });
      await patchEntry(storePath, sessionKey, {
        // lastHeartbeat* proves the same payload already went out within 24h,
        // which is what makes this run a duplicate and the pending clear safe.
        lastHeartbeatText: deliveredText,
        lastHeartbeatSentAt: staleAt,
        pendingFinalDeliveryLastAttemptAt: NOW,
        pendingFinalDeliveryContext: { foo: "bar" },
        pendingFinalDeliveryIntentId: "intent-duplicate-skip",
      });

      // Reply is the prefix-less body; normalizeHeartbeatReply re-adds "🤖 ", so
      // normalized.text === deliveredText === lastHeartbeatText → duplicate skip.
      replySpy.mockResolvedValue({ text: body });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: heartbeatDeps(sendTelegram, replySpy, NOW),
      });

      // status "ran" (not "skipped") proves the run reached the duplicate branch
      // rather than bailing at the pendingFinalDelivery gate.
      expect(result.status).toBe("ran");
      // Duplicate payload: nothing is sent this run.
      expect(sendTelegram).not.toHaveBeenCalled();

      const entry = await readEntry(storePath, sessionKey);
      // lastHeartbeat* stays intact; only the satisfied pending state clears.
      expect(entry?.lastHeartbeatText).toBe(deliveredText);
      expectPendingFinalDeliveryCleared(entry);
    });
  });

  it("preserves an older unsatisfied pendingFinalDelivery the heartbeat send did not create", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig(storePath);
      const NOW = Date.now();
      // An older user-facing final that failed delivery and still owns its own
      // get-reply redelivery recovery path. It predates this run (createdAt <
      // startedAt) and a message_tool_only/response-tool heartbeat would not
      // refresh it, so the send-success clear must NOT retire it.
      const olderCreatedAt = NOW - 60_000;
      const olderText = "Older final the user never received";
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        // Stale so the substantive-pending defer gate does not bail this run.
        updatedAt: NOW - 60_000,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: olderText,
        pendingFinalDeliveryCreatedAt: olderCreatedAt,
        pendingFinalDeliveryAttemptCount: 2,
        pendingFinalDeliveryLastError: "prior-delivery-failure",
      });
      await patchEntry(storePath, sessionKey, {
        pendingFinalDeliveryLastAttemptAt: NOW - 50_000,
        pendingFinalDeliveryContext: { channel: "telegram", to: "older-chat" },
        pendingFinalDeliveryIntentId: "intent-older-unsatisfied",
      });

      // A fresh, different heartbeat payload that gets delivered this run.
      const replyText = "Fresh heartbeat content unrelated to the older final.";
      replySpy.mockResolvedValue({ text: replyText });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: heartbeatDeps(sendTelegram, replySpy, NOW),
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);

      const entry = await readEntry(storePath, sessionKey);
      // Send-success records the dedupe markers for the delivered payload...
      expect(entry?.lastHeartbeatText).toBe(replyText);
      // ...but the older, unowned pending-final survives for its own recovery.
      expect(entry?.pendingFinalDelivery).toBe(true);
      expect(entry?.pendingFinalDeliveryText).toBe(olderText);
      expect(entry?.pendingFinalDeliveryCreatedAt).toBe(olderCreatedAt);
      expect(entry?.pendingFinalDeliveryIntentId).toBe("intent-older-unsatisfied");
    });
  });

  it("preserves an older unowned pendingFinalDelivery on a duplicate skip", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig(storePath);
      const NOW = Date.now();
      const body = "Recurring heartbeat status line.";
      const olderCreatedAt = NOW - 60_000;
      const olderText = "A different older final still awaiting delivery";
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        updatedAt: NOW - 60_000,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: olderText,
        pendingFinalDeliveryCreatedAt: olderCreatedAt,
        pendingFinalDeliveryAttemptCount: 2,
        pendingFinalDeliveryLastError: "prior-delivery-failure",
      });
      await patchEntry(storePath, sessionKey, {
        // Same payload already delivered within 24h -> this run is a duplicate skip.
        lastHeartbeatText: body,
        lastHeartbeatSentAt: NOW - 60_000,
        pendingFinalDeliveryLastAttemptAt: NOW - 50_000,
        pendingFinalDeliveryContext: { channel: "telegram", to: "older-chat" },
        pendingFinalDeliveryIntentId: "intent-older-dupe",
      });

      replySpy.mockResolvedValue({ text: body });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: heartbeatDeps(sendTelegram, replySpy, NOW),
      });

      expect(result.status).toBe("ran");
      // Duplicate payload: nothing is sent this run.
      expect(sendTelegram).not.toHaveBeenCalled();

      const entry = await readEntry(storePath, sessionKey);
      // The duplicate-skip clear must not retire the older, unowned pending-final.
      expect(entry?.pendingFinalDelivery).toBe(true);
      expect(entry?.pendingFinalDeliveryText).toBe(olderText);
      expect(entry?.pendingFinalDeliveryCreatedAt).toBe(olderCreatedAt);
      expect(entry?.pendingFinalDeliveryIntentId).toBe("intent-older-dupe");
    });
  });
});
