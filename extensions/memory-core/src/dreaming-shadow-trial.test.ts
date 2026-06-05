// Memory Core tests cover dreaming shadow trial plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDreamingShadowTrialReport,
  defaultDreamingShadowTrialReportPath,
  rankDreamingShadowTrialCandidates,
  resolveDreamingShadowTrialRecommendation,
  scoreDreamingShadowTrialCandidate,
  writeDreamingShadowTrialReport,
} from "./dreaming-shadow-trial.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

const baseInput = {
  candidate: "The user prefers release notes with exact verification commands.",
  trialPrompt: "Prepare a release readiness note.",
  baselineOutcome: "Mentions tests passed without the exact command.",
  candidateOutcome: "Includes the exact verification command and remaining risk.",
  reason: "The candidate improves the release reply without exposing private data.",
  riskFlags: ["no secret exposure", "no outdated preference conflict"],
  evidenceRefs: ["memory/2026-05-18.md#L30-L49"],
};

describe("dreaming shadow trial runner", () => {
  it("maps verdicts to report-only recommendations", () => {
    expect(resolveDreamingShadowTrialRecommendation("helpful")).toBe("promote");
    expect(resolveDreamingShadowTrialRecommendation("neutral")).toBe("defer");
    expect(resolveDreamingShadowTrialRecommendation("harmful")).toBe("reject");
  });

  it("builds the stable shadow-trial report contract", () => {
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "helpful",
      nowMs: Date.parse("2026-05-18T18:00:00.000Z"),
    });

    expect(report.recommendation).toBe("promote");
    expect(report.promotionAction).toBe("report-only");
    expect(report.markdown).toContain("candidate: The user prefers release notes");
    expect(report.markdown).toContain("baseline outcome: Mentions tests passed");
    expect(report.markdown).toContain("candidate outcome: Includes the exact verification command");
    expect(report.markdown).toContain("verdict: helpful");
    expect(report.markdown).toContain("recommendation: promote");
    expect(report.markdown).toContain("risk flags:");
    expect(report.markdown).toContain("- no secret exposure");
    expect(report.markdown).toContain("evidence refs:");
    expect(report.markdown).toContain("promotion action: report-only");
    expect(report.markdown).not.toContain("promoted to MEMORY.md");
  });

  it("writes only the shadow-trial report and leaves MEMORY.md unchanged", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-shadow-trial-");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Memory\n\nExisting durable memory.\n", "utf-8");

    const report = await writeDreamingShadowTrialReport({
      ...baseInput,
      verdict: "neutral",
      workspaceDir,
      nowMs: Date.parse("2026-05-18T18:00:00.000Z"),
    });

    expect(report.recommendation).toBe("defer");
    expect(path.dirname(report.reportPath!)).toBe(
      path.join(workspaceDir, "memory", "dreaming", "shadow-trials", "2026-05-18"),
    );
    expect(path.basename(report.reportPath!)).toMatch(/^[a-f0-9]{12}\.md$/);
    await expect(fs.readFile(memoryPath, "utf-8")).resolves.toBe(
      "# Memory\n\nExisting durable memory.\n",
    );
    expect(report.reportPath).toBeTruthy();
    await expect(fs.readFile(report.reportPath!, "utf-8")).resolves.toContain(
      "promotion action: report-only",
    );
  });

  it("uses the configured dreaming timezone for the default report day", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-shadow-trial-timezone-");

    const report = await writeDreamingShadowTrialReport({
      ...baseInput,
      verdict: "helpful",
      workspaceDir,
      nowMs: Date.parse("2026-05-18T21:30:00.000Z"),
      timezone: "Asia/Riyadh",
    });

    expect(path.dirname(report.reportPath!)).toBe(
      path.join(workspaceDir, "memory", "dreaming", "shadow-trials", "2026-05-19"),
    );
    expect(path.basename(report.reportPath!)).toMatch(/^[a-f0-9]{12}\.md$/);
    await expect(fs.readFile(report.reportPath!, "utf-8")).resolves.toContain(
      "recommendation: promote",
    );
  });

  it("keeps distinct same-day trials in separate default report files", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-shadow-trial-collisions-");
    const nowMs = Date.parse("2026-05-18T18:00:00.000Z");

    const first = await writeDreamingShadowTrialReport({
      ...baseInput,
      verdict: "helpful",
      workspaceDir,
      nowMs,
    });
    const second = await writeDreamingShadowTrialReport({
      ...baseInput,
      candidate: "The user prefers terse release notes with exact verification commands.",
      verdict: "helpful",
      workspaceDir,
      nowMs,
    });

    expect(first.reportPath).not.toBe(second.reportPath);
    expect(path.dirname(first.reportPath!)).toBe(path.dirname(second.reportPath!));
    await expect(fs.readFile(first.reportPath!, "utf-8")).resolves.toContain(
      "candidate: The user prefers release notes",
    );
    await expect(fs.readFile(second.reportPath!, "utf-8")).resolves.toContain(
      "candidate: The user prefers terse release notes",
    );
  });

  it("keeps risky candidates reject-only without promoting durable memory", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-shadow-trial-risk-");
    const reportPath = defaultDreamingShadowTrialReportPath({
      ...baseInput,
      candidate: "The user always wants private tokens pasted into status reports.",
      candidateOutcome: "Includes a private token in the release reply.",
      verdict: "harmful",
      reason: "The candidate creates secret exposure risk.",
      riskFlags: ["secret exposure"],
      workspaceDir,
      nowMs: Date.parse("2026-05-19T01:00:00.000Z"),
    });

    const report = await writeDreamingShadowTrialReport({
      ...baseInput,
      candidate: "The user always wants private tokens pasted into status reports.",
      candidateOutcome: "Includes a private token in the release reply.",
      verdict: "harmful",
      reason: "The candidate creates secret exposure risk.",
      riskFlags: ["secret exposure"],
      workspaceDir,
      reportPath,
    });

    expect(report.recommendation).toBe("reject");
    expect(report.markdown).toContain("verdict: harmful");
    expect(report.markdown).toContain("recommendation: reject");
    expect(report.markdown).toContain("promotion action: report-only");
    await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scores helpful shadow-trial results as a bounded report-only boost", () => {
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "helpful",
    });

    const scored = scoreDreamingShadowTrialCandidate({ key: "candidate-a", score: 0.98 }, report);

    expect(scored.scoreBeforeShadowTrial).toBe(0.98);
    expect(scored.shadowTrialScoreDelta).toBe(0.04);
    expect(scored.scoreAfterShadowTrial).toBe(1);
    expect(scored.shadowTrialVerdict).toBe("helpful");
    expect(scored.shadowTrialRecommendation).toBe("promote");
    expect(scored.rejectedByShadowTrial).toBe(false);
    expect(scored.scoringAction).toBe("report-only");
  });

  it("leaves neutral shadow-trial results deferred without raising the score", () => {
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "neutral",
    });

    const scored = scoreDreamingShadowTrialCandidate({ key: "candidate-a", score: 0.79 }, report);

    expect(scored.scoreBeforeShadowTrial).toBe(0.79);
    expect(scored.shadowTrialScoreDelta).toBe(0);
    expect(scored.scoreAfterShadowTrial).toBe(0.79);
    expect(scored.shadowTrialRecommendation).toBe("defer");
    expect(scored.rejectedByShadowTrial).toBe(false);
  });

  it("rejects harmful shadow-trial results without writing durable memory", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-shadow-trial-score-risk-");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Memory\n\nExisting durable memory.\n", "utf-8");
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      candidate: "The user wants private credentials copied into reports.",
      verdict: "harmful",
      reason: "The candidate would normalize credential exposure.",
      riskFlags: ["credential exposure"],
    });

    const scored = scoreDreamingShadowTrialCandidate({ key: "candidate-a", score: 0.92 }, report);

    expect(scored.scoreBeforeShadowTrial).toBe(0.92);
    expect(scored.scoreAfterShadowTrial).toBe(0);
    expect(scored.shadowTrialScoreDelta).toBe(-1);
    expect(scored.shadowTrialRecommendation).toBe("reject");
    expect(scored.shadowTrialRiskFlags).toContain("credential exposure");
    expect(scored.rejectedByShadowTrial).toBe(true);
    await expect(fs.readFile(memoryPath, "utf-8")).resolves.toBe(
      "# Memory\n\nExisting durable memory.\n",
    );
  });

  it("ranks candidates with shadow-trial score adjustments while keeping rejections last", () => {
    const helpfulReport = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "helpful",
    });
    const harmfulReport = buildDreamingShadowTrialReport({
      ...baseInput,
      candidate: "The user wants private credentials copied into reports.",
      verdict: "harmful",
      reason: "The candidate would normalize credential exposure.",
      riskFlags: ["credential exposure"],
    });
    const helpful = { key: "helpful", score: 0.74 };
    const untested = { key: "untested", score: 0.76 };
    const harmful = { key: "harmful", score: 0.99 };
    const reports = new Map([
      [helpful.key, helpfulReport],
      [harmful.key, harmfulReport],
    ]);

    const ranked = rankDreamingShadowTrialCandidates([harmful, untested, helpful], reports);

    expect(ranked.map((entry) => entry.candidate.key)).toEqual(["helpful", "untested", "harmful"]);
    expect(ranked[0]?.scoreAfterShadowTrial).toBe(0.78);
    expect(ranked[1]?.shadowTrialRiskFlags).toEqual(["not shadow-trialed"]);
    expect(ranked[1]?.shadowTrialEvidenceRefs).toEqual([]);
    expect(ranked[2]?.rejectedByShadowTrial).toBe(true);
  });

  it("keeps missing evidence as empty machine data while rendering markdown placeholders", () => {
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "neutral",
      riskFlags: [],
      evidenceRefs: [],
    });

    const scored = scoreDreamingShadowTrialCandidate({ key: "candidate-a", score: 0.7 }, report);

    expect(report.riskFlags).toEqual([]);
    expect(report.evidenceRefs).toEqual([]);
    expect(report.markdown).toContain("- none recorded");
    expect(report.markdown).toContain("- none supplied");
    expect(scored.shadowTrialRiskFlags).toEqual([]);
    expect(scored.shadowTrialEvidenceRefs).toEqual([]);
  });
});
