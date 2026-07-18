import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { SkillHistoryScanCandidate } from "./history-scan-candidates.js";
import type { SkillHistoryScanPromptSession } from "./history-scan-prompt.js";

type ReadHistoryScanSession = (
  params: Parameters<typeof import("./history-scan-transcript.js").readHistoryScanSession>[0],
) => Promise<SkillHistoryScanPromptSession | undefined>;
type RunSkillHistoryScanReview =
  typeof import("./history-scan-review.js").runSkillHistoryScanReview;

const mocks = vi.hoisted(() => ({
  candidates: [] as SkillHistoryScanCandidate[],
  getProgress: vi.fn(async () => ({ mutationCount: 0, proposalIds: [] as string[] })),
  readSession: vi.fn<ReadHistoryScanSession>(),
  review: vi.fn<RunSkillHistoryScanReview>(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => undefined),
  resolveAgentDir: vi.fn(() => "/tmp/openclaw-history-scan-agent"),
}));

vi.mock("../../agents/embedded-agent-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: { contextTokens: 8_192, contextWindow: 8_192 },
  })),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  isEmbeddedAgentRunActive: vi.fn(() => false),
}));

vi.mock("../../agents/model-selection-config.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ model: "gpt-5.5", provider: "openai" })),
}));

vi.mock("./history-scan-candidates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./history-scan-candidates.js")>()),
  listHistoryScanCandidates: vi.fn(() => mocks.candidates),
  selectSkillHistoryScanCandidates: vi.fn(
    (params: { candidates: readonly SkillHistoryScanCandidate[] }) => [...params.candidates],
  ),
}));

vi.mock("./history-scan-review.js", () => ({
  HISTORY_SCAN_SESSION_SEGMENT: "skill-workshop-history-scan",
  runSkillHistoryScanReview: (...args: Parameters<RunSkillHistoryScanReview>) =>
    mocks.review(...args),
}));

vi.mock("./history-scan-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./history-scan-transcript.js")>()),
  readHistoryScanSession: (...args: Parameters<ReadHistoryScanSession>) =>
    mocks.readSession(...args),
}));

vi.mock("./service.js", () => ({
  getSkillProposalRunProgress: mocks.getProgress,
}));

import {
  historyScanStateKey,
  historyScanStore,
  type SkillHistoryScanScope,
} from "./history-scan-state.js";
import { runSkillHistoryScan } from "./history-scan.js";

function candidate(instanceId: string, updatedAtMs: number): SkillHistoryScanCandidate {
  return {
    instanceId,
    sessionKey: `agent:main:${instanceId}`,
    updatedAtMs,
    entry: {
      sessionId: instanceId,
      updatedAt: updatedAtMs,
    },
  };
}

describe("Skill Workshop history scan resume", () => {
  it("excludes malformed sessions before checkpointing and replays the same batch", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-scan-resume-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const storePath = path.join(tempDir, "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") };
    const validUpdatedAtMs = Date.parse("2026-07-16T12:00:00.000Z");
    const invalid = candidate("invalid", validUpdatedAtMs + 1_000);
    const valid = candidate("valid", validUpdatedAtMs);
    const reviewedBatches: string[][] = [];
    mocks.candidates = [invalid, valid];
    mocks.readSession.mockImplementation(async ({ candidate: selected }) => ({
      instanceId: selected.instanceId,
      sessionKey: selected.sessionKey,
      updatedAt:
        selected.instanceId === invalid.instanceId
          ? "not-a-date"
          : new Date(selected.updatedAtMs).toISOString(),
      modelIterations: 6,
      transcript: `completed transcript for ${selected.instanceId}`,
    }));
    mocks.review
      .mockImplementationOnce(async ({ sessions }) => {
        reviewedBatches.push(sessions.map((session) => session.instanceId));
        throw new Error("simulated interrupted history scan");
      })
      .mockImplementationOnce(async ({ onComplete, sessions }) => {
        reviewedBatches.push(sessions.map((session) => session.instanceId));
        await onComplete?.(0);
        return 0;
      });
    const params = {
      agentId: "main",
      config: { session: { store: storePath } },
      env,
      workspaceDir,
    } satisfies SkillHistoryScanScope;

    await fs.mkdir(workspaceDir, { recursive: true });
    try {
      await expect(runSkillHistoryScan(params)).rejects.toThrow(
        "simulated interrupted history scan",
      );
      const stateKey = historyScanStateKey(params.agentId, workspaceDir, storePath);
      expect(historyScanStore(env).lookup(stateKey)?.pending?.sessionCursors).toEqual([
        { instanceId: valid.instanceId, updatedAtMs: validUpdatedAtMs },
      ]);

      await expect(runSkillHistoryScan(params)).resolves.toMatchObject({
        lastScanReviewed: 1,
      });
      expect(reviewedBatches).toEqual([["valid"], ["valid"]]);
      expect(mocks.getProgress).toHaveBeenCalledTimes(1);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(tempDir, { recursive: true, force: true });
      vi.clearAllMocks();
      mocks.candidates = [];
    }
  });
});
