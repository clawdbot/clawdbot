import { describe, expect, it, vi } from "vitest";
import { runSkillHistoryScanReview } from "./history-scan-review.js";
import { HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS } from "./review-outcome.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn(async () => ({ meta: { durationMs: 1 } })));

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));

describe("Skill Workshop history scan review", () => {
  it("locks the model that sized the history projection", async () => {
    await runSkillHistoryScanReview({
      agentId: "main",
      config: {},
      modelRef: { provider: "openai", model: "gpt-test" },
      onComplete: async () => {},
      onProgress: async () => {},
      progress: {
        proposalIds: [],
        remaining: HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS,
        successfulMutations: 0,
      },
      runId: "history-scan-review-test",
      sessions: [
        {
          instanceId: "session-1",
          sessionKey: "agent:main:main",
          updatedAt: "2026-08-18T00:00:00.000Z",
          modelIterations: 6,
          transcript: "[user]\nRepair it.\n\n[assistant]\nDone.",
        },
      ],
      workspaceDir: "/tmp/openclaw-history-scan-review",
    });

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-test",
        modelSelectionLocked: true,
        modelFallbacksOverride: [],
      }),
    );
  });
});
