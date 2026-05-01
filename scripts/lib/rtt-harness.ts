import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RttProviderMode = "mock-openai" | "live-frontier";

export type RttCliOptions = {
  providerMode: RttProviderMode;
  runs: number;
  harnessRoot: string;
  output: string;
  scenarios: string[];
  timeoutMs: number;
};

export type RttResult = {
  package: {
    spec: string;
    version: string;
  };
  run: {
    id: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    status: "pass" | "fail";
  };
  mode: {
    providerMode: RttProviderMode;
    scenarios: string[];
  };
  rtt: {
    canaryMs?: number;
    mentionReplyMs?: number;
  };
  artifacts: {
    rawSummaryPath: string;
    rawReportPath: string;
    rawObservedMessagesPath: string;
    resultPath: string;
  };
};

export type TelegramQaSummary = {
  scenarios?: Array<{
    id?: string;
    rttMs?: number;
    status?: string;
  }>;
};

const OPENCLAW_PACKAGE_SPEC_RE =
  /^openclaw@(beta|latest|[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*|-beta\.[1-9][0-9]*)?)$/u;

const REQUIRED_TELEGRAM_ENV = [
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
] as const;

export function validateOpenClawPackageSpec(spec: string) {
  if (!OPENCLAW_PACKAGE_SPEC_RE.test(spec)) {
    throw new Error(
      `Package spec must be openclaw@beta, openclaw@latest, or an exact OpenClaw release version; got: ${spec}`,
    );
  }
  return spec;
}

export function safeRunLabel(input: string) {
  return input.replace(/[^a-zA-Z0-9.-]+/gu, "_").replace(/^_+|_+$/gu, "");
}

export function buildRunId(params: { now: Date; spec: string; index?: number }) {
  const stamp = params.now.toISOString().replaceAll(":", "").replaceAll(".", "");
  const suffix = params.index === undefined ? "" : `-${params.index + 1}`;
  return `${stamp}-${safeRunLabel(params.spec)}${suffix}`;
}

export function extractRtt(summary: TelegramQaSummary) {
  const scenarios = summary.scenarios ?? [];
  return {
    canaryMs: scenarios.find((scenario) => scenario.id === "telegram-canary")?.rttMs,
    mentionReplyMs: scenarios.find((scenario) => scenario.id === "telegram-mentioned-message-reply")
      ?.rttMs,
  };
}

export function createHarnessEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  providerMode: RttProviderMode;
  scenarios: string[];
  spec: string;
  version: string;
  rawOutputDir: string;
  timeoutMs: number;
}) {
  return {
    ...params.baseEnv,
    OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: params.spec,
    OPENCLAW_NPM_TELEGRAM_PACKAGE_LABEL: `${params.spec} (${params.version})`,
    OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: params.providerMode,
    OPENCLAW_NPM_TELEGRAM_SCENARIOS: params.scenarios.join(","),
    OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: params.rawOutputDir,
    OPENCLAW_NPM_TELEGRAM_FAST: params.baseEnv.OPENCLAW_NPM_TELEGRAM_FAST ?? "1",
    OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: String(params.timeoutMs),
    OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: String(params.timeoutMs),
  };
}

export function assertRequiredEnv(env: NodeJS.ProcessEnv) {
  const missing = REQUIRED_TELEGRAM_ENV.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing Telegram QA env: ${missing.join(", ")}`);
  }
}

export async function assertHarnessRoot(harnessRoot: string) {
  const scriptPath = path.join(harnessRoot, "scripts/e2e/npm-telegram-rtt-docker.sh");
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(`Missing OpenClaw Telegram npm harness: ${scriptPath}`);
  }
}

export async function assertDockerAvailable() {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
    });
  } catch {
    throw new Error("Docker is required for RTT runs; install/start Docker and retry.");
  }
}

export async function resolvePublishedVersion(spec: string) {
  const { stdout } = await execFileAsync("npm", ["view", spec, "version", "--json"], {
    timeout: 30_000,
  });
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (typeof parsed !== "string" || parsed.trim().length === 0) {
    throw new Error(`npm did not return a version for ${spec}.`);
  }
  return parsed.trim();
}

export async function readTelegramSummary(summaryPath: string) {
  return JSON.parse(await fs.readFile(summaryPath, "utf8")) as TelegramQaSummary;
}

export async function writeJson(pathname: string, value: unknown) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonl(pathname: string, value: unknown) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.appendFile(pathname, `${JSON.stringify(value)}\n`);
}

export async function runHarness(params: { env: NodeJS.ProcessEnv; harnessRoot: string }) {
  const scriptPath = path.join(params.harnessRoot, "scripts/e2e/npm-telegram-rtt-docker.sh");
  const child = spawn("bash", [scriptPath], {
    cwd: params.harnessRoot,
    env: params.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return exitCode ?? 1;
}

export function buildRttResult(params: {
  artifacts: RttResult["artifacts"];
  finishedAt: Date;
  providerMode: RttProviderMode;
  rawSummary: TelegramQaSummary;
  runId: string;
  scenarios: string[];
  spec: string;
  startedAt: Date;
  version: string;
}): RttResult {
  const failed = (params.rawSummary.scenarios ?? []).some((scenario) => scenario.status === "fail");
  return {
    package: {
      spec: params.spec,
      version: params.version,
    },
    run: {
      id: params.runId,
      startedAt: params.startedAt.toISOString(),
      finishedAt: params.finishedAt.toISOString(),
      durationMs: params.finishedAt.getTime() - params.startedAt.getTime(),
      status: failed ? "fail" : "pass",
    },
    mode: {
      providerMode: params.providerMode,
      scenarios: params.scenarios,
    },
    rtt: extractRtt(params.rawSummary),
    artifacts: params.artifacts,
  };
}

export const __testing = {
  REQUIRED_TELEGRAM_ENV,
};
