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

const MANTIS_RUN_OUTPUT_COMPONENTS = [
  "baseline",
  "candidate",
  "comparison.json",
  "mantis-report.md",
  "mantis-evidence.json",
] as const;

function createMantisPublishRollbackError(params: {
  previousRunDir: string;
  publishError: unknown;
  rollbackErrors: unknown[];
}): AggregateError {
  return new AggregateError(
    [params.publishError, ...params.rollbackErrors],
    `Mantis could not publish the staged comparison or completely restore ${params.previousRunDir}`,
    { cause: params.publishError },
  );
}

function createMantisPublishRollbackCleanupError(params: {
  cleanupError: unknown;
  previousRunDir: string;
  publishError: unknown;
}): AggregateError {
  const cleanupFailure = new Error(
    `Mantis restored the previous comparison but could not remove ${params.previousRunDir}`,
    { cause: params.cleanupError },
  );
  return new AggregateError(
    [params.publishError, cleanupFailure],
    "Mantis comparison publication failed and rollback cleanup was incomplete",
    { cause: params.publishError },
  );
}

export async function publishMantisRunOutput(params: {
  outputDir: string;
  stagedRunDir: string;
}): Promise<void> {
  // One before/after run owns every stable component. Retain the complete old
  // generation until every staged component is promoted, then roll all of it
  // back if any rename fails so readers never observe a mixed final state.
  const previousRunDir = path.join(
    params.outputDir,
    `.mantis-previous-run-${process.pid}-${randomUUID()}`,
  );
  const backedUpComponents: (typeof MANTIS_RUN_OUTPUT_COMPONENTS)[number][] = [];
  const promotedComponents: (typeof MANTIS_RUN_OUTPUT_COMPONENTS)[number][] = [];
  await fs.mkdir(previousRunDir);

  try {
    for (const component of MANTIS_RUN_OUTPUT_COMPONENTS) {
      try {
        await fs.rename(
          path.join(params.outputDir, component),
          path.join(previousRunDir, component),
        );
        backedUpComponents.push(component);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }

    for (const component of MANTIS_RUN_OUTPUT_COMPONENTS) {
      await fs.rename(
        path.join(params.stagedRunDir, component),
        path.join(params.outputDir, component),
      );
      promotedComponents.push(component);
    }
  } catch (publishError) {
    const rollbackErrors: unknown[] = [];
    for (const component of promotedComponents.toReversed()) {
      try {
        await fs.rename(
          path.join(params.outputDir, component),
          path.join(params.stagedRunDir, component),
        );
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const component of backedUpComponents.toReversed()) {
      try {
        await fs.rename(
          path.join(previousRunDir, component),
          path.join(params.outputDir, component),
        );
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw createMantisPublishRollbackError({
        previousRunDir,
        publishError,
        rollbackErrors,
      });
    }
    const cleanupOutcome = await fs.rm(previousRunDir, { force: true, recursive: true }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    if (!cleanupOutcome.ok) {
      throw createMantisPublishRollbackCleanupError({
        cleanupError: cleanupOutcome.error,
        previousRunDir,
        publishError,
      });
    }
    throw publishError;
  }

  try {
    await fs.rm(previousRunDir, { force: true, recursive: true });
  } catch (error) {
    throw new Error(`Mantis published new evidence but could not remove ${previousRunDir}`, {
      cause: error,
    });
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
