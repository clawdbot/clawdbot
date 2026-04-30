import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { loadCommitmentStore, saveCommitmentStore } from "../commitments/store.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce commitments", () => {
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buildCommitment(params: {
    id: string;
    sessionKey: string;
    to: string;
  }): CommitmentRecord {
    return {
      id: params.id,
      agentId: "main",
      sessionKey: params.sessionKey,
      channel: "telegram",
      accountId: "primary",
      to: params.to,
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.92,
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      sourceUserText: "I have an interview tomorrow.",
      sourceAssistantText: "Good luck, I hope it goes well.",
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
    };
  }

  async function setupCommitmentCase(params?: { replyText?: string }) {
    return await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
        commitments: { enabled: true },
      };
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "stale-target",
      });
      await saveCommitmentStore(undefined, {
        version: 1,
        commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      replySpy.mockImplementation(
        async (ctx: { Body?: string; OriginatingChannel?: string; OriginatingTo?: string }) => {
          expect(ctx.Body).toContain("Due inferred follow-up commitments");
          expect(ctx.Body).toContain("How did the interview go?");
          expect(ctx.OriginatingChannel).toBe("telegram");
          expect(ctx.OriginatingTo).toBe("155462274");
          return { text: params?.replyText ?? "How did the interview go?" };
        },
      );

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      return {
        result,
        sendTelegram,
        store: await loadCommitmentStore(),
      };
    });
  }

  it("delivers due commitments to the original scope even when heartbeat target is none", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase();

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expect(store.commitments[0]).toMatchObject({
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });

  it("dismisses a due commitment when the heartbeat model declines to send a check-in", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase({
      replyText: HEARTBEAT_TOKEN,
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(store.commitments[0]).toMatchObject({
      id: "cm_interview",
      status: "dismissed",
      attempts: 1,
      dismissedAtMs: nowMs,
    });
  });
});
