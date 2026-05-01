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
            candidates: [
              {
                itemId: items[0]?.itemId ?? "",
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
            ],
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
      expect(pendingStore.commitments[0]).toMatchObject({
        status: "pending",
        agentId: "main",
        sessionKey,
        channel: "telegram",
        to: "155462274",
        suggestedText: "How did the interview go?",
      });
      expect(pendingStore.commitments[0]?.dueWindow.earliestMs).toBe(dueMs);
      expect(pendingStore.commitments[0]).not.toHaveProperty("sourceUserText");
      expect(pendingStore.commitments[0]).not.toHaveProperty("sourceAssistantText");

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
          expect(ctx.Body).toContain("Due inferred follow-up commitments");
          expect(ctx.Body).toContain("How did the interview go?");
          expect(ctx.Body).not.toContain("I have an interview later today.");
          expect(ctx.Body).not.toContain("Good luck, I hope it goes well.");
          expect(ctx.OriginatingChannel).toBe("telegram");
          expect(ctx.OriginatingTo).toBe("155462274");
          expect(opts?.disableTools).toBe(true);
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
      expect(sendTelegram).toHaveBeenCalledWith(
        "155462274",
        "How did the interview go?",
        expect.objectContaining({ accountId: "primary" }),
      );
      const deliveredStore = await loadCommitmentStore();
      expect(deliveredStore.commitments[0]).toMatchObject({
        status: "sent",
        attempts: 1,
        sentAtMs: dueMs + 60_000,
      });
    });
  });
});
