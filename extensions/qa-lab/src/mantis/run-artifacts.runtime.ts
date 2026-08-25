// Qa Lab plugin module implements Mantis evidence artifact handling.
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
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

export type MantisRunStaging = {
  dir: string;
  relative: string;
};

const MANTIS_STABLE_ENTRIES = [
  { kind: "directory", path: "baseline" },
  { kind: "directory", path: "candidate" },
  { kind: "file", path: "comparison.json" },
  { kind: "file", path: "mantis-report.md" },
  { kind: "file", path: "mantis-evidence.json" },
] as const;

type MantisOutputRoot = Pick<
  Awaited<ReturnType<typeof root>>,
  "exists" | "list" | "mkdir" | "move" | "remove" | "stat"
>;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNotFoundFsSafeError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "not-found"
  );
}

async function removeMantisOutputTree(
  outputRoot: MantisOutputRoot,
  relativePath: string,
): Promise<void> {
  let entry: Awaited<ReturnType<MantisOutputRoot["stat"]>>;
  try {
    entry = await outputRoot.stat(relativePath);
  } catch (error) {
    if (isNotFoundFsSafeError(error)) {
      return;
    }
    throw error;
  }
  if (entry.isDirectory && !entry.isSymbolicLink) {
    for (const child of await outputRoot.list(relativePath)) {
      await removeMantisOutputTree(outputRoot, path.posix.join(relativePath, child));
    }
  }
  await outputRoot.remove(relativePath);
}

export async function createMantisRunStaging(params: {
  outputDir: string;
  outputRoot: MantisOutputRoot;
  runId: string;
}): Promise<MantisRunStaging> {
  const relative = `.mantis-staged-${params.runId}`;
  await params.outputRoot.mkdir(relative);
  return { dir: path.join(params.outputDir, relative), relative };
}

export async function removeMantisRunStaging(params: {
  outputRoot: MantisOutputRoot;
  staging: MantisRunStaging;
}): Promise<void> {
  await removeMantisOutputTree(params.outputRoot, params.staging.relative);
}

async function validateMantisStagedOutput(params: {
  outputRoot: MantisOutputRoot;
  staging: MantisRunStaging;
}): Promise<void> {
  for (const entry of MANTIS_STABLE_ENTRIES) {
    const source = await params.outputRoot.stat(
      path.posix.join(params.staging.relative, entry.path),
    );
    if (
      source.isSymbolicLink ||
      (entry.kind === "directory" ? !source.isDirectory : !source.isFile)
    ) {
      throw new Error(`Mantis staged artifact has the wrong type: ${entry.path}`);
    }
  }
}

async function rollbackMantisStableOutput(params: {
  backedUp: readonly string[];
  backupRelative: string;
  installed: readonly string[];
  outputRoot: MantisOutputRoot;
  staging: MantisRunStaging;
}): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  for (const entry of params.installed.toReversed()) {
    try {
      await removeMantisOutputTree(params.outputRoot, entry);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const entry of params.backedUp.toReversed()) {
    try {
      await params.outputRoot.move(path.posix.join(params.backupRelative, entry), entry, {
        overwrite: true,
      });
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  for (const transient of [params.staging.relative, params.backupRelative]) {
    try {
      await removeMantisOutputTree(params.outputRoot, transient);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

function createMantisStableRollbackError(
  publicationError: unknown,
  rollbackErrors: readonly unknown[],
): AggregateError {
  return new AggregateError(
    [publicationError, ...rollbackErrors],
    "Mantis stable artifact publication failed and rollback failed",
    { cause: publicationError },
  );
}

export async function publishMantisRunOutput(params: {
  outputRoot: MantisOutputRoot;
  runId: string;
  staging: MantisRunStaging;
}): Promise<void> {
  // Concurrent writers to one output directory are intentionally unsupported.
  // The run id isolates rollback state; callers use distinct output directories.
  const backupRelative = `.mantis-previous-${params.runId}`;
  const backedUp: string[] = [];
  const installed: string[] = [];
  try {
    // Validate the complete evidence set before moving any stable path. A failed
    // lane or renderer must leave the preceding run internally consistent.
    await validateMantisStagedOutput(params);
    await params.outputRoot.mkdir(backupRelative);
    for (const entry of MANTIS_STABLE_ENTRIES) {
      if (await params.outputRoot.exists(entry.path)) {
        await params.outputRoot.move(entry.path, path.posix.join(backupRelative, entry.path), {
          overwrite: true,
        });
        backedUp.push(entry.path);
      }
      await params.outputRoot.move(
        path.posix.join(params.staging.relative, entry.path),
        entry.path,
        {
          overwrite: true,
        },
      );
      installed.push(entry.path);
    }
    if (await params.outputRoot.exists("error.txt")) {
      await params.outputRoot.remove("error.txt");
    }
  } catch (error) {
    const rollbackErrors = await rollbackMantisStableOutput({
      backedUp,
      backupRelative,
      installed,
      outputRoot: params.outputRoot,
      staging: params.staging,
    });
    if (rollbackErrors.length > 0) {
      throw createMantisStableRollbackError(error, rollbackErrors);
    }
    throw error;
  }

  // The stable set is committed. Hidden cleanup failures retain only redundant
  // old/staging data and must not misreport the coherent new run as failed.
  for (const transient of [params.staging.relative, backupRelative]) {
    try {
      await removeMantisOutputTree(params.outputRoot, transient);
    } catch (error) {
      console.warn(`Mantis published but could not remove ${transient}: ${String(error)}`);
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

export function remapMantisLaneResult(params: {
  publishedLaneDir: string;
  result: LaneResult;
  stagedLaneDir: string;
}): LaneResult {
  const remap = (artifactPath: string | undefined) =>
    remapPublishedArtifactPath({
      artifactPath,
      laneOutputDir: params.stagedLaneDir,
      publishedLaneDir: params.publishedLaneDir,
    });
  return {
    ...params.result,
    outputDir: params.publishedLaneDir,
    screenshotPath: remap(params.result.screenshotPath),
    summaryPath: remap(params.result.summaryPath) ?? params.result.summaryPath,
    videoPath: remap(params.result.videoPath),
  };
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

export async function stageMantisLaneOutput(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir);
  await fs.cp(sourceDir, targetDir, { recursive: true });
}
