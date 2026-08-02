import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

vi.mock("../commitments/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commitments/config.js")>()),
  resolveCommitmentsConfig: () => ({
    enabled: true,
    maxPerDay: 3,
    extraction: {
      debounceMs: 15_000,
      batchMaxItems: 8,
      queueMaxItems: 64,
      confidenceThreshold: 0.72,
      careConfidenceThreshold: 0.86,
      timeoutSeconds: 45,
    },
  }),
}));

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce cross-channel commitments", () => {
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    setHeartbeatsEnabled(true);
    vi.unstubAllEnvs();
    envSnapshot.restore();
  });

  it.each(["gchat", "google-chat", " GCHAT "])(
    "retains the configured account for a same-channel heartbeat alias (%s)",
    async (heartbeatTarget) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const sessionKey = "agent:main:googlechat:spaces-room";
        const sendGoogleChat = vi.fn();
        const plugin = createOutboundTestPlugin({
          id: "googlechat",
          outbound: {
            deliveryMode: "direct",
            sendText: async ({ to, text, accountId }) => {
              sendGoogleChat(to, text, { accountId });
              return { channel: "googlechat", messageId: "m1" };
            },
          },
        });
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "googlechat", plugin, source: "test" }]),
        );
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: heartbeatTarget,
                accountId: "configured",
              },
            },
          },
          channels: {
            googlechat: {
              accounts: { default: {}, configured: {} },
            },
          },
          session: { store: storePath },
        };
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "googlechat",
          lastProvider: "googlechat",
          lastTo: "spaces/room",
        });
        const commitment: CommitmentRecord = {
          id: "cm_same_channel_alias",
          agentId: "main",
          sessionKey,
          channel: "googlechat",
          to: "spaces/room",
          kind: "event_check_in",
          sensitivity: "routine",
          source: "inferred_user_context",
          status: "pending",
          reason: "The user asked for a follow-up.",
          suggestedText: "How did the interview go?",
          dedupeKey: "same-channel-alias-account",
          confidence: 0.92,
          dueWindow: { earliestMs: nowMs - 60_000, latestMs: nowMs + 60_000, timezone: "UTC" },
          createdAtMs: nowMs - 120_000,
          updatedAtMs: nowMs - 120_000,
          attempts: 0,
        };
        seedCommitmentsForTest([commitment]);
        replySpy.mockImplementation(async (ctx) => {
          expect(ctx.Body).toContain(HEARTBEAT_TOKEN);
          expect(ctx.OriginatingChannel).toBe("googlechat");
          expect(ctx.OriginatingTo).toBe("spaces/room");
          return { text: "How did the interview go?" };
        });

        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        expect(result.status).toBe("ran");
        expect(sendGoogleChat).toHaveBeenCalledWith("spaces/room", "How did the interview go?", {
          accountId: "configured",
        });
        expect(readCommitmentsForTest()[0]).toMatchObject({
          id: commitment.id,
          status: "sent",
          attempts: 1,
          sentAtMs: nowMs,
        });
      });
    },
  );

  it("does not apply a configured heartbeat account to an accountless commitment on another channel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last", accountId: "configured" },
          },
        },
        channels: {
          slack: { allowFrom: ["*"] },
          telegram: {
            allowFrom: ["*"],
            accounts: {
              configured: { botToken: "heartbeat-token" },
              primary: { botToken: "primary-token" },
            },
          },
        },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "155462274",
      });
      const commitment: CommitmentRecord = {
        id: "cm_cross_channel",
        agentId: "main",
        sessionKey,
        channel: "slack",
        to: "C123",
        kind: "event_check_in",
        sensitivity: "routine",
        source: "inferred_user_context",
        status: "pending",
        reason: "The user asked for a follow-up.",
        suggestedText: "How did the interview go?",
        dedupeKey: "cross-channel-account",
        confidence: 0.92,
        dueWindow: { earliestMs: nowMs - 60_000, latestMs: nowMs + 60_000, timezone: "UTC" },
        createdAtMs: nowMs - 120_000,
        updatedAtMs: nowMs - 120_000,
        attempts: 0,
      };
      seedCommitmentsForTest([commitment]);

      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });
      const sendTelegram = vi.fn();
      replySpy.mockImplementation(async (ctx) => {
        expect(ctx.Body).toContain(HEARTBEAT_TOKEN);
        expect(ctx.OriginatingChannel).toBe("slack");
        expect(ctx.OriginatingTo).toBe("C123");
        return { text: "How did the interview go?" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          telegram: sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(sendSlack).toHaveBeenCalledWith(
        "C123",
        "How did the interview go?",
        expect.objectContaining({ accountId: undefined }),
      );
      expect(readCommitmentsForTest()[0]).toMatchObject({
        id: commitment.id,
        status: "sent",
        attempts: 1,
        sentAtMs: nowMs,
      });
    });
  });
});
