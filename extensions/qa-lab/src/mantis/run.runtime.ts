// Qa Lab plugin module implements run behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import { trimToValue } from "../mantis-options.runtime.js";
import {
  copyMantisLaneArtifact,
  publishMantisRunOutput,
  readMantisLaneResult,
  type LaneResult,
} from "./run-artifacts.runtime.js";
import {
  createMantisWorktreeDirectory,
  removeMantisWorktree,
  type MantisWorktreeOwnership,
} from "./run-cleanup.runtime.js";
import {
  assertMantisCommandNotAborted,
  defaultMantisCommandRunner,
  resolveMantisCommandTimeouts,
  runMantisCommand,
  type MantisCommandExecution,
  type MantisCommandRunner,
  type MantisCommandTimeoutOverrides,
  type MantisCommandTimeouts,
} from "./run-command.runtime.js";

export type MantisBeforeAfterOptions = {
  allowFailures?: boolean;
  baseline?: string;
  candidate?: string;
  commandRunner?: MantisCommandRunner;
  commandTimeouts?: MantisCommandTimeoutOverrides;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  now?: () => Date;
  outputDir?: string;
  providerMode?: string;
  repoRoot?: string;
  scenario?: string;
  signal?: AbortSignal;
  skipBuild?: boolean;
  skipInstall?: boolean;
  transport?: string;
};

type MantisBeforeAfterResult = {
  comparisonPath: string;
  manifestPath: string;
  outputDir: string;
  reportPath: string;
  status: "pass" | "fail";
};

type MantisScenarioConfig = {
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

type Comparison = {
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

const DEFAULT_BASELINE_REF = "0bf06e953fdda290799fc9fb9244a8f67fdae593";
const DEFAULT_CANDIDATE_REF = "HEAD";
const DEFAULT_SCENARIO = "discord-status-reactions-tool-only";
const DISCORD_THREAD_FILEPATH_ATTACHMENT_SCENARIO = "discord-thread-reply-filepath-attachment";
const DEFAULT_TRANSPORT = "discord";
const DEFAULT_PROVIDER_MODE = "live-frontier";
const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_CREDENTIAL_SOURCE = "convex";
const DEFAULT_CREDENTIAL_ROLE = "ci";
const MANTIS_SCENARIO_CONFIGS: Record<string, MantisScenarioConfig> = {
  [DEFAULT_SCENARIO]: {
    baselineExpected: "queued-only",
    baselineLabel: "Baseline queued-only",
    baselineScreenshotAlt: "Baseline Discord status reaction timeline",
    candidateExpected: "queued -> thinking -> done",
    candidateLabel: "Candidate queued -> thinking -> done",
    candidateScreenshotAlt: "Candidate Discord status reaction timeline",
    defaultBaselineRef: DEFAULT_BASELINE_REF,
    id: DEFAULT_SCENARIO,
    title: "Mantis Discord Status Reactions QA",
  },
  [DISCORD_THREAD_FILEPATH_ATTACHMENT_SCENARIO]: {
    baselineExpected: "thread reply omits filePath attachment",
    baselineLabel: "Baseline missing filePath attachment",
    baselineScreenshotAlt: "Baseline Discord thread reply without filePath attachment",
    candidateExpected: "thread reply includes filePath attachment",
    candidateLabel: "Candidate includes filePath attachment",
    candidateScreenshotAlt: "Candidate Discord thread reply with filePath attachment",
    defaultBaselineRef: "81349cdc2a9d5143fd0991ed858b739e7d96e05c",
    id: DISCORD_THREAD_FILEPATH_ATTACHMENT_SCENARIO,
    title: "Mantis Discord Thread Attachment QA",
  },
};

function normalizeRequiredLiteral<T extends string>(
  value: string | undefined,
  defaultValue: T,
  allowed: readonly T[],
  label: string,
): T {
  const normalized = (trimToValue(value) ?? defaultValue) as T;
  if (!allowed.includes(normalized)) {
    throw new Error(`${label} must be ${allowed.map((entry) => `'${entry}'`).join(" or ")}.`);
  }
  return normalized;
}

function defaultOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `run-${stamp}`);
}

