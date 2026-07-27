// Memory Core plugin module implements dreaming shadow trial behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";

export type DreamingShadowTrialVerdict = "helpful" | "neutral" | "harmful";
export type DreamingShadowTrialRecommendation = "promote" | "defer" | "reject";

export type DreamingShadowTrialInput = {
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  reason: string;
  riskFlags?: string[];
  evidenceRefs?: string[];
  workspaceDir?: string;
  reportPath?: string;
  nowMs?: number;
  timezone?: string;
};

export type DreamingShadowTrialReport = {
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  recommendation: DreamingShadowTrialRecommendation;
  reason: string;
  riskFlags: string[];
  evidenceRefs: string[];
  promotionAction: "report-only";
  reportPath?: string;
  markdown: string;
};

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error(`dreaming shadow trial requires ${label}`);
  }
  return normalized;
}

function normalizeList(values: string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [fallback];
}

function normalizeDataList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

export function resolveDreamingShadowTrialRecommendation(
  verdict: DreamingShadowTrialVerdict,
): DreamingShadowTrialRecommendation {
  if (verdict === "helpful") {
    return "promote";
  }
  if (verdict === "harmful") {
    return "reject";
  }
  return "defer";
}

function formatList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function resolveReportContentHash(params: {
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  reason: string;
  riskFlags: string[];
  evidenceRefs: string[];
}): string {
  const seed = JSON.stringify([
    params.candidate,
    params.trialPrompt,
    params.baselineOutcome,
    params.candidateOutcome,
    params.verdict,
    params.reason,
    params.riskFlags,
    params.evidenceRefs,
  ]);
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

export function defaultDreamingShadowTrialReportPath(params: {
  workspaceDir: string;
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  reason: string;
  riskFlags?: string[];
  evidenceRefs?: string[];
  nowMs?: number;
  timezone?: string;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const day = formatMemoryDreamingDay(nowMs, params.timezone);
  const contentHash = resolveReportContentHash({
    candidate: normalizeRequiredText(params.candidate, "candidate"),
    trialPrompt: normalizeRequiredText(params.trialPrompt, "trialPrompt"),
    baselineOutcome: normalizeRequiredText(params.baselineOutcome, "baselineOutcome"),
    candidateOutcome: normalizeRequiredText(params.candidateOutcome, "candidateOutcome"),
    verdict: params.verdict,
    reason: normalizeRequiredText(params.reason, "reason"),
    riskFlags: normalizeDataList(params.riskFlags),
    evidenceRefs: normalizeDataList(params.evidenceRefs),
  });
  return path.join(
    params.workspaceDir,
    "memory",
    "dreaming",
    "shadow-trials",
    day,
    `${contentHash}.md`,
  );
}

function resolveReportPath(params: {
  workspaceDir?: string;
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  reason: string;
  riskFlags: string[];
  evidenceRefs: string[];
  reportPath?: string;
  nowMs?: number;
  timezone?: string;
}): string | undefined {
  if (params.reportPath) {
    if (path.isAbsolute(params.reportPath)) {
      return params.reportPath;
    }
    if (!params.workspaceDir) {
      throw new Error("dreaming shadow trial relative reportPath requires workspaceDir");
    }
    return path.join(params.workspaceDir, params.reportPath);
  }
  if (!params.workspaceDir) {
    return undefined;
  }
  return defaultDreamingShadowTrialReportPath({
    workspaceDir: params.workspaceDir,
    candidate: params.candidate,
    trialPrompt: params.trialPrompt,
    baselineOutcome: params.baselineOutcome,
    candidateOutcome: params.candidateOutcome,
    verdict: params.verdict,
    reason: params.reason,
    riskFlags: params.riskFlags,
    evidenceRefs: params.evidenceRefs,
    nowMs: params.nowMs,
    timezone: params.timezone,
  });
}

export function buildDreamingShadowTrialReport(
  input: DreamingShadowTrialInput,
): DreamingShadowTrialReport {
  const candidate = normalizeRequiredText(input.candidate, "candidate");
  const trialPrompt = normalizeRequiredText(input.trialPrompt, "trialPrompt");
  const baselineOutcome = normalizeRequiredText(input.baselineOutcome, "baselineOutcome");
  const candidateOutcome = normalizeRequiredText(input.candidateOutcome, "candidateOutcome");
  const reason = normalizeRequiredText(input.reason, "reason");
  const riskFlags = normalizeDataList(input.riskFlags);
  const evidenceRefs = normalizeDataList(input.evidenceRefs);
  const recommendation = resolveDreamingShadowTrialRecommendation(input.verdict);
  const reportPath = resolveReportPath({
    workspaceDir: input.workspaceDir,
    candidate,
    trialPrompt,
    baselineOutcome,
    candidateOutcome,
    verdict: input.verdict,
    reason,
    riskFlags,
    evidenceRefs,
    reportPath: input.reportPath,
    nowMs: input.nowMs,
    timezone: input.timezone,
  });

  const markdown = [
    "# Dreaming Shadow Trial Report",
    "",
    `candidate: ${candidate}`,
    `trial prompt: ${trialPrompt}`,
    `baseline outcome: ${baselineOutcome}`,
    `candidate outcome: ${candidateOutcome}`,
    `verdict: ${input.verdict}`,
    `recommendation: ${recommendation}`,
    `reason: ${reason}`,
    "risk flags:",
    formatList(normalizeList(riskFlags, "none recorded")),
    "evidence refs:",
    formatList(normalizeList(evidenceRefs, "none supplied")),
    "promotion action: report-only",
    "",
  ].join("\n");

  return {
    candidate,
    trialPrompt,
    baselineOutcome,
    candidateOutcome,
    verdict: input.verdict,
    recommendation,
    reason,
    riskFlags,
    evidenceRefs,
    promotionAction: "report-only",
    ...(reportPath ? { reportPath } : {}),
    markdown,
  };
}

export async function writeDreamingShadowTrialReport(
  input: DreamingShadowTrialInput & { workspaceDir: string },
): Promise<DreamingShadowTrialReport> {
  const report = buildDreamingShadowTrialReport(input);
  if (!report.reportPath) {
    throw new Error("dreaming shadow trial report path could not be resolved");
  }
  await fs.mkdir(path.dirname(report.reportPath), { recursive: true });
  await fs.writeFile(report.reportPath, report.markdown, "utf-8");
  return report;
}
