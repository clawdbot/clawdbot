// Exercises commitment heartbeat policy through end-to-end runtime flows.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import {
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "../infra/heartbeat-runner.test-utils.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "./store.test-utils.js";
import type { CommitmentRecord } from "./types.js";

vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
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

installHeartbeatRunnerTestRuntime();

describe("commitments heartbeat delivery policy e2e", () => {
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const sessionKey = "agent:main:telegram:user-155462274";

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function commitment(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
    return {
      id: "cm_target_none",
      agentId: "main",
      sessionKey,
      channel: "telegram",
      accountId: "primary",
      to: "155462274",
      kind: "care_check_in",
      sensitivity: "care",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they were exhausted yesterday.",
      suggestedText: "Did you get some rest?",
      dedupeKey: "sleep:2026-04-28",
      confidence: 0.94,
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
      ...overrides,
    };
  }

  it("does not send externally when heartbeat target is none", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
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
        };
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "155462274",
        });
        seedCommitmentsForTest([commitment()]);

        const sendTelegram = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "155462274",
        });
        replySpy.mockImplementation(
          async (
            ctx: { Body?: string; OriginatingChannel?: string; OriginatingTo?: string },
            opts?: { disableTools?: boolean },
          ) => {
            expect(ctx.Body).not.toContain("Due inferred follow-up commitments");
            expect(ctx.Body).not.toContain("Did you get some rest?");
            expect(ctx.Body).not.toContain("CALL_TOOL");
            expect(ctx.OriginatingChannel).toBeUndefined();
            expect(ctx.OriginatingTo).toBeUndefined();
            expect(opts?.disableTools).toBeUndefined();
            return { text: "internal heartbeat only" };
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

        expect(result.status).toBe("ran");
        expect(sendTelegram).not.toHaveBeenCalled();
        const [persistedCommitment] = readCommitmentsForTest();
        if (!persistedCommitment) {
          throw new Error("missing persisted commitment");
        }
        expect(persistedCommitment.id).toBe("cm_target_none");
        expect(persistedCommitment.status).toBe("pending");
        expect(persistedCommitment.attempts).toBe(0);
        expect(persistedCommitment).not.toHaveProperty("sourceUserText");
        expect(persistedCommitment).not.toHaveProperty("sourceAssistantText");
      });
    });
  });
});
