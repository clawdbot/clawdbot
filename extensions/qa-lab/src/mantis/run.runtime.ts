// Qa Lab plugin module implements run behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import { trimToValue } from "../mantis-options.runtime.js";
import {
  copyMantisLaneArtifact,
  publishMantisRunOutput,
  readMantisLaneResult,
  type LaneResult,
} from "./run-artifacts.runtime.js";
import { removeLegacyMantisWorktrees, removeMantisWorktree } from "./run-cleanup.runtime.js";
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
import {
  captureMantisDirectoryOwnership,
  type MantisDirectoryOwnership,
} from "./run-directory.runtime.js";
import {
  buildEvidenceManifest,
  renderReport,
  type MantisComparison,
  type MantisScenarioConfig,
} from "./run-evidence.runtime.js";

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

function createMantisFailureArtifactWriteError(params: {
  artifactError: unknown;
  error: unknown;
  errorPath: string;
}): AggregateError {
  return new AggregateError(
    [params.error, params.artifactError],
    `Mantis run failed and could not safely write ${params.errorPath}: ${formatErrorMessage(params.error)}`,
    { cause: params.artifactError },
  );
}

async function throwMantisRunFailure(params: {
  error: unknown;
  outputDir: string;
  outputRoot: Pick<Awaited<ReturnType<typeof root>>, "write">;
}): Promise<never> {
  const errorPath = path.join(params.outputDir, "error.txt");
  try {
    await params.outputRoot.write("error.txt", `${formatMantisFailure(params.error)}\n`);
  } catch (artifactError) {
    throw createMantisFailureArtifactWriteError({
      artifactError,
      error: params.error,
      errorPath,
    });
  }
  throw attachMantisFailureArtifact(params.error, errorPath);
}

async function runLane(params: {
  generationDir: string;
  lane: "baseline" | "candidate";
  ref: string;
  repoRoot: string;
  runId: string;
  runner: MantisCommandRunner;
  scenario: string;
  signal?: AbortSignal;
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
  const worktreeDir = path.join(params.worktreeRoot, `${params.lane}-${params.runId}`);
  const worktreeOutputDir = path.join(".artifacts", "qa-e2e", "mantis", "run", params.lane);
  const generationLaneDir = path.join(params.generationDir, params.lane);
  const worktreeAddArgs = ["worktree", "add", "--detach", "--", worktreeDir, params.ref];
  const worktreeAddExecution = {
    cwd: params.repoRoot,
    env: process.env,
    signal: params.signal,
    stage: "worktree-add",
    timeoutMs: params.commandTimeouts["worktree-add"],
  } satisfies MantisCommandExecution;
  let worktreeOwnership: MantisDirectoryOwnership | undefined;
  let worktreePrepared = false;
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
    await fs.mkdir(worktreeDir, { mode: 0o700 });
    worktreeOwnership = await captureMantisDirectoryOwnership({
      directoryPath: worktreeDir,
      repoRoot: params.repoRoot,
    });
    worktreePrepared = true;
    assertMantisCommandNotAborted({
      command: "git",
      args: worktreeAddArgs,
      execution: worktreeAddExecution,
      lane: params.lane,
    });
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
    // Copy into the fresh immutable generation before Git removes its worktree.
    // A raced source can fail or copy inconsistently, but is never relocated or deleted here.
    await fs.cp(path.join(worktreeDir, worktreeOutputDir), generationLaneDir, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  } catch (error) {
    workloadFailed = true;
    workloadError = error;
  } finally {
    if (worktreePrepared) {
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
    publishedLaneDir: generationLaneDir,
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
  const outputRoot = await root(outputDir);
  const runId = `${process.pid}-${randomUUID()}`;
  const generationRelative = path.posix.join(".mantis-generations", `generation-${runId}`);
  await outputRoot.mkdir(generationRelative);
  const generationDir = path.join(outputDir, ...generationRelative.split(path.posix.sep));
  const worktreeRoot = await ensureRepoBoundDirectory(
    repoRoot,
    `${outputDir}.worktrees`,
    "Mantis before/after worktree directory",
    { mode: 0o755 },
  );
  const comparisonPath = path.join(generationDir, "comparison.json");
  const manifestPath = path.join(generationDir, "mantis-evidence.json");
  const reportPath = path.join(generationDir, "mantis-report.md");

  try {
    await removeLegacyMantisWorktrees({
      commandTimeouts,
      outputDir,
      repoRoot,
      runner,
    });
    const commonOpts = {
      credentialRole: trimToValue(opts.credentialRole) ?? DEFAULT_CREDENTIAL_ROLE,
      credentialSource: trimToValue(opts.credentialSource) ?? DEFAULT_CREDENTIAL_SOURCE,
      fastMode: opts.fastMode ?? true,
      providerMode: trimToValue(opts.providerMode) ?? DEFAULT_PROVIDER_MODE,
      skipBuild: opts.skipBuild ?? false,
      skipInstall: opts.skipInstall ?? false,
    };
    const baselineResult = await runLane({
      generationDir,
      lane: "baseline",
      ref: baseline,
      repoRoot,
      runId,
      runner,
      scenario,
      signal: opts.signal,
      commandTimeouts,
      worktreeRoot,
      opts: commonOpts,
    });
    const candidateResult = await runLane({
      generationDir,
      lane: "candidate",
      ref: candidate,
      repoRoot,
      runId,
      runner,
      scenario,
      signal: opts.signal,
      commandTimeouts,
      worktreeRoot,
      opts: commonOpts,
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
    } satisfies MantisComparison;
    await fs.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    await fs.writeFile(
      reportPath,
      renderReport({
        baseline: baselineResult,
        candidate: candidateResult,
        comparison,
        outputDir: generationDir,
        scenarioConfig,
      }),
      "utf8",
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        buildEvidenceManifest({
          baseline: baselineResult,
          candidate: candidateResult,
          comparison,
          outputDir: generationDir,
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
    await publishMantisRunOutput({
      generationDir,
      outputDir,
      outputRoot,
      signal: opts.signal,
    });
    return {
      comparisonPath,
      manifestPath,
      outputDir: generationDir,
      reportPath,
      status: comparison.pass ? "pass" : "fail",
    };
  } catch (error) {
    await throwMantisRunFailure({
      error,
      outputDir,
      outputRoot,
    });
  }
}
