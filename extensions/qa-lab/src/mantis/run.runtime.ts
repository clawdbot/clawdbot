import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";

export type MantisBeforeAfterOptions = {
  allowFailures?: boolean;
  baseline?: string;
  candidate?: string;
  commandRunner?: CommandRunner;
  credentialRole?: string;
  credentialSource?: string;
  fastMode?: boolean;
  now?: () => Date;
  outputDir?: string;
  providerMode?: string;
  repoRoot?: string;
  scenario?: string;
  skipBuild?: boolean;
  skipInstall?: boolean;
  transport?: string;
};

export type MantisBeforeAfterResult = {
  comparisonPath: string;
  manifestPath: string;
  outputDir: string;
  reportPath: string;
  status: "pass" | "fail";
};

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<void>;

type DiscordQaSummary = {
  scenarios?: {
    artifactPaths?: Record<string, string>;
    details?: string;
    id?: string;
    status?: string;
    title?: string;
  }[];
};

type LaneResult = {
  outputDir: string;
  scenarioDetails?: string;
  screenshotPath?: string;
  status: string;
  summaryPath: string;
  videoPath?: string;
};

type Comparison = {
  baseline: {
    expected: "queued-only";
    ref: string;
    reproduced: boolean;
    screenshotPath?: string;
    status: string;
    videoPath?: string;
  };
  candidate: {
    expected: "queued -> thinking -> done";
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
const DEFAULT_TRANSPORT = "discord";
const DEFAULT_PROVIDER_MODE = "live-frontier";
const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_CREDENTIAL_SOURCE = "convex";
const DEFAULT_CREDENTIAL_ROLE = "ci";

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

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

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

async function runCommand(params: {
  args: readonly string[];
  command: string;
  cwd: string;
  runner: CommandRunner;
}) {
  await params.runner(params.command, params.args, {
    cwd: params.cwd,
    env: process.env,
    stdio: "inherit",
  });
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

function renderReport(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: Comparison;
  outputDir: string;
}) {
  const lines = [
    "# Mantis Before/After",
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

function buildEvidenceManifest(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: Comparison;
  outputDir: string;
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
      alt: "Baseline Discord status reaction timeline",
      kind: "timeline",
      label: "Baseline queued-only",
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
      alt: "Candidate Discord status reaction timeline",
      kind: "timeline",
      label: "Candidate queued -> thinking -> done",
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
    title: "Mantis Before/After QA",
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
  runner: CommandRunner;
  scenario: string;
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
  await runCommand({
    command: "git",
    args: ["worktree", "add", "--detach", worktreeDir, params.ref],
    cwd: params.repoRoot,
    runner: params.runner,
  });
  if (!params.opts.skipInstall) {
    await runCommand({
      command: "pnpm",
      args: ["--dir", worktreeDir, "install", "--frozen-lockfile"],
      cwd: params.repoRoot,
      runner: params.runner,
    });
  }
  if (!params.opts.skipBuild) {
    await runCommand({
      command: "pnpm",
      args: ["--dir", worktreeDir, "build"],
      cwd: params.repoRoot,
      runner: params.runner,
    });
  }
  await runCommand({
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
    cwd: params.repoRoot,
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
    [DEFAULT_SCENARIO],
    "--scenario",
  );
  const baseline = trimToValue(opts.baseline) ?? DEFAULT_BASELINE_REF;
  const candidate = trimToValue(opts.candidate) ?? DEFAULT_CANDIDATE_REF;
  const runner = opts.commandRunner ?? defaultCommandRunner;
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
      worktreeRoot,
      opts: commonOpts,
    });
    const comparison = {
      baseline: {
        expected: "queued-only",
        ref: baseline,
        reproduced: baselineResult.status === "fail",
        screenshotPath: baselineResult.screenshotPath,
        status: baselineResult.status,
        videoPath: baselineResult.videoPath,
      },
      candidate: {
        expected: "queued -> thinking -> done",
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
    await fs.writeFile(path.join(outputDir, "error.txt"), `${formatErrorMessage(error)}\n`, "utf8");
    throw error;
  }
}
