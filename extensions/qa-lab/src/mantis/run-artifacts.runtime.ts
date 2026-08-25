// Qa Lab plugin module implements Mantis evidence artifact handling.
import fs from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function throwIfMantisPublicationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Mantis artifact publication aborted", { cause: signal.reason });
  }
}

export type MantisRunPublication = {
  currentPath: string;
  generationDir: string;
};

const MANTIS_COMPATIBILITY_ENTRIES = [
  { kind: "directory", path: "baseline" },
  { kind: "directory", path: "candidate" },
  { kind: "file", path: "comparison.json" },
  { kind: "file", path: "mantis-report.md" },
  { kind: "file", path: "mantis-evidence.json" },
] as const;

const MANTIS_PUBLICATION_LOCK_OPTIONS = {
  retries: {
    factor: 1.2,
    maxTimeout: 1_000,
    minTimeout: 50,
    randomize: true,
    retries: 300,
  },
  stale: 30 * 60_000,
} as const;

type MantisOutputRoot = Pick<
  Awaited<ReturnType<typeof root>>,
  "copyIn" | "exists" | "list" | "mkdir" | "move" | "remove" | "stat" | "writeJson"
>;

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

async function stageMantisCompatibilityView(params: {
  generationDir: string;
  generationRelative: string;
  outputDir: string;
  outputRoot: MantisOutputRoot;
  signal?: AbortSignal;
  stageRelative: string;
}): Promise<void> {
  await params.outputRoot.mkdir(params.stageRelative);
  for (const entry of MANTIS_COMPATIBILITY_ENTRIES) {
    throwIfMantisPublicationAborted(params.signal);
    const sourceRelative = path.posix.join(params.generationRelative, entry.path);
    const sourceStat = await params.outputRoot.stat(sourceRelative);
    if (
      sourceStat.isSymbolicLink ||
      (entry.kind === "directory" ? !sourceStat.isDirectory : !sourceStat.isFile)
    ) {
      throw new Error(`Mantis compatibility source has the wrong type: ${entry.path}`);
    }
    const targetRelative = path.posix.join(params.stageRelative, entry.path);
    if (entry.kind === "file") {
      await params.outputRoot.copyIn(targetRelative, path.join(params.generationDir, entry.path));
      continue;
    }
    await fs.cp(
      path.join(params.generationDir, entry.path),
      path.join(params.outputDir, ...targetRelative.split(path.posix.sep)),
      { errorOnExist: true, force: false, recursive: true },
    );
  }
}

async function rollbackMantisCompatibilityView(params: {
  backedUp: readonly string[];
  backupRelative: string;
  installed: readonly string[];
  outputRoot: MantisOutputRoot;
  stageRelative: string;
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
  for (const transient of [params.stageRelative, params.backupRelative]) {
    try {
      await removeMantisOutputTree(params.outputRoot, transient);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

function createMantisCompatibilityRollbackError(
  publicationError: unknown,
  rollbackErrors: readonly unknown[],
): AggregateError {
  return new AggregateError(
    [publicationError, ...rollbackErrors],
    "Mantis compatibility publication failed and rollback failed",
    { cause: publicationError },
  );
}

function createMantisPublicationLockReleaseError(
  publicationError: unknown,
  releaseError: unknown,
): AggregateError {
  return new AggregateError(
    [publicationError, releaseError],
    "Mantis publication failed and its publication lock could not be released",
    { cause: publicationError },
  );
}

async function publishMantisCompatibilityView(params: {
  generationDir: string;
  generationRelative: string;
  outputDir: string;
  outputRoot: MantisOutputRoot;
  runId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const stageRelative = `.mantis-compat-staged-${params.runId}`;
  const backupRelative = `.mantis-compat-previous-${params.runId}`;
  const backedUp: string[] = [];
  const installed: string[] = [];
  try {
    await stageMantisCompatibilityView({ ...params, stageRelative });
    throwIfMantisPublicationAborted(params.signal);
    await params.outputRoot.mkdir(backupRelative);
    for (const entry of MANTIS_COMPATIBILITY_ENTRIES) {
      if (await params.outputRoot.exists(entry.path)) {
        await params.outputRoot.move(entry.path, path.posix.join(backupRelative, entry.path), {
          overwrite: true,
        });
        backedUp.push(entry.path);
      }
      await params.outputRoot.move(path.posix.join(stageRelative, entry.path), entry.path, {
        overwrite: true,
      });
      installed.push(entry.path);
    }
    throwIfMantisPublicationAborted(params.signal);
    // The pointer stays last so a reported failure can restore the documented
    // direct paths while readers of mantis-current.json retain the last generation.
    await params.outputRoot.writeJson(
      "mantis-current.json",
      { generation: params.generationRelative, schemaVersion: 1 },
      { space: 2 },
    );
  } catch (error) {
    const rollbackErrors = await rollbackMantisCompatibilityView({
      backedUp,
      backupRelative,
      installed,
      outputRoot: params.outputRoot,
      stageRelative,
    });
    if (rollbackErrors.length > 0) {
      throw createMantisCompatibilityRollbackError(error, rollbackErrors);
    }
    throw error;
  }

  // Publication is committed once the pointer changes. Cleanup cannot turn that
  // successful generation into a reported failure, so retain diagnostics as a warning.
  for (const transient of [stageRelative, backupRelative]) {
    try {
      await removeMantisOutputTree(params.outputRoot, transient);
    } catch (error) {
      console.warn(`Mantis published but could not remove ${transient}: ${String(error)}`);
    }
  }
}

export async function publishMantisRunOutput(params: {
  generationDir: string;
  outputDir: string;
  outputRoot: MantisOutputRoot;
  signal?: AbortSignal;
}): Promise<MantisRunPublication> {
  const generationRelative = path
    .relative(params.outputDir, params.generationDir)
    .split(path.sep)
    .join(path.posix.sep);
  if (
    generationRelative === "" ||
    generationRelative === ".." ||
    generationRelative.startsWith("../") ||
    path.posix.isAbsolute(generationRelative)
  ) {
    throw new Error(`Mantis generation escaped the output directory: ${params.generationDir}`);
  }
  const generationStat = await params.outputRoot.stat(generationRelative);
  if (generationStat.isSymbolicLink || !generationStat.isDirectory) {
    throw new Error(`Mantis generation is not a real directory: ${params.generationDir}`);
  }

  throwIfMantisPublicationAborted(params.signal);
  const currentPath = path.join(params.outputDir, "mantis-current.json");
  const publicationLock = await acquireFileLock(currentPath, {
    ...MANTIS_PUBLICATION_LOCK_OPTIONS,
    signal: params.signal,
  });
  let publicationFailed = false;
  let publicationError: unknown;
  try {
    await publishMantisCompatibilityView({
      generationDir: params.generationDir,
      generationRelative,
      outputDir: params.outputDir,
      outputRoot: params.outputRoot,
      runId: path.basename(params.generationDir).slice("generation-".length),
      signal: params.signal,
    });
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
  }
  let releaseError: unknown;
  try {
    await publicationLock.release();
  } catch (error) {
    releaseError = error;
  }
  if (publicationFailed) {
    if (releaseError !== undefined) {
      throw createMantisPublicationLockReleaseError(publicationError, releaseError);
    }
    throw publicationError;
  }
  // A release failure happens after both views committed. Report it without
  // misclassifying the new complete generation as a failed publication.
  if (releaseError !== undefined) {
    console.warn(
      `Mantis published but could not release ${publicationLock.lockPath}: ${String(releaseError)}`,
    );
  }
  return { currentPath, generationDir: params.generationDir };
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
