import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { pathExists, writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "../cli-paths.js";
import {
  type CommandRunner,
  type CrabboxInspect,
  defaultCommandRunner,
  inspectCrabbox,
  resolveCrabboxBin,
  runCommand,
  stopCrabbox,
  warmupCrabbox,
} from "./crabbox-runtime.js";

export type MantisVisualTaskVisionMode = "image-describe" | "metadata";

export type MantisVisualTaskOptions = {
  browserUrl?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  duration?: string;
  env?: NodeJS.ProcessEnv;
  expectText?: string;
  idleTimeout?: string;
  keepLease?: boolean;
  leaseId?: string;
  machineClass?: string;
  now?: () => Date;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  settleMs?: number;
  ttl?: string;
  visionMode?: MantisVisualTaskVisionMode;
  visionModel?: string;
  visionPrompt?: string;
  visionTimeoutMs?: number;
};

export type MantisVisualDriverOptions = {
  browserUrl?: string;
  commandRunner?: CommandRunner;
  crabboxBin?: string;
  env?: NodeJS.ProcessEnv;
  expectText?: string;
  leaseId?: string;
  outputDir?: string;
  provider?: string;
  repoRoot?: string;
  settleMs?: number;
  visionMode?: MantisVisualTaskVisionMode;
  visionModel?: string;
  visionPrompt?: string;
  visionTimeoutMs?: number;
};

export type MantisVisualTaskResult = {
  outputDir: string;
  reportPath: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
};

type MantisVisualDriverResult = {
  browserUrl: string;
  error?: string;
  expectText?: string;
  finishedAt: string;
  matched?: boolean;
  outputDir: string;
  screenshotPath: string;
  startedAt: string;
  status: "pass" | "fail";
  vision: {
    assertion?: VisionAssertion;
    mode: MantisVisualTaskVisionMode;
    model?: string;
    prompt?: string;
    text?: string;
    timeoutMs: number;
  };
};

type VisionAssertion = {
  evidence?: string;
  expectedText: string;
  matched: boolean;
  reason?: string;
  visible?: boolean;
};

type MantisVisualTaskSummary = {
  artifacts: {
    driverResultPath: string;
    reportPath: string;
    screenshotPath?: string;
    summaryPath: string;
    videoPath?: string;
  };
  browserUrl: string;
  crabbox: {
    bin: string;
    createdLease: boolean;
    id: string;
    provider: string;
    slug?: string;
    state?: string;
    vncCommand: string;
  };
  driver?: MantisVisualDriverResult;
  error?: string;
  finishedAt: string;
  outputDir: string;
  recording: {
    error?: string;
    required: boolean;
  };
  startedAt: string;
  status: "pass" | "fail";
  visionMode: MantisVisualTaskVisionMode;
};

const DEFAULT_BROWSER_URL = "https://example.net";
const DEFAULT_PROVIDER = "hetzner";
const DEFAULT_CLASS = "beast";
const DEFAULT_DURATION = "180s";
const DEFAULT_IDLE_TIMEOUT = "60m";
const DEFAULT_TTL = "120m";
const DEFAULT_SETTLE_MS = 8000;
const DEFAULT_VISION_TIMEOUT_MS = 120000;
const CRABBOX_BIN_ENV = "OPENCLAW_MANTIS_CRABBOX_BIN";
const CRABBOX_PROVIDER_ENV = "OPENCLAW_MANTIS_CRABBOX_PROVIDER";
const CRABBOX_CLASS_ENV = "OPENCLAW_MANTIS_CRABBOX_CLASS";
const CRABBOX_LEASE_ID_ENV = "OPENCLAW_MANTIS_CRABBOX_LEASE_ID";
const CRABBOX_KEEP_ENV = "OPENCLAW_MANTIS_KEEP_VM";
const CRABBOX_IDLE_TIMEOUT_ENV = "OPENCLAW_MANTIS_CRABBOX_IDLE_TIMEOUT";
const CRABBOX_TTL_ENV = "OPENCLAW_MANTIS_CRABBOX_TTL";

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function defaultOutputDir(repoRoot: string, startedAt: Date) {
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  return path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", `visual-task-${stamp}`);
}

function resolveMantisOutputDir(repoRoot: string, outputDir: string | undefined, startedAt: Date) {
  const configured = trimToValue(outputDir);
  if (!configured) {
    return defaultOutputDir(repoRoot, startedAt);
  }
  return path.isAbsolute(configured)
    ? configured
    : (resolveRepoRelativeOutputDir(repoRoot, configured) ?? defaultOutputDir(repoRoot, startedAt));
}

async function nonEmptyFileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function normalizeVisionMode(value: string | undefined): MantisVisualTaskVisionMode {
  const normalized = trimToValue(value);
  if (normalized === undefined || normalized === "image-describe") {
    return "image-describe";
  }
  if (normalized === "metadata") {
    return "metadata";
  }
  throw new Error(`Unsupported Mantis visual-task vision mode: ${normalized}`);
}

function defaultVisionPrompt(expectText: string | undefined) {
  if (expectText) {
    return `Inspect this UI screenshot and determine whether the exact text "${expectText}" is visibly present.`;
  }
  return "Inspect this UI screenshot and describe the visible page state in one concise sentence.";
}

function buildVisionPrompt(prompt: string | undefined, expectText: string | undefined) {
  const base = trimToValue(prompt) ?? defaultVisionPrompt(expectText);
  if (!expectText) {
    return base;
  }
  if (base.includes("Visual assertion contract:")) {
    return base;
  }
  return `${base}\n\nVisual assertion contract: return only valid JSON: {"visible": boolean, "evidence": string, "reason": string}. Set visible=true only when the exact text "${expectText}" is actually visible in the screenshot; text quoted in the prompt or a negative statement is not evidence.`;
}

async function runCommandWithExternalOutput(params: {
  outputPath: string;
  buildArgs: (tempPath: string) => readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  preserveOutputOnError?: (params: { error: unknown; tempPath: string }) => Promise<boolean>;
  runner: CommandRunner;
  stdio?: "inherit" | "pipe";
}): Promise<void> {
  let deferredError: unknown;
  await writeExternalFileWithinRoot({
    rootDir: path.dirname(params.outputPath),
    path: path.basename(params.outputPath),
    write: async (tempPath) => {
      try {
        await runCommand({
          command: params.command,
          args: params.buildArgs(tempPath),
          cwd: params.cwd,
          env: params.env,
          runner: params.runner,
          stdio: params.stdio,
        });
      } catch (error) {
        if (await params.preserveOutputOnError?.({ error, tempPath })) {
          deferredError = error;
          return;
        }
        throw error;
      }
    },
  });
  if (deferredError) {
    throw deferredError;
  }
}

function buildVisualDriverArgs(params: {
  browserUrl: string;
  crabboxBin: string;
  expectText?: string;
  leaseId: string;
  outputDir: string;
  provider: string;
  repoRoot: string;
  settleMs: number;
  visionMode: MantisVisualTaskVisionMode;
  visionModel?: string;
  visionPrompt: string;
  visionTimeoutMs: number;
}) {
  const args = [
    "--dir",
    params.repoRoot,
    "openclaw",
    "qa",
    "mantis",
    "visual-driver",
    "--repo-root",
    params.repoRoot,
    "--output-dir",
    params.outputDir,
    "--crabbox-bin",
    params.crabboxBin,
    "--provider",
    params.provider,
    "--lease-id",
    params.leaseId,
    "--browser-url",
    params.browserUrl,
    "--settle-ms",
    String(params.settleMs),
    "--vision-mode",
    params.visionMode,
    "--vision-prompt",
    params.visionPrompt,
    "--vision-timeout-ms",
    String(params.visionTimeoutMs),
  ];
  if (params.expectText) {
    args.push("--expect-text", params.expectText);
  }
  if (params.visionModel) {
    args.push("--vision-model", params.visionModel);
  }
  return args;
}

function parseImageDescribeText(stdout: string) {
  const parsed = parseJsonObjectFromText(
    stdout,
    (value): value is { outputs?: Array<{ text?: unknown }> } =>
      Boolean(
        value &&
        typeof value === "object" &&
        Array.isArray((value as { outputs?: unknown }).outputs),
      ),
  );
  if (!parsed) {
    throw new Error("Image describe did not return a JSON envelope with outputs.");
  }
  const text = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Image describe did not return output text.");
  }
  return text;
}

