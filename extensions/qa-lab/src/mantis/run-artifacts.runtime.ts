// Qa Lab plugin module implements Mantis evidence artifact handling.
import fs from "node:fs/promises";
import path from "node:path";
import { QA_EVIDENCE_FILENAME, validateQaEvidenceSummaryJson } from "../evidence-summary.js";

type DiscordQaSummary = {
  scenarios?: {
    artifactPaths?: Record<string, string>;
    details?: string;
    id?: string;
    status?: string;
    title?: string;
  }[];
};

type NormalizedScenarioSummary = {
  details?: string;
  screenshotPath?: string;
  status: string;
  summaryPath: string;
  videoPath?: string;
};

export type LaneResult = {
  outputDir: string;
  scenarioDetails?: string;
  screenshotPath?: string;
  status: string;
  summaryPath: string;
  videoPath?: string;
};

export async function copyMantisDirContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.rm(targetDir, { force: true, recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function readNormalizedLaneResult(params: {
  publishedLaneDir: string;
  scenario: string;
}): Promise<NormalizedScenarioSummary | undefined> {
  const summaryPath = path.join(params.publishedLaneDir, QA_EVIDENCE_FILENAME);
  let rawSummary: string;
  try {
    rawSummary = await fs.readFile(summaryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const summary = validateQaEvidenceSummaryJson(JSON.parse(rawSummary));
  const entry =
    summary.entries.find((candidate) => candidate.test.id === params.scenario) ??
    summary.entries[0];
  const artifacts = entry?.execution?.artifacts ?? [];
  return {
    details: entry?.result.failure?.reason,
    screenshotPath: artifacts.find((artifact) => artifact.kind === "screenshot")?.path,
    status: entry?.result.status ?? "fail",
    summaryPath,
    videoPath: artifacts.find((artifact) => artifact.kind === "video")?.path,
  };
}

export async function readMantisLaneResult(params: {
  laneOutputDir: string;
  publishedLaneDir: string;
  scenario: string;
}): Promise<LaneResult> {
  const normalized = await readNormalizedLaneResult(params);
  if (normalized) {
    return {
      outputDir: params.publishedLaneDir,
      scenarioDetails: normalized.details,
      screenshotPath: normalized.screenshotPath,
      status: normalized.status,
      summaryPath: normalized.summaryPath,
      videoPath: normalized.videoPath,
    };
  }

  const summaryPath = path.join(params.publishedLaneDir, "discord-qa-summary.json");
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as DiscordQaSummary;
  const scenarioSummary =
    summary.scenarios?.find((entry) => entry.id === params.scenario) ?? summary.scenarios?.[0];
  return {
    outputDir: params.publishedLaneDir,
    scenarioDetails: scenarioSummary?.details,
    screenshotPath: scenarioSummary?.artifactPaths?.screenshot,
    status: scenarioSummary?.status ?? "fail",
    summaryPath,
    videoPath: scenarioSummary?.artifactPaths?.video,
  };
}

export async function copyMantisLaneArtifact(params: {
  kind: "screenshot" | "video";
  lane: "baseline" | "candidate";
  result: LaneResult;
}): Promise<string | undefined> {
  const artifactPath =
    params.kind === "screenshot" ? params.result.screenshotPath : params.result.videoPath;
  if (!artifactPath) {
    return undefined;
  }
  const source = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.join(params.result.outputDir, artifactPath);
  const target = path.join(
    params.result.outputDir,
    `${params.lane}.${params.kind === "screenshot" ? "png" : "mp4"}`,
  );
  await fs.copyFile(source, target);
  return target;
}