function renderReport(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: Comparison;
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

function remapStagedLaneResult(params: {
  publishedLaneDir: string;
  result: LaneResult;
  stagedLaneDir: string;
}): LaneResult {
  const remap = (artifactPath: string | undefined): string | undefined => {
    if (!artifactPath || !path.isAbsolute(artifactPath)) {
      return artifactPath;
    }
    const relativePath = path.relative(params.stagedLaneDir, artifactPath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return artifactPath;
    }
    return path.join(params.publishedLaneDir, relativePath);
  };
  return {
    ...params.result,
    outputDir: params.publishedLaneDir,
    screenshotPath: remap(params.result.screenshotPath),
    summaryPath: remap(params.result.summaryPath) ?? params.result.summaryPath,
    videoPath: remap(params.result.videoPath),
  };
}

function formatMantisFailure(error: unknown): string {
  const lines: string[] = [];
  const append = (entry: unknown, pathParts: number[]) => {
    const prefix = pathParts.length > 0 ? `${pathParts.join(".")}. ` : "";
    lines.push(`${prefix}${formatErrorMessage(entry)}`);
    if (entry instanceof AggregateError) {
      entry.errors.forEach((nestedError, index) => append(nestedError, [...pathParts, index + 1]));
    }
  };
  append(error, []);
  return lines.join("\n");
}

function attachMantisFailureArtifact(error: unknown, errorPath: string): Error {
  const artifactLine = `Mantis error details: ${errorPath}`;
  if (error instanceof Error) {
    error.message = `${error.message}\n${artifactLine}`;
    return error;
  }
  return new Error(`${formatErrorMessage(error)}\n${artifactLine}`, { cause: error });
}

async function throwMantisRunFailure(outputDir: string, error: unknown): Promise<never> {
  const errorPath = path.join(outputDir, "error.txt");
  await fs.writeFile(errorPath, `${formatMantisFailure(error)}\n`, "utf8");
  throw attachMantisFailureArtifact(error, errorPath);
}

function buildEvidenceManifest(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: Comparison;
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

async function runLane(params: {
  lane: "baseline" | "candidate";
  ref: string;
  repoRoot: string;
  runner: MantisCommandRunner;
  scenario: string;
  signal?: AbortSignal;
  stagedRunDir: string;
  commandTimeouts: MantisCommandTimeouts;
  worktreeRoot: string;
  opts: Required<
    Pick<
      MantisBeforeAfterOptions,
      | "credentialRole"
      | "credentialSource"
      | "fastMode"
      | "providerMode"
      | "skipBuild"
      | "skipInstall"
    >
  >;
}) {
  const worktreeDir = path.join(params.worktreeRoot, params.lane);
  const worktreeOutputDir = path.join(".artifacts", "qa-e2e", "mantis", "run", params.lane);
  const stagedLaneDir = path.join(params.stagedRunDir, params.lane);
  const worktreeAddArgs = ["worktree", "add", "--detach", "--", worktreeDir, params.ref];
  const worktreeAddExecution = {
    cwd: params.repoRoot,
    env: process.env,
    signal: params.signal,
    stage: "worktree-add",
    timeoutMs: params.commandTimeouts["worktree-add"],
  } satisfies MantisCommandExecution;
  let worktreeOwnership: MantisWorktreeOwnership | undefined;
  let workloadFailed = false;
  let workloadError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;

  assertMantisCommandNotAborted({
    command: "git",
    args: worktreeAddArgs,
    execution: worktreeAddExecution,
    lane: params.lane,
  });
  try {
    try {
      worktreeOwnership = await createMantisWorktreeDirectory({
        repoRoot: params.repoRoot,
        worktreeDir,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `${params.lane} worktree path already exists; refusing to reuse ${worktreeDir}`,
          { cause: error },
        );
      }
      throw error;
    }
    await runMantisCommand({
      command: "git",
      args: worktreeAddArgs,
      execution: worktreeAddExecution,
      lane: params.lane,
      runner: params.runner,
    });
    if (!params.opts.skipInstall) {
      await runMantisCommand({
        command: "pnpm",
        args: ["--dir", worktreeDir, "install", "--frozen-lockfile"],
        execution: {
          cwd: params.repoRoot,
          env: process.env,
          signal: params.signal,
          stage: "install",
          timeoutMs: params.commandTimeouts.install,
        },
        lane: params.lane,
        runner: params.runner,
      });
    }
    if (!params.opts.skipBuild) {
      await runMantisCommand({
        command: "pnpm",
        args: ["--dir", worktreeDir, "build"],
        execution: {
          cwd: params.repoRoot,
          env: process.env,
          signal: params.signal,
          stage: "build",
          timeoutMs: params.commandTimeouts.build,
        },
        lane: params.lane,
        runner: params.runner,
      });
    }
    await runMantisCommand({
      command: "pnpm",
      args: [
        "--dir",
        worktreeDir,
        "openclaw",
        "qa",
        "discord",
        "--repo-root",
        worktreeDir,
        "--output-dir",
        worktreeOutputDir,
        "--provider-mode",
        params.opts.providerMode,
        "--model",
        DEFAULT_MODEL,
        "--alt-model",
        DEFAULT_MODEL,
        ...(params.opts.fastMode ? ["--fast"] : []),
        "--credential-source",
        params.opts.credentialSource,
        "--credential-role",
        params.opts.credentialRole,
        "--scenario",
        params.scenario,
        "--allow-failures",
      ],
      execution: {
        cwd: params.repoRoot,
        env: process.env,
        signal: params.signal,
        stage: "qa",
        timeoutMs: params.commandTimeouts.qa,
      },
      lane: params.lane,
      runner: params.runner,
    });
    // Move completed output outside the worktree before cleanup, while leaving
    // the last published evidence untouched until the replacement is ready.
    await fs.rename(path.join(worktreeDir, worktreeOutputDir), stagedLaneDir);
  } catch (error) {
    workloadFailed = true;
    workloadError = error;
  } finally {
    if (worktreeOwnership) {
      try {
        await removeMantisWorktree({
          commandTimeouts: params.commandTimeouts,
          lane: params.lane,
          repoRoot: params.repoRoot,
          runner: params.runner,
          worktreeDir,
          ownership: worktreeOwnership,
        });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
  }

  if (workloadFailed && cleanupFailed) {
    throw new AggregateError(
      [workloadError, cleanupError],
      "Mantis lane failed and worktree cleanup failed",
      { cause: workloadError },
    );
  }
  if (workloadFailed) {
    throw workloadError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (params.signal?.aborted) {
    throw new Error(`${params.lane} artifact processing aborted`, {
      cause: params.signal.reason,
    });
  }
  const result = await readMantisLaneResult({
    laneOutputDir: path.join(worktreeDir, worktreeOutputDir),
    publishedLaneDir: stagedLaneDir,
    scenario: params.scenario,
  });
  const copiedScreenshot = await copyMantisLaneArtifact({
    kind: "screenshot",
    lane: params.lane,
    result,
  });
  const copiedVideo = await copyMantisLaneArtifact({
    kind: "video",
    lane: params.lane,
    result,
  });
  return {
    ...result,
    screenshotPath: copiedScreenshot ?? result.screenshotPath,
    videoPath: copiedVideo ?? result.videoPath,
  } satisfies LaneResult;
}

export async function runMantisBeforeAfter(
  opts: MantisBeforeAfterOptions = {},
): Promise<MantisBeforeAfterResult> {
  const startedAt = (opts.now ?? (() => new Date()))();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ?? defaultOutputDir(repoRoot, startedAt),
    "Mantis before/after output directory",
    { mode: 0o755 },
  );
  const transport = normalizeRequiredLiteral(
    opts.transport,
    DEFAULT_TRANSPORT,
    ["discord"],
    "--transport",
  );
  const scenario = normalizeRequiredLiteral(
    opts.scenario,
    DEFAULT_SCENARIO,
    Object.keys(MANTIS_SCENARIO_CONFIGS),
    "--scenario",
  );
  const scenarioConfig = MANTIS_SCENARIO_CONFIGS[scenario];
  if (!scenarioConfig) {
    throw new Error(`Unsupported Mantis scenario: ${scenario}`);
  }
  const baseline = trimToValue(opts.baseline) ?? scenarioConfig.defaultBaselineRef;
  const candidate = trimToValue(opts.candidate) ?? DEFAULT_CANDIDATE_REF;
  const commandTimeouts = resolveMantisCommandTimeouts(scenario, opts.commandTimeouts);
  const runner = opts.commandRunner ?? defaultMantisCommandRunner;
  const worktreeRoot = path.join(outputDir, "worktrees");
  const comparisonPath = path.join(outputDir, "comparison.json");
  const manifestPath = path.join(outputDir, "mantis-evidence.json");
  const reportPath = path.join(outputDir, "mantis-report.md");
  const stagedRunDir = path.join(outputDir, `.mantis-staged-run-${process.pid}-${randomUUID()}`);
  await fs.mkdir(worktreeRoot, { recursive: true });

  let outcome: { error: unknown; ok: false } | { ok: true; value: MantisBeforeAfterResult };
  try {
    await fs.mkdir(stagedRunDir);
    const commonOpts = {
      credentialRole: trimToValue(opts.credentialRole) ?? DEFAULT_CREDENTIAL_ROLE,
      credentialSource: trimToValue(opts.credentialSource) ?? DEFAULT_CREDENTIAL_SOURCE,
      fastMode: opts.fastMode ?? true,
      providerMode: trimToValue(opts.providerMode) ?? DEFAULT_PROVIDER_MODE,
      skipBuild: opts.skipBuild ?? false,
      skipInstall: opts.skipInstall ?? false,
    };
    const stagedBaselineResult = await runLane({
      lane: "baseline",
      ref: baseline,
      repoRoot,
      runner,
      scenario,
      signal: opts.signal,
      stagedRunDir,
      commandTimeouts,
      worktreeRoot,
      opts: commonOpts,
    });
    const stagedCandidateResult = await runLane({
      lane: "candidate",
      ref: candidate,
      repoRoot,
      runner,
      scenario,
      signal: opts.signal,
      stagedRunDir,
      commandTimeouts,
      worktreeRoot,
      opts: commonOpts,
    });
    const baselineResult = remapStagedLaneResult({
      publishedLaneDir: path.join(outputDir, "baseline"),
      result: stagedBaselineResult,
      stagedLaneDir: path.join(stagedRunDir, "baseline"),
    });
    const candidateResult = remapStagedLaneResult({
      publishedLaneDir: path.join(outputDir, "candidate"),
      result: stagedCandidateResult,
      stagedLaneDir: path.join(stagedRunDir, "candidate"),
    });
    const comparison = {
      baseline: {
        expected: scenarioConfig.baselineExpected,
        ref: baseline,
        reproduced: baselineResult.status === "fail",
        screenshotPath: baselineResult.screenshotPath,
        status: baselineResult.status,
        videoPath: baselineResult.videoPath,
      },
      candidate: {
        expected: scenarioConfig.candidateExpected,
        fixed: candidateResult.status === "pass",
        ref: candidate,
        screenshotPath: candidateResult.screenshotPath,
        status: candidateResult.status,
        videoPath: candidateResult.videoPath,
      },
      pass: baselineResult.status === "fail" && candidateResult.status === "pass",
      scenario,
      transport,
    } satisfies Comparison;
    await fs.writeFile(
      path.join(stagedRunDir, "comparison.json"),
      `${JSON.stringify(comparison, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(stagedRunDir, "mantis-report.md"),
      renderReport({
        baseline: baselineResult,
        candidate: candidateResult,
        comparison,
        outputDir,
        scenarioConfig,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stagedRunDir, "mantis-evidence.json"),
      `${JSON.stringify(
        buildEvidenceManifest({
          baseline: baselineResult,
          candidate: candidateResult,
          comparison,
          outputDir,
          scenarioConfig,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    if (opts.signal?.aborted) {
      throw new Error("Mantis artifact publication aborted", { cause: opts.signal.reason });
    }
    await publishMantisRunOutput({ outputDir, stagedRunDir });
    outcome = {
      ok: true,
      value: {
        comparisonPath,
        manifestPath,
        outputDir,
        reportPath,
        status: comparison.pass ? "pass" : "fail",
      },
    };
  } catch (error) {
    outcome = { error, ok: false };
  }

  // The run-level owner removes every uncommitted screenshot/video together;
  // otherwise cleanup failure or a late interrupt leaks hidden evidence.
  const cleanupOutcome = await fs.rm(stagedRunDir, { force: true, recursive: true }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  if (!cleanupOutcome.ok) {
    const cleanupFailure = new Error(`Mantis could not remove staged evidence ${stagedRunDir}`, {
      cause: cleanupOutcome.error,
    });
    if (!outcome.ok) {
      await throwMantisRunFailure(
        outputDir,
        new AggregateError(
          [outcome.error, cleanupFailure],
          `Mantis run failed and staged evidence cleanup failed: ${stagedRunDir}`,
          { cause: outcome.error },
        ),
      );
    }
    await throwMantisRunFailure(outputDir, cleanupFailure);
  }
  if (!outcome.ok) {
    await throwMantisRunFailure(outputDir, outcome.error);
  }
  return outcome.value;
}
