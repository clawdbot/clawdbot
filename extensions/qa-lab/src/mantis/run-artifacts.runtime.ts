// Qa Lab plugin module implements Mantis evidence artifact handling.
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_EVIDENCE_FILENAME, validateQaEvidenceSummaryJson } from "../evidence-summary.js";
import {
  assertMantisDirectoryOwnership,
  type MantisDirectoryOwnership,
} from "./run-directory.runtime.js";

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
  publishError: unknown;
  rollbackErrors: unknown[];
}): AggregateError {
  return new AggregateError(
    [params.publishError, ...params.rollbackErrors],
    "Mantis could not publish the staged comparison or completely restore the previous generation",
    { cause: params.publishError },
  );
}

function toRootRelative(repoRoot: string, targetPath: string): string {
  return path.relative(repoRoot, targetPath).split(path.sep).join(path.posix.sep);
}

function ownershipAtParent(
  parent: MantisDirectoryOwnership,
  target: MantisDirectoryOwnership,
): MantisDirectoryOwnership {
  return {
    parentDevice: parent.targetDevice,
    parentInode: parent.targetInode,
    targetDevice: target.targetDevice,
    targetInode: target.targetInode,
  };
}

function throwIfMantisPublicationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Mantis artifact publication aborted", { cause: signal.reason });
  }
}

export type MantisRunPublication = {
  outputOwnership: MantisDirectoryOwnership;
  previousRunDir: string;
  previousRunOwnership: MantisDirectoryOwnership;
};

export async function publishMantisRunOutput(params: {
  outputDir: string;
  outputOwnership: MantisDirectoryOwnership;
  repoRoot: string;
  runWorkspaceDir: string;
  runWorkspaceOwnership: MantisDirectoryOwnership;
  signal?: AbortSignal;
  stagedRunDir: string;
  stagedRunOwnership: MantisDirectoryOwnership;
}): Promise<MantisRunPublication> {
  // Publish the entire evidence tree as one generation. The two directory
  // renames can expose a brief absent target, but never a component-mixed run.
  const previousRunDir = path.join(params.runWorkspaceDir, "previous");
  const previousRunOwnership = ownershipAtParent(
    params.runWorkspaceOwnership,
    params.outputOwnership,
  );
  const publishedOwnership = {
    parentDevice: params.outputOwnership.parentDevice,
    parentInode: params.outputOwnership.parentInode,
    targetDevice: params.stagedRunOwnership.targetDevice,
    targetInode: params.stagedRunOwnership.targetInode,
  } satisfies MantisDirectoryOwnership;
  const repoRootHandle = await root(params.repoRoot);
  const outputRelative = toRootRelative(params.repoRoot, params.outputDir);
  const previousRelative = toRootRelative(params.repoRoot, previousRunDir);
  const stagedRelative = toRootRelative(params.repoRoot, params.stagedRunDir);
  let previousMoved = false;
  let stagedMoved = false;

  try {
    await assertMantisDirectoryOwnership({
      directoryPath: params.outputDir,
      ownership: params.outputOwnership,
      repoRoot: params.repoRoot,
    });
    await assertMantisDirectoryOwnership({
      directoryPath: params.stagedRunDir,
      ownership: params.stagedRunOwnership,
      repoRoot: params.repoRoot,
    });
    throwIfMantisPublicationAborted(params.signal);

    await repoRootHandle.move(outputRelative, previousRelative, { overwrite: true });
    previousMoved = true;
    await assertMantisDirectoryOwnership({
      directoryPath: previousRunDir,
      ownership: previousRunOwnership,
      repoRoot: params.repoRoot,
    });
    throwIfMantisPublicationAborted(params.signal);

    await repoRootHandle.move(stagedRelative, outputRelative, { overwrite: true });
    stagedMoved = true;
    await assertMantisDirectoryOwnership({
      directoryPath: params.outputDir,
      ownership: publishedOwnership,
      repoRoot: params.repoRoot,
    });
    throwIfMantisPublicationAborted(params.signal);

    return {
      outputOwnership: publishedOwnership,
      previousRunDir,
      previousRunOwnership,
    };
  } catch (publishError) {
    const rollbackErrors: unknown[] = [];
    if (stagedMoved) {
      try {
        await assertMantisDirectoryOwnership({
          directoryPath: params.outputDir,
          ownership: publishedOwnership,
          repoRoot: params.repoRoot,
        });
        await repoRootHandle.move(outputRelative, stagedRelative, { overwrite: true });
        await assertMantisDirectoryOwnership({
          directoryPath: params.stagedRunDir,
          ownership: params.stagedRunOwnership,
          repoRoot: params.repoRoot,
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (previousMoved) {
      try {
        await assertMantisDirectoryOwnership({
          directoryPath: previousRunDir,
          ownership: previousRunOwnership,
          repoRoot: params.repoRoot,
        });
        await repoRootHandle.move(previousRelative, outputRelative, { overwrite: true });
        await assertMantisDirectoryOwnership({
          directoryPath: params.outputDir,
          ownership: params.outputOwnership,
          repoRoot: params.repoRoot,
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw createMantisPublishRollbackError({
        publishError,
        rollbackErrors,
      });
    }
    throw publishError;
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
