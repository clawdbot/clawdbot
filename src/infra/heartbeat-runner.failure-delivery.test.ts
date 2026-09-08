// Covers terminal failure delivery and exact pending-final settlement.
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../agents/failover/user-copy.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  setHeartbeatAgentTurnStatus,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { PlatformMessageNotDispatchedError } from "./outbound/deliver-types.js";
import { loadPendingDeliveries } from "./outbound/delivery-queue.test-helpers.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce failure delivery", () => {
  const TELEGRAM_GROUP = "-1001234567890";
  afterEach(() => {
    vi.unstubAllEnvs();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function createConfig(params: {
    tmpDir: string;
    storePath: string;
    target?: "telegram" | "none";
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: { every: "5m", target: params.target ?? "telegram" },
        },
      },
      channels: {
        telegram: { token: "test-token", allowFrom: ["*"], heartbeat: { showOk: false } },
      },
      session: { store: params.storePath },
    } as OpenClawConfig;
  }

  function createDeps(params: {
    sendTelegram: ReturnType<typeof vi.fn>;
    getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"];
  }): HeartbeatDeps {
    return {
      telegram: params.sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => 0,
      getReplyFromConfig: params.getReplyFromConfig,
    };
  }

  function seedTelegramSession(storePath: string, cfg: OpenClawConfig) {
    return seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
    });
  }

  function runHeartbeat(
    cfg: OpenClawConfig,
    replySpy: HeartbeatDeps["getReplyFromConfig"],
    sendTelegram: ReturnType<typeof vi.fn>,
  ) {
    return runHeartbeatOnce({
      cfg,
      deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
    });
  }

  function expectTelegramSend(
    sendTelegram: ReturnType<typeof vi.fn>,
    params: { text: string; cfg: OpenClawConfig },
  ) {
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls).toEqual([
      [
        TELEGRAM_GROUP,
        params.text,
        {
          verbose: false,
          cfg: params.cfg,
          accountId: undefined,
        },
      ],
    ]);
  }

  function createTerminalToolFailureReply(response: HeartbeatToolResponse, warning?: string) {
    const metadata = {
      heartbeatTerminalToolFailure: { toolName: "message" },
    } as const;
    const heartbeatPayload = setReplyPayloadMetadata(
      createHeartbeatToolResponsePayload(response),
      metadata,
    );
    return warning
      ? [heartbeatPayload, setReplyPayloadMetadata({ text: warning, isError: true }, metadata)]
      : heartbeatPayload;
  }

  it("reports a quiet terminal tool failure without external delivery for target none", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, target: "none" });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      enqueueSystemEvent("exec finished: delivery probe completed", { sessionKey });
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply({
          outcome: "no_change",
          notify: false,
          summary: "Message delivery was denied.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: "Message delivery was denied.",
        silent: true,
      });
    });
  });

  it("does not deliver a suppressed quiet terminal failure to an explicit target", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply({
          outcome: "no_change",
          notify: false,
          summary: "Message delivery was denied.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: "Message delivery was denied.",
        silent: true,
      });
    });
  });

  it("delivers a terminal tool warning without recording successful delivery bookkeeping", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      const warning = "⚠️ Message failed";
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply(
          {
            outcome: "no_change",
            notify: false,
            summary: "Message delivery was denied.",
          },
          warning,
        ),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);
      const sessionStore = readSessionStoreForTest<{
        lastHeartbeatText?: string;
      }>(storePath);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expectTelegramSend(sendTelegram, { text: warning, cfg });
      expect(sessionStore[sessionKey]?.lastHeartbeatText).toBeUndefined();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: warning,
        channel: "telegram",
      });
    });
  });

  it.each([
    {
      name: "retains composite pending-final content after delivering only its terminal warning",
      sibling: true,
      failure: "none",
    },
    {
      name: "clears an exact pending-final warning after delivering it",
      sibling: false,
      failure: "none",
    },
    {
      name: "retains queued warning custody after a proven no-send transport failure",
      sibling: false,
      failure: "not-sent",
    },
    {
      name: "retains durable queue custody and ambiguity after a transport failure",
      sibling: false,
      failure: "ambiguous",
    },
  ])("$name", async ({ sibling, failure }) => {
    const fail = failure !== "none";
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const warning = "⚠️ Message failed";
      const pendingText = sibling ? `Original exec completion\n\n${warning}` : warning;
      const sessionKey = await seedTelegramSession(storePath, cfg);
      replySpy.mockImplementation(async () => {
        const entry = readSessionStoreForTest<SessionEntry>(storePath)[sessionKey];
        if (!entry) {
          throw new Error("Expected heartbeat execution session");
        }
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({
            pendingFinalDelivery: {
              kind: "replayable",
              text: pendingText,
              createdAt: Date.now(),
              intentId: "warning-intent",
              deliveries: [
                ...(sibling ? [{ id: "original-delivery", state: "prepared" as const }] : []),
                { id: "warning-delivery", state: "prepared" },
              ],
            },
          }),
          { preserveActivity: true },
        );
        const replies = createTerminalToolFailureReply(
          {
            outcome: fail ? "blocked" : "no_change",
            notify: fail,
            summary: "Message delivery was denied.",
          },
          warning,
        );
        if (!Array.isArray(replies)) {
          throw new Error("Expected terminal warning payload");
        }
        setReplyPayloadMetadata(replies[1]!, {
          pendingFinalDeliveryCompletion: {
            deliveryId: "warning-delivery",
            intentId: "warning-intent",
            sessionId: entry.sessionId,
            sessionKey,
            storePath,
          },
        });
        return replies;
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });
      if (fail) {
        sendTelegram.mockRejectedValue(
          failure === "not-sent"
            ? new PlatformMessageNotDispatchedError("channel unavailable before dispatch", {
                cause: new Error("offline"),
              })
            : new Error("channel send result unavailable"),
        );
      }

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });

      const sessionStore = readSessionStoreForTest<SessionEntry>(storePath);
      expectTelegramSend(sendTelegram, { text: warning, cfg });
      if (fail) {
        // The durable queue owns both failures; its exact record carries replay safety.
        expect(sessionStore[sessionKey]?.pendingFinalDelivery).toMatchObject({
          intentId: "warning-intent",
          deliveries: [{ id: "warning-delivery", state: "queued" }],
        });
        const queued = await loadPendingDeliveries();
        expect(queued).toHaveLength(1);
        expect(queued[0]?.deliveryCompletion).toMatchObject({
          kind: "pending-final",
          deliveryId: "warning-delivery",
          intentId: "warning-intent",
          sessionKey,
          storePath,
        });
        expect(queued[0]?.recoveryState).toBe(
          failure === "not-sent" ? undefined : "send_attempt_started",
        );
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "failed",
          reason: "agent-tool-failure",
          silent: true,
        });
      } else if (sibling) {
        expect(sessionStore[sessionKey]?.pendingFinalDelivery).toMatchObject({
          kind: "replayable",
          text: pendingText,
          deliveries: [
            { id: "original-delivery", state: "prepared" },
            { id: "warning-delivery", state: "delivered" },
          ],
        });
      } else {
        expect(sessionStore[sessionKey]?.pendingFinalDelivery).toBeUndefined();
      }
    });
  });

  it.each(["agent-tool-failure", "agent-runner-failure"] as const)(
    "preserves %s when channel readiness throws",
    async (reason) => {
      await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createConfig({ tmpDir, storePath });
        await seedTelegramSession(storePath, cfg);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "telegram",
              source: "test",
              plugin: {
                ...heartbeatRunnerTelegramPlugin,
                heartbeat: {
                  checkReady: async () => {
                    throw new Error("readiness probe failed");
                  },
                },
              },
            },
          ]),
        );
        replySpy.mockImplementation(async (_ctx, options) => {
          if (reason === "agent-runner-failure") {
            setHeartbeatAgentTurnStatus(options, "failed");
            return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
          }
          return createTerminalToolFailureReply(
            { outcome: "blocked", notify: true, summary: "Message failed" },
            "Message delivery failed.",
          );
        });
        const sendTelegram = vi.fn();
        expect(await runHeartbeat(cfg, replySpy, sendTelegram)).toEqual({
          status: "failed",
          reason,
        });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(getLastHeartbeatEvent()).toMatchObject({ status: "failed", reason, silent: true });
      });
    },
  );

  it("preserves media when delivering a plain terminal failure reply", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      const mediaUrl = "https://example.test/failure.png";
      replySpy.mockResolvedValue(
        setReplyPayloadMetadata(
          { text: "Message delivery failed.", mediaUrl },
          { heartbeatTerminalToolFailure: { toolName: "message" } },
        ),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).toHaveBeenCalledOnce();
      expect(sendTelegram.mock.calls[0]?.[2]).toMatchObject({ mediaUrl });
    });
  });
});
