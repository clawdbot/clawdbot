// Covers structured heartbeat delivery, text-only dedupe, and recovery ownership.
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { isRetryableHeartbeatSkipReason } from "./heartbeat-wake.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce structured heartbeat delivery", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  afterEach(() => {
    resetGlobalHookRunner();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function createConfig(tmpDir: string, storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      messages: { visibleReplies: "automatic" },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;
  }

  function seedTelegramSession(
    storePath: string,
    cfg: OpenClawConfig,
    entry: Partial<Parameters<typeof seedMainSessionStore>[2]> = {},
  ) {
    return seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
      ...entry,
    });
  }

  function runHeartbeat(
    cfg: OpenClawConfig,
    replySpy: HeartbeatDeps["getReplyFromConfig"],
    sendTelegram: ReturnType<typeof vi.fn>,
    overrides: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {},
  ) {
    return runHeartbeatOnce({
      cfg,
      ...overrides,
      deps: {
        telegram: sendTelegram as unknown,
        getQueueSize: () => 0,
        nowMs: () => 0,
        getReplyFromConfig: replySpy,
      },
    });
  }

  it.each([
    { failure: "target-none", reason: "target-none" },
    { failure: "alerts-disabled", reason: "alerts-disabled" },
    { failure: "readiness", reason: "channel-offline" },
    { failure: "readiness-throws", reason: "readiness unavailable" },
    { failure: "hook-cancelled", reason: "message_sending_hook" },
    { failure: "send-failed", reason: "transport unavailable" },
  ])(
    "records a generated alert when $failure prevents confirmed delivery",
    async ({ failure, reason }) => {
      await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createConfig(tmpDir, storePath);
        cfg.agents!.defaults!.heartbeat!.target = failure === "target-none" ? "none" : "telegram";
        if (failure === "alerts-disabled") {
          cfg.channels = {
            ...cfg.channels,
            defaults: { heartbeatVisibility: { showAlerts: false } },
          };
        }
        const registry = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...heartbeatRunnerTelegramPlugin,
              heartbeat: {
                checkReady: async () => {
                  if (failure === "readiness-throws") {
                    throw new Error(reason);
                  }
                  return { ok: failure !== "readiness", reason };
                },
              },
            },
          },
        ]);
        setActivePluginRegistry(registry);
        if (failure === "hook-cancelled") {
          addTestHook({
            registry,
            pluginId: "heartbeat-test-suppression",
            hookName: "message_sending",
            handler: () => ({ cancel: true }),
          });
          initializeGlobalHookRunner(registry);
        }
        const sessionKey = await seedTelegramSession(storePath, cfg);
        replySpy.mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "needs_attention",
            notify: true,
            summary: "Build is blocked.",
            notificationText: "Build needs credentials.",
            reason: "Deployment check",
            priority: "high",
          }),
        );
        const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });
        if (failure === "send-failed") {
          sendTelegram.mockRejectedValue(new Error(reason));
        }

        const result = await runHeartbeat(cfg, replySpy, sendTelegram, {
          source: "manual",
          reason: "operator check",
        });

        expect(replySpy).toHaveBeenCalledOnce();
        if (failure.startsWith("readiness")) {
          expect.soft(result).toMatchObject({
            status: "skipped",
            reason: "channel-not-ready",
            retryAtMs: expect.any(Number),
          });
          expect.soft(isRetryableHeartbeatSkipReason("channel-not-ready")).toBe(true);
        }
        closeOpenClawAgentDatabasesForTest();
        const stored = claimHeartbeatOutcomeForRun({
          agentId: "main",
          sessionKey,
          storePath,
          runId: "user-run",
        });
        expect(stored).toMatchObject({
          outcome: "blocked",
          priority: "high",
          wakeSource: "manual",
          wakeReason: "operator check",
        });
        expect(stored?.summary).toContain("Build needs credentials.");
        expect(stored?.responseReason).toContain(reason);
        expect(stored?.responseReason).toContain("notify:true");
        closeOpenClawAgentDatabasesForTest();
      });
    },
  );

  it("delivers presentation-only heartbeat replies with their button fallback", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig(tmpDir, storePath);
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue({
        presentation: {
          blocks: [
            { type: "text", text: "Deployment approval required." },
            {
              type: "buttons",
              buttons: [{ label: "Approve deployment", value: "approve" }],
            },
          ],
        },
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "presentation-1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledOnce();
      expect(sendTelegram.mock.calls[0]?.[0]).toBe(TELEGRAM_GROUP);
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("Deployment approval required.");
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("Approve deployment");
    });
  });

  it("delivers changed heartbeat actions when their visible text matches the previous send", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig(tmpDir, storePath);
      await seedTelegramSession(storePath, cfg);
      const text = "Deployment approval required.";
      replySpy
        .mockResolvedValueOnce({
          text,
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Review deployment", value: "review" }],
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          text,
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve deployment", value: "approve" }],
              },
            ],
          },
        });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "presentation-1" });

      await runHeartbeat(cfg, replySpy, sendTelegram);
      await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("Review deployment");
      expect(sendTelegram.mock.calls[1]?.[1]).toContain("Approve deployment");
    });
  });

  it("clears a run-owned transport-only pending final after a presentation-only send", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig(tmpDir, storePath);
      const previousText = "Previous successful heartbeat";
      const previousSentAt = 0;
      const sessionKey = await seedTelegramSession(storePath, cfg, {
        lastHeartbeatText: previousText,
        lastHeartbeatSentAt: previousSentAt,
      });
      replySpy.mockImplementation(async () => {
        const entry = readSessionStoreForTest<SessionEntry>(storePath)[sessionKey];
        if (!entry) {
          throw new Error("Expected heartbeat execution session");
        }
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({
            pendingFinalDelivery: {
              kind: "transport-only",
              createdAt: 0,
              intentId: "structured-heartbeat-intent",
              deliveries: [{ id: "structured-delivery", state: "prepared" }],
            },
          }),
          { preserveActivity: true },
        );
        return setReplyPayloadMetadata(
          {
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Approve deployment", value: "approve" }],
                },
              ],
            },
          } satisfies ReplyPayload,
          {
            pendingFinalDeliveryCompletion: {
              deliveryId: "structured-delivery",
              intentId: "structured-heartbeat-intent",
              sessionId: entry.sessionId,
              sessionKey,
              storePath,
            },
          },
        );
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "presentation-1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledOnce();
      expect(sendTelegram.mock.calls[0]?.[1]).toContain("Approve deployment");
      const sessionStore = readSessionStoreForTest<{
        pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
      }>(storePath);
      expect(sessionStore[sessionKey]).toMatchObject({
        lastHeartbeatText: previousText,
        lastHeartbeatSentAt: previousSentAt,
      });
      expect(sessionStore[sessionKey]?.pendingFinalDelivery).toBeUndefined();
    });
  });

  it("preserves heartbeat reply metadata, channel data, and voice delivery", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig(tmpDir, storePath);
      await seedTelegramSession(storePath, cfg);
      const sendPayload = vi.fn().mockResolvedValue({
        channel: "telegram",
        messageId: "metadata-1",
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText: vi.fn().mockResolvedValue({ messageId: "text-1" }),
                sendPayload,
              },
            }),
          },
        ]),
      );
      const mediaUrl = "https://example.test/heartbeat.ogg";
      const channelData = {
        telegram: {
          buttons: [[{ text: "Open deployment", callback_data: "open" }]],
        },
      };
      replySpy.mockResolvedValue(
        setReplyPayloadMetadata(
          {
            text: "Deployment update",
            mediaUrl,
            replyToId: "42",
            audioAsVoice: true,
            channelData,
          },
          { replyToIdExplicit: true },
        ),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "unused-1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expect(sendPayload).toHaveBeenCalledOnce();
      const deliveredPayload = sendPayload.mock.calls[0]?.[0]?.payload;
      expect(deliveredPayload).toMatchObject({
        text: "Deployment update",
        mediaUrl,
        replyToId: "42",
        audioAsVoice: true,
        channelData,
      });
    });
  });
});
