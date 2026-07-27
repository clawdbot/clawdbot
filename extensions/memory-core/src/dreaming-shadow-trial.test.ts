// Memory Core tests cover dreaming shadow trial plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDreamingShadowTrialReport,
  defaultDreamingShadowTrialReportPath,
  resolveDreamingShadowTrialRecommendation,
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
      timezone: "UTC",
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

  it("keeps missing evidence as empty machine data while rendering markdown placeholders", () => {
    const report = buildDreamingShadowTrialReport({
      ...baseInput,
      verdict: "neutral",
      riskFlags: [],
      evidenceRefs: [],
    });

    expect(report.riskFlags).toEqual([]);
    expect(report.evidenceRefs).toEqual([]);
    expect(report.markdown).toContain("- none recorded");
    expect(report.markdown).toContain("- none supplied");
  });
});