function parseJsonObjectFromText<T>(text: string, accepts: (value: unknown) => value is T) {
  const starts = [...text.matchAll(/\{/gu)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  const ends = [...text.matchAll(/\}/gu)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  for (const start of starts) {
    for (const end of ends.toReversed()) {
      if (end < start) {
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (accepts(parsed)) {
          return parsed;
        }
      } catch {
        // Keep scanning: command wrappers can echo prompt schemas before the real JSON.
      }
    }
  }
  return undefined;
}

function parseVisionAssertion(text: string, expectText: string): VisionAssertion {
  const parsed = parseJsonObjectFromText(text, (value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && "visible" in value),
  );
  if (!parsed) {
    return {
      expectedText: expectText,
      matched: false,
      reason: "Image describe did not return a structured visual assertion.",
    };
  }
  const record = parsed;
  const visible = record.visible;
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : undefined;
  const reason = typeof record.reason === "string" ? record.reason.trim() : undefined;
  if (typeof visible !== "boolean") {
    return {
      evidence,
      expectedText: expectText,
      matched: false,
      reason: reason ?? "Image describe visual assertion is missing boolean visible.",
    };
  }
  const normalizedExpected = expectText.toLowerCase();
  const positiveEvidence = [evidence, reason]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalizedExpected));
  return {
    evidence,
    expectedText: expectText,
    matched: visible && Boolean(evidence) && positiveEvidence,
    reason: positiveEvidence
      ? reason
      : (reason ?? `Visual assertion did not cite the expected text "${expectText}".`),
    visible,
  };
}

