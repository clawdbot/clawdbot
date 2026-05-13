import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import {
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "../infra/heartbeat-runner.test-utils.js";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  enqueueCommitmentExtraction,
  resetCommitmentExtractionRuntimeForTests,
} from "./runtime.js";
import { loadCommitmentStore } from "./store.js";
import type { CommitmentExtractionBatchResult, CommitmentExtractionItem } from "./types.js";

installHeartbeatRunnerTestRuntime();

describe("commitments full-chain integration", () => {
  const writeMs = Date.parse("2026-04-29T16:00:00.000Z");
  const dueMs = writeMs + 10 * 60_000;

  afterEach(() => {
    resetCommitmentExtractionRuntimeForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("flows from hidden extraction to stored commitment to scoped heartbeat delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(writeMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
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
      configureCommitmentExtractionRuntime({
        forceInTests: true,
        extractBatch: vi.fn(
          async ({
            items,
          }: {
            items: CommitmentExtractionItem[];
          }): Promise<CommitmentExtractionBatchResult> => ({
            candidates: (() => {
              const [firstItem] = items;
              if (!firstItem) {
                throw new Error("Expected commitment extraction item");
              }
              return [
                {
                  itemId: firstItem.itemId,
                  kind: "event_check_in",
                  sensitivity: "routine",
                  source: "inferred_user_context",
                  reason: "The user mentioned an interview happening today.",
                  suggestedText: "How did the interview go?",
                  dedupeKey: "interview:2026-04-29",
                  confidence: 0.93,
                  dueWindow: {
                    earliest: new Date(dueMs).toISOString(),
                    latest: new Date(dueMs + 60 * 60_000).toISOString(),
                    timezone: "America/Los_Angeles",
                  },
                },
              ];
            })(),
          }),
        ),
        setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      });

      expect(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: writeMs,
          agentId: "main",
          sessionKey,
          channel: "telegram",
          accountId: "primary",
          to: "155462274",
          sourceMessageId: "qa-message-1",
          userText: "I have an interview later today.",
          assistantText: "Good luck, I hope it goes well.",
        }),
      ).toBe(true);
      await expect(drainCommitmentExtractionQueue()).resolves.toBe(1);

      const pendingStore = await loadCommitmentStore();
      expect(pendingStore.commitments).toHaveLength(1);
      const [pendingCommitment] = pendingStore.commitments;
      if (!pendingCommitment) {
        throw new Error("Expected pending commitment");
      }
      expect(pendingCommitment.status).toBe("pending");
      expect(pendingCommitment.agentId).toBe("main");
      expect(pendingCommitment.sessionKey).toBe(sessionKey);
      expect(pendingCommitment.channel).toBe("telegram");
      expect(pendingCommitment.to).toBe("155462274");
      expect(pendingCommitment.suggestedText).toBe("How did the interview go?");
      expect(pendingCommitment.dueWindow.earliestMs).toBe(dueMs);
      expect(pendingCommitment).not.toHaveProperty("sourceUserText");
      expect(pendingCommitment).not.toHaveProperty("sourceAssistantText");

      vi.setSystemTime(dueMs + 60_000);
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      replySpy.mockImplementation(
        async (
          ctx: { Body?: string; OriginatingChannel?: string; OriginatingTo?: string },
          opts?: { disableTools?: boolean },
        ) => {
          if (!opts) {
            throw new Error("Expected commitment heartbeat reply options");
          }
          expect(ctx.Body).toContain("Due inferred follow-up commitments");
          expect(ctx.Body).toContain("How did the interview go?");
          expect(ctx.Body).not.toContain("I have an interview later today.");
          expect(ctx.Body).not.toContain("Good luck, I hope it goes well.");
          expect(ctx.OriginatingChannel).toBe("telegram");
          expect(ctx.OriginatingTo).toBe("155462274");
          expect(opts.disableTools).toBe(true);
          return { text: "How did the interview go?" };
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
          nowMs: () => dueMs + 60_000,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledOnce();
      const sendCall = sendTelegram.mock.calls[0];
      if (!sendCall) {
        throw new Error("Expected Telegram send call");
      }
      expect(sendCall[0]).toBe("155462274");
      expect(sendCall[1]).toBe("How did the interview go?");
      expect(sendCall[2]?.accountId).toBe("primary");
      const deliveredStore = await loadCommitmentStore();
      const [deliveredCommitment] = deliveredStore.commitments;
      if (!deliveredCommitment) {
        throw new Error("Expected delivered commitment");
      }
      expect(deliveredCommitment.status).toBe("sent");
      expect(deliveredCommitment.attempts).toBe(1);
      expect(deliveredCommitment.sentAtMs).toBe(dueMs + 60_000);
    });
  });
});
