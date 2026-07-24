// Qa Lab plugin module implements run behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import { QA_EVIDENCE_FILENAME, validateQaEvidenceSummaryJson } from "../evidence-summary.js";
import { trimToValue } from "../mantis-options.runtime.js";
import {
  assertMantisCommandNotAborted,
  createMantisWorktreeDirectory,
  defaultMantisCommandRunner,
  removeMantisWorktree,
  resolveMantisCommandTimeouts,
  runMantisCommand,
  type MantisCommandExecution,
  type MantisCommandRunner,
  type MantisCommandTimeoutOverrides,
  type MantisCommandTimeouts,
  type MantisWorktreeOwnership,
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

type LaneResult = {
  outputDir: string;
  scenarioDetails?: string;
  screenshotPath?: string;
  status: string;
  summaryPath: string;
  videoPath?: string;
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

async function copyDirContents(sourceDir: string, targetDir: string) {
  await fs.rm(targetDir, { force: true, recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function readLaneResult(params: {
  laneOutputDir: string;
  publishedLaneDir: string;
  scenario: string;
}) {
  const normalized = await readNormalizedLaneResult(params);
  if (normalized) {
    return {
      outputDir: params.publishedLaneDir,
      scenarioDetails: normalized.details,
      screenshotPath: normalized.screenshotPath,
      status: normalized.status,
      summaryPath: normalized.summaryPath,
      videoPath: normalized.videoPath,
    } satisfies LaneResult;
  }

  const summaryPath = path.join(params.publishedLaneDir, "discord-qa-summary.json");
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as DiscordQaSummary;
  const scenarioSummary =
    summary.scenarios?.find((entry) => entry.id === params.scenario) ?? summary.scenarios?.[0];
  const status = scenarioSummary?.status ?? "fail";
  const screenshotPath = scenarioSummary?.artifactPaths?.screenshot;
  const videoPath = scenarioSummary?.artifactPaths?.video;
  return {
    outputDir: params.publishedLaneDir,
    scenarioDetails: scenarioSummary?.details,
    screenshotPath,
    status,
    summaryPath,
    videoPath,
  } satisfies LaneResult;
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

async function copyScreenshot(params: { lane: "baseline" | "candidate"; result: LaneResult }) {
  if (!params.result.screenshotPath) {
    return undefined;
  }
  const source = path.isAbsolute(params.result.screenshotPath)
    ? params.result.screenshotPath
    : path.join(params.result.outputDir, params.result.screenshotPath);
  const target = path.join(params.result.outputDir, `${params.lane}.png`);
  await fs.copyFile(source, target);
  return target;
}

async function copyVideo(params: { lane: "baseline" | "candidate"; result: LaneResult }) {
  if (!params.result.videoPath) {
    return undefined;
  }
  const source = path.isAbsolute(params.result.videoPath)
    ? params.result.videoPath
    : path.join(params.result.outputDir, params.result.videoPath);
  const target = path.join(params.result.outputDir, `${params.lane}.mp4`);
  await fs.copyFile(source, target);
  return target;
}

async function runLane(params: {
  lane: "baseline" | "candidate";
  outputDir: string;
  ref: string;
  repoRoot: string;
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
  const worktreeDir = path.join(params.worktreeRoot, params.lane);
  const worktreeOutputDir = path.join(".artifacts", "qa-e2e", "mantis", "run", params.lane);
  const worktreeAddArgs = ["worktree", "add", "--detach", "--", worktreeDir, params.ref];
  const worktreeAddExecution = {
    cwd: params.repoRoot,
    env: process.env,
    signal: params.signal,
    stage: "worktree-add",
    timeoutMs: params.commandTimeouts["worktree-add"],
  } satisfies MantisCommandExecution;
  let worktreeOwnership: MantisWorktreeOwnership | undefined;
  let laneResult: LaneResult | undefined;
  let workloadFailed = false;
  let workloadError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;

  try {
    assertMantisCommandNotAborted({
      command: "git",
      args: worktreeAddArgs,
      execution: worktreeAddExecution,
      lane: params.lane,
    });
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
    const publishedLaneDir = path.join(params.outputDir, params.lane);
    await copyDirContents(path.join(worktreeDir, worktreeOutputDir), publishedLaneDir);
    const result = await readLaneResult({
      laneOutputDir: path.join(worktreeDir, worktreeOutputDir),
      publishedLaneDir,
      scenario: params.scenario,
    });
    const copiedScreenshot = await copyScreenshot({ lane: params.lane, result });
    const copiedVideo = await copyVideo({ lane: params.lane, result });
    laneResult = {
      ...result,
      screenshotPath: copiedScreenshot ?? result.screenshotPath,
      videoPath: copiedVideo ?? result.videoPath,
    } satisfies LaneResult;
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
  if (!laneResult) {
    throw new Error("Mantis lane completed without a result.");
  }
  return laneResult;
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
  await fs.mkdir(worktreeRoot, { recursive: true });

  try {
    const commonOpts = {
      credentialRole: trimToValue(opts.credentialRole) ?? DEFAULT_CREDENTIAL_ROLE,
      credentialSource: trimToValue(opts.credentialSource) ?? DEFAULT_CREDENTIAL_SOURCE,
      fastMode: opts.fastMode ?? true,
      providerMode: trimToValue(opts.providerMode) ?? DEFAULT_PROVIDER_MODE,
      skipBuild: opts.skipBuild ?? false,
      skipInstall: opts.skipInstall ?? false,
    };
    const baselineResult = await runLane({
      lane: "baseline",
      outputDir,
      ref: baseline,
      repoRoot,
      runner,
      scenario,
      signal: opts.signal,
      commandTimeouts,
      worktreeRoot,
      opts: commonOpts,
    });
    const candidateResult = await runLane({
      lane: "candidate",
      outputDir,
      ref: candidate,
      repoRoot,
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
    } satisfies Comparison;
    await fs.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    await fs.writeFile(
      reportPath,
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
      manifestPath,
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
    return {
      comparisonPath,
      manifestPath,
      outputDir,
      reportPath,
      status: comparison.pass ? "pass" : "fail",
    };
  } catch (error) {
    await fs.writeFile(
      path.join(outputDir, "error.txt"),
      `${formatMantisFailure(error)}\n`,
      "utf8",
    );
    throw error;
  }
}