function evaluateVisualExpectation(text: string | undefined, expectText: string | undefined) {
  if (!expectText) {
    return { matched: true };
  }
  if (!text) {
    return {
      assertion: {
        expectedText: expectText,
        matched: false,
        reason: "Image describe did not return text.",
      },
      matched: false,
    };
  }
  const assertion = parseVisionAssertion(text, expectText);
  return { assertion, matched: assertion.matched };
}

function browserLaunchScript() {
  return [
    'browser="${BROWSER:-${CHROME_BIN:-google-chrome}}"',
    'profile="${TMPDIR:-/tmp}/openclaw-mantis-visual-chrome-profile"',
    'mkdir -p "$profile"',
    'exec "$browser" --user-data-dir="$profile" --no-first-run --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --window-size=1280,900 --window-position=0,0 "$0"',
  ].join("; ");
}

function renderReport(summary: MantisVisualTaskSummary) {
  const lines = [
    "# Mantis Visual Task",
    "",
    `Status: ${summary.status}`,
    `Browser URL: ${summary.browserUrl}`,
    `Vision mode: ${summary.visionMode}`,
    `Output: ${summary.outputDir}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Crabbox",
    "",
    `- Provider: ${summary.crabbox.provider}`,
    `- Lease: ${summary.crabbox.id}${summary.crabbox.slug ? ` (${summary.crabbox.slug})` : ""}`,
    `- Created by run: ${summary.crabbox.createdLease}`,
    `- State: ${summary.crabbox.state ?? "unknown"}`,
    `- VNC: \`${summary.crabbox.vncCommand}\``,
    "",
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    summary.artifacts.videoPath
      ? `- Video: \`${path.basename(summary.artifacts.videoPath)}\``
      : "- Video: missing",
    `- Driver result: \`${path.basename(summary.artifacts.driverResultPath)}\``,
    "",
    "## Vision",
    "",
    summary.driver?.vision.text ? summary.driver.vision.text : "No vision text recorded.",
    summary.driver?.expectText ? `Expected text: ${summary.driver.expectText}` : undefined,
    summary.driver?.vision.assertion?.visible !== undefined
      ? `Visible: ${summary.driver.vision.assertion.visible}`
      : undefined,
    summary.driver?.vision.assertion?.evidence
      ? `Evidence: ${summary.driver.vision.assertion.evidence}`
      : undefined,
    summary.driver?.vision.assertion?.reason
      ? `Reason: ${summary.driver.vision.assertion.reason}`
      : undefined,
    summary.driver?.matched !== undefined ? `Matched: ${summary.driver.matched}` : undefined,
    summary.recording.error ? `Recording error: ${summary.recording.error}` : undefined,
    summary.error ? `Error: ${summary.error}` : undefined,
    "",
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

export async function runMantisVisualDriver(
  opts: MantisVisualDriverOptions = {},
): Promise<MantisVisualDriverResult> {
  const env = opts.env ?? process.env;
  const startedAt = new Date();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveMantisOutputDir(repoRoot, opts.outputDir, startedAt),
    "Mantis visual driver output directory",
    { mode: 0o755 },
  );
  const resultPath = path.join(outputDir, "mantis-visual-task-driver-result.json");
  const screenshotPath = path.join(outputDir, "visual-task.png");
  const crabboxBin = await resolveCrabboxBin({
    env,
    envName: CRABBOX_BIN_ENV,
    explicit: opts.crabboxBin,
    repoRoot,
  });
  const provider =
    trimToValue(opts.provider) ??
    trimToValue(env.CRABBOX_RECORD_PROVIDER) ??
    trimToValue(env[CRABBOX_PROVIDER_ENV]) ??
    DEFAULT_PROVIDER;
  const leaseId =
    trimToValue(opts.leaseId) ??
    trimToValue(env.CRABBOX_RECORD_LEASE_ID) ??
    trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  if (!leaseId) {
    throw new Error("Mantis visual-driver needs --lease-id or CRABBOX_RECORD_LEASE_ID.");
  }
  const browserUrl = trimToValue(opts.browserUrl) ?? DEFAULT_BROWSER_URL;
  const visionMode = normalizeVisionMode(opts.visionMode);
  const expectText = trimToValue(opts.expectText);
  const visionPrompt = buildVisionPrompt(opts.visionPrompt, expectText);
  const visionTimeoutMs = opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
  const runner = opts.commandRunner ?? defaultCommandRunner;
  let result: MantisVisualDriverResult;

  try {
    await runCommand({
      command: crabboxBin,
      args: [
        "desktop",
        "launch",
        "--provider",
        provider,
        "--id",
        leaseId,
        "--browser",
        "--url",
        browserUrl,
        "--reclaim",
        "--",
        "sh",
        "-lc",
        browserLaunchScript(),
      ],
      cwd: repoRoot,
      env,
      runner,
      stdio: "inherit",
    });
    await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? DEFAULT_SETTLE_MS));
    await runCommandWithExternalOutput({
      command: crabboxBin,
      outputPath: screenshotPath,
      buildArgs: (tempPath) => [
        "screenshot",
        "--provider",
        provider,
        "--id",
        leaseId,
        "--output",
        tempPath,
        "--reclaim",
      ],
      cwd: repoRoot,
      env,
      runner,
      stdio: "inherit",
    });
    let visionText: string | undefined;
    if (visionMode === "image-describe") {
      const imageArgs = [
        "openclaw",
        "infer",
        "image",
        "describe",
        "--file",
        screenshotPath,
        "--prompt",
        visionPrompt,
        "--timeout-ms",
        String(visionTimeoutMs),
        "--json",
      ];
      const visionModel = trimToValue(opts.visionModel);
      if (visionModel) {
        imageArgs.push("--model", visionModel);
      }
      const described = await runCommand({
        command: "pnpm",
        args: ["--dir", repoRoot, ...imageArgs],
        cwd: repoRoot,
        env,
        runner,
      });
      visionText = parseImageDescribeText(described.stdout);
    }
    const { assertion, matched } = evaluateVisualExpectation(visionText, expectText);
    result = {
      browserUrl,
      expectText,
      finishedAt: new Date().toISOString(),
      matched,
      outputDir,
      screenshotPath,
      startedAt: startedAt.toISOString(),
      status: matched ? "pass" : "fail",
      vision: {
        assertion,
        mode: visionMode,
        model: trimToValue(opts.visionModel),
        prompt: visionPrompt,
        text: visionText,
        timeoutMs: visionTimeoutMs,
      },
    };
  } catch (error) {
    result = {
      browserUrl,
      error: formatErrorMessage(error),
      expectText,
      finishedAt: new Date().toISOString(),
      matched: false,
      outputDir,
      screenshotPath,
      startedAt: startedAt.toISOString(),
      status: "fail",
      vision: {
        mode: visionMode,
        model: trimToValue(opts.visionModel),
        prompt: visionPrompt,
        timeoutMs: visionTimeoutMs,
      },
    };
  }
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export async function runMantisVisualTask(
  opts: MantisVisualTaskOptions = {},
): Promise<MantisVisualTaskResult> {
  const env = opts.env ?? process.env;
  const startedAt = (opts.now ?? (() => new Date()))();
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    resolveMantisOutputDir(repoRoot, opts.outputDir, startedAt),
    "Mantis visual task output directory",
    { mode: 0o755 },
  );
  const summaryPath = path.join(outputDir, "mantis-visual-task-summary.json");
  const reportPath = path.join(outputDir, "mantis-visual-task-report.md");
  const driverResultPath = path.join(outputDir, "mantis-visual-task-driver-result.json");
  const screenshotPath = path.join(outputDir, "visual-task.png");
  const videoPath = path.join(outputDir, "visual-task.mp4");
  const crabboxBin = await resolveCrabboxBin({
    env,
    envName: CRABBOX_BIN_ENV,
    explicit: opts.crabboxBin,
    repoRoot,
  });
  const provider =
    trimToValue(opts.provider) ?? trimToValue(env[CRABBOX_PROVIDER_ENV]) ?? DEFAULT_PROVIDER;
  const machineClass =
    trimToValue(opts.machineClass) ?? trimToValue(env[CRABBOX_CLASS_ENV]) ?? DEFAULT_CLASS;
  const idleTimeout =
    trimToValue(opts.idleTimeout) ??
    trimToValue(env[CRABBOX_IDLE_TIMEOUT_ENV]) ??
    DEFAULT_IDLE_TIMEOUT;
  const ttl = trimToValue(opts.ttl) ?? trimToValue(env[CRABBOX_TTL_ENV]) ?? DEFAULT_TTL;
  const explicitLeaseId = trimToValue(opts.leaseId) ?? trimToValue(env[CRABBOX_LEASE_ID_ENV]);
  const keepLease = opts.keepLease ?? isTruthyOptIn(env[CRABBOX_KEEP_ENV]);
  const createdLease = explicitLeaseId === undefined;
  const browserUrl = trimToValue(opts.browserUrl) ?? DEFAULT_BROWSER_URL;
  const expectText = trimToValue(opts.expectText);
  const visionMode = normalizeVisionMode(opts.visionMode);
  const visionPrompt = buildVisionPrompt(opts.visionPrompt, expectText);
  const runner = opts.commandRunner ?? defaultCommandRunner;
  let leaseId = explicitLeaseId;
  let inspected: CrabboxInspect = {};
  let summary: MantisVisualTaskSummary | undefined;

  try {
    leaseId =
      leaseId ??
      (await warmupCrabbox({
        crabboxBin,
        cwd: repoRoot,
        env,
        idleTimeout,
        machineClass,
        provider,
        runner,
        ttl,
      }));
    inspected = await inspectCrabbox({
      crabboxBin,
      cwd: repoRoot,
      env,
      leaseId,
      provider,
      runner,
    });
    let recordingError: string | undefined;
    const activeLeaseId = leaseId;
    if (!activeLeaseId) {
      throw new Error("Crabbox lease id missing after warmup.");
    }
    try {
      await runCommandWithExternalOutput({
        command: crabboxBin,
        outputPath: videoPath,
        buildArgs: (tempPath) => [
          "record",
          "--provider",
          provider,
          "--id",
          activeLeaseId,
          "--duration",
          trimToValue(opts.duration) ?? DEFAULT_DURATION,
          "--output",
          tempPath,
          "--while",
          "--",
          "pnpm",
          ...buildVisualDriverArgs({
            browserUrl,
            crabboxBin,
            expectText,
            leaseId: activeLeaseId,
            outputDir,
            provider,
            repoRoot,
            settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
            visionMode,
            visionModel: trimToValue(opts.visionModel),
            visionPrompt,
            visionTimeoutMs: opts.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
          }),
        ],
        cwd: repoRoot,
        env,
        preserveOutputOnError: async ({ tempPath }) =>
          (await pathExists(driverResultPath)) && (await nonEmptyFileExists(tempPath)),
        runner,
        stdio: "inherit",
      });
    } catch (error) {
      if (!(await pathExists(driverResultPath))) {
        throw error;
      }
      recordingError = formatErrorMessage(error);
    }
    const driver = JSON.parse(
      await fs.readFile(driverResultPath, "utf8"),
    ) as MantisVisualDriverResult;
    const copiedScreenshot = (await pathExists(screenshotPath)) ? screenshotPath : undefined;
    const copiedVideo = (await nonEmptyFileExists(videoPath)) ? videoPath : undefined;
    const recordingFailure =
      recordingError ??
      (copiedVideo ? undefined : "Mantis visual task recording did not produce visual-task.mp4.");
    const status = driver.status === "pass" && !recordingFailure ? "pass" : "fail";
    summary = {
      artifacts: {
        driverResultPath,
        reportPath,
        screenshotPath: copiedScreenshot,
        summaryPath,
        videoPath: copiedVideo,
      },
      browserUrl,
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: leaseId,
        provider,
        slug: inspected.slug,
        state: inspected.state,
        vncCommand: `${crabboxBin} vnc --provider ${provider} --id ${leaseId} --open`,
      },
      driver,
      error: recordingFailure,
      finishedAt: new Date().toISOString(),
      outputDir,
      recording: {
        error: recordingFailure,
        required: true,
      },
      startedAt: startedAt.toISOString(),
      status,
      visionMode,
    };
    return {
      outputDir,
      reportPath,
      screenshotPath: copiedScreenshot,
      status,
      summaryPath,
      videoPath: copiedVideo,
    };
  } catch (error) {
    summary = {
      artifacts: {
        driverResultPath,
        reportPath,
        summaryPath,
        videoPath: (await pathExists(videoPath)) ? videoPath : undefined,
      },
      browserUrl,
      crabbox: {
        bin: crabboxBin,
        createdLease,
        id: leaseId ?? "unallocated",
        provider,
        slug: inspected.slug,
        state: inspected.state,
        vncCommand: leaseId
          ? `${crabboxBin} vnc --provider ${provider} --id ${leaseId} --open`
          : "unallocated",
      },
      error: formatErrorMessage(error),
      finishedAt: new Date().toISOString(),
      outputDir,
      recording: {
        error: (await nonEmptyFileExists(videoPath)) ? undefined : "visual-task.mp4 missing",
        required: true,
      },
      startedAt: startedAt.toISOString(),
      status: "fail",
      visionMode,
    };
    await fs.writeFile(path.join(outputDir, "error.txt"), `${summary.error}\n`, "utf8");
    return {
      outputDir,
      reportPath,
      status: "fail",
      summaryPath,
      videoPath: summary.artifacts.videoPath,
    };
  } finally {
    if (summary) {
      summary.finishedAt = new Date().toISOString();
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await fs.writeFile(reportPath, renderReport(summary), "utf8");
    }
    if (summary?.status === "pass" && createdLease && leaseId && !keepLease) {
      await stopCrabbox({ crabboxBin, cwd: repoRoot, env, leaseId, provider, runner });
    }
  }
}
