// Qa Lab plugin module renders Mantis comparison evidence.
import path from "node:path";
import type { LaneResult } from "./run-artifacts.runtime.js";

export type MantisScenarioConfig = {
  baselineExpected: string;
  baselineLabel: string;
  baselineScreenshotAlt: string;
  candidateExpected: string;
  candidateLabel: string;
  candidateScreenshotAlt: string;
  defaultBaselineRef: string;
  id: string;
  title: string;
};

export type MantisComparison = {
  baseline: {
    expected: string;
    ref: string;
    reproduced: boolean;
    screenshotPath?: string;
    status: string;
    videoPath?: string;
  };
  candidate: {
    expected: string;
    fixed: boolean;
    ref: string;
    screenshotPath?: string;
    status: string;
    videoPath?: string;
  };
  pass: boolean;
  scenario: string;
  transport: "discord";
};

export function renderReport(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: MantisComparison;
  outputDir: string;
  scenarioConfig: MantisScenarioConfig;
}) {
  const lines = [
    `# ${params.scenarioConfig.title}`,
    "",
    `Status: ${params.comparison.pass ? "pass" : "fail"}`,
    `Transport: ${params.comparison.transport}`,
    `Scenario: ${params.comparison.scenario}`,
    `Output: ${params.outputDir}`,
    "",
    "## Baseline",
    "",
    `- Ref: \`${params.comparison.baseline.ref}\``,
    `- Expected: ${params.comparison.baseline.expected}`,
    `- Status: \`${params.baseline.status}\``,
    `- Reproduced: \`${params.comparison.baseline.reproduced}\``,
    params.baseline.screenshotPath
      ? `- Screenshot: \`${path.join("baseline", path.basename(params.baseline.screenshotPath))}\``
      : "- Screenshot: missing",
    params.baseline.videoPath
      ? `- Video: \`${path.join("baseline", path.basename(params.baseline.videoPath))}\``
      : "- Video: missing",
    params.baseline.scenarioDetails ? `- Details: ${params.baseline.scenarioDetails}` : undefined,
    "",
    "## Candidate",
    "",
    `- Ref: \`${params.comparison.candidate.ref}\``,
    `- Expected: ${params.comparison.candidate.expected}`,
    `- Status: \`${params.candidate.status}\``,
    `- Fixed: \`${params.comparison.candidate.fixed}\``,
    params.candidate.screenshotPath
      ? `- Screenshot: \`${path.join("candidate", path.basename(params.candidate.screenshotPath))}\``
      : "- Screenshot: missing",
    params.candidate.videoPath
      ? `- Video: \`${path.join("candidate", path.basename(params.candidate.videoPath))}\``
      : "- Video: missing",
    params.candidate.scenarioDetails ? `- Details: ${params.candidate.scenarioDetails}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

function relativeArtifactPath(outputDir: string, artifactPath: string | undefined) {
  if (!artifactPath) {
    return undefined;
  }
  return path.isAbsolute(artifactPath) ? path.relative(outputDir, artifactPath) : artifactPath;
}

export function buildEvidenceManifest(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: MantisComparison;
  outputDir: string;
  scenarioConfig: MantisScenarioConfig;
}) {
  const artifacts: {
    alt?: string;
    kind: string;
    label: string;
    lane: "baseline" | "candidate" | "run";
    path: string;
    required?: boolean;
    targetPath: string;
    width?: number;
  }[] = [
    {
      kind: "metadata",
      label: "Comparison JSON",
      lane: "run",
      path: "comparison.json",
      targetPath: "comparison.json",
    },
    {
      kind: "report",
      label: "Mantis report",
      lane: "run",
      path: "mantis-report.md",
      targetPath: "mantis-report.md",
    },
  ];
  const baselineScreenshot = relativeArtifactPath(params.outputDir, params.baseline.screenshotPath);
  if (baselineScreenshot) {
    artifacts.push({
      alt: params.scenarioConfig.baselineScreenshotAlt,
      kind: "timeline",
      label: params.scenarioConfig.baselineLabel,
      lane: "baseline",
      path: baselineScreenshot,
      targetPath: "baseline.png",
      width: 420,
    });
  }
  const candidateScreenshot = relativeArtifactPath(
    params.outputDir,
    params.candidate.screenshotPath,
  );
  if (candidateScreenshot) {
    artifacts.push({
      alt: params.scenarioConfig.candidateScreenshotAlt,
      kind: "timeline",
      label: params.scenarioConfig.candidateLabel,
      lane: "candidate",
      path: candidateScreenshot,
      targetPath: "candidate.png",
      width: 420,
    });
  }
  const baselineVideo = relativeArtifactPath(params.outputDir, params.baseline.videoPath);
  if (baselineVideo) {
    artifacts.push({
      kind: "fullVideo",
      label: "Baseline MP4",
      lane: "baseline",
      path: baselineVideo,
      targetPath: "baseline.mp4",
      required: false,
    });
  }
  const candidateVideo = relativeArtifactPath(params.outputDir, params.candidate.videoPath);
  if (candidateVideo) {
    artifacts.push({
      kind: "fullVideo",
      label: "Candidate MP4",
      lane: "candidate",
      path: candidateVideo,
      targetPath: "candidate.mp4",
      required: false,
    });
  }

  return {
    artifacts,
    comparison: params.comparison,
    id: params.comparison.scenario,
    scenario: params.comparison.scenario,
    schemaVersion: 1,
    summary:
      "Mantis ran the before/after scenario, captured baseline and candidate evidence, and compared the expected bug reproduction against the candidate fix.",
    title: params.scenarioConfig.title,
  };
}
