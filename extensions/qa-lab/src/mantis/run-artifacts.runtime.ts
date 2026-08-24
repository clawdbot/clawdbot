// Qa Lab plugin module implements Mantis evidence artifact handling.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_EVIDENCE_FILENAME, validateQaEvidenceSummaryJson } from "../evidence-summary.js";

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

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function createMantisPublishRollbackError(params: {
  previousLaneDir: string;
  publishError: unknown;
  rollbackError: unknown;
}): AggregateError {
  return new AggregateError(
    [params.publishError, params.rollbackError],
    `Mantis could not publish staged lane output or restore ${params.previousLaneDir}`,
    { cause: params.publishError },
  );
}

export async function publishMantisLaneOutput(params: {
  publishedLaneDir: string;
  stagedLaneDir: string;
}): Promise<void> {
  // Keep the old evidence recoverable until the staged directory becomes the
  // stable lane path. A failed replacement rolls the previous directory back.
  const previousLaneDir = path.join(
    path.dirname(params.publishedLaneDir),
    `.mantis-previous-${path.basename(params.publishedLaneDir)}-${process.pid}-${randomUUID()}`,
  );
  let hasPreviousLane = false;
  try {
    await fs.rename(params.publishedLaneDir, previousLaneDir);
    hasPreviousLane = true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  try {
    await fs.rename(params.stagedLaneDir, params.publishedLaneDir);
  } catch (publishError) {
    if (!hasPreviousLane) {
      throw publishError;
    }
    try {
      await fs.rename(previousLaneDir, params.publishedLaneDir);
    } catch (rollbackError) {
      throw createMantisPublishRollbackError({
        previousLaneDir,
        publishError,
        rollbackError,
      });
    }
    throw publishError;
  }

  if (hasPreviousLane) {
    try {
      await fs.rm(previousLaneDir, { force: true, recursive: true });
    } catch (error) {
      throw new Error(`Mantis published new evidence but could not remove ${previousLaneDir}`, {
        cause: error,
      });
    }
  }
}

function remapPublishedArtifactPath(params: {
  artifactPath: string | undefined;
  laneOutputDir: string;
  publishedLaneDir: string;
}): string | undefined {
  if (!params.artifactPath || !path.isAbsolute(params.artifactPath)) {
    return params.artifactPath;
  }
  const relativePath = path.relative(params.laneOutputDir, params.artifactPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return params.artifactPath;
  }
  return path.join(params.publishedLaneDir, relativePath);
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
    if (isNotFoundError(error)) {
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
      screenshotPath: remapPublishedArtifactPath({
        artifactPath: normalized.screenshotPath,
        laneOutputDir: params.laneOutputDir,
        publishedLaneDir: params.publishedLaneDir,
      }),
      status: normalized.status,
      summaryPath: normalized.summaryPath,
      videoPath: remapPublishedArtifactPath({
        artifactPath: normalized.videoPath,
        laneOutputDir: params.laneOutputDir,
        publishedLaneDir: params.publishedLaneDir,
      }),
    };
  }

  const summaryPath = path.join(params.publishedLaneDir, "discord-qa-summary.json");
  const parsed: unknown = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const scenarios =
    isPlainObject(parsed) && Array.isArray(parsed.scenarios)
      ? parsed.scenarios.filter(isPlainObject)
      : [];
  const scenarioSummary = scenarios.find((entry) => entry.id === params.scenario) ?? scenarios[0];
  const artifactPaths = isPlainObject(scenarioSummary?.artifactPaths)
    ? scenarioSummary.artifactPaths
    : undefined;
  return {
    outputDir: params.publishedLaneDir,
    scenarioDetails:
      typeof scenarioSummary?.details === "string" ? scenarioSummary.details : undefined,
    screenshotPath: remapPublishedArtifactPath({
      artifactPath:
        typeof artifactPaths?.screenshot === "string" ? artifactPaths.screenshot : undefined,
      laneOutputDir: params.laneOutputDir,
      publishedLaneDir: params.publishedLaneDir,
    }),
    status: typeof scenarioSummary?.status === "string" ? scenarioSummary.status : "fail",
    summaryPath,
    videoPath: remapPublishedArtifactPath({
      artifactPath: typeof artifactPaths?.video === "string" ? artifactPaths.video : undefined,
      laneOutputDir: params.laneOutputDir,
      publishedLaneDir: params.publishedLaneDir,
    }),
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
