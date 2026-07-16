/** macOS LaunchAgent installer, runtime inspection, and lifecycle controls. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import { parseStrictInteger, parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { sleep } from "../utils.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayServiceDescription,
  resolveGatewayLaunchAgentLabel,
  resolveLegacyGatewayLaunchAgentLabels,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";
import {
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  buildLaunchAgentPlist as buildLaunchAgentPlistImpl,
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveGatewayStateDir, resolveHomeDir } from "./paths.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
} from "./service-types.js";

const LAUNCH_AGENT_DIR_MODE = 0o755;
// launchd rejects user LaunchAgent plists without group/other read access on
// current macOS. Secrets stay in the separate 0600 environment file.
const LAUNCH_AGENT_PLIST_MODE = 0o644;
const LAUNCH_AGENT_PRIVATE_DIR_MODE = 0o700;
const LAUNCH_AGENT_ENV_FILE_MODE = 0o600;
const LAUNCH_AGENT_ENV_WRAPPER_MODE = 0o700;
const LAUNCH_AGENT_ENV_DIR_NAME = "service-env";
const LAUNCH_AGENT_STDERR_PATH = "/dev/null";
const OPENCLAW_UPDATE_LAUNCHD_LABEL_PREFIX = "ai.openclaw.update.";
const OPENCLAW_MANUAL_UPDATE_LAUNCHD_LABEL_PATTERN = /^ai\.openclaw\.manual-update\.\d+$/;
const OPENCLAW_PROFILE_UPDATE_LAUNCHD_LABEL_PATTERN =
  /^ai\.openclaw\.[A-Za-z0-9._-]+\.update\.[A-Za-z0-9._-]+$/;
const OPENCLAW_DIRECT_CLI_NAMES = new Set(["openclaw", "openclaw.mjs"]);
const OPENCLAW_NODE_RUNTIME_NAMES = new Set(["bun", "bun.exe", "node", "node.exe"]);
const OPENCLAW_SCRIPT_NAMES = new Set(["openclaw.mjs"]);
const LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
const LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS = 100;

export type StaleOpenClawUpdateLaunchdJob = {
  label: string;
  pid?: number;
  lastExitStatus?: number;
};

type OpenClawUpdateLaunchdLabelCandidate = {
  label: string;
  requiresMetadata: boolean;
};

function normalizeOpenClawUpdateLaunchdLabel(label: unknown): string | null {
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  if (trimmed.startsWith(OPENCLAW_UPDATE_LAUNCHD_LABEL_PREFIX)) {
    return trimmed;
  }
  // Manual update jobs include a timestamp-like suffix and should be cleaned up
  // without matching arbitrary ai.openclaw labels.
  return OPENCLAW_MANUAL_UPDATE_LAUNCHD_LABEL_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeOpenClawUpdateLaunchdLabelCandidate(
  label: unknown,
): OpenClawUpdateLaunchdLabelCandidate | null {
  const normalized = normalizeOpenClawUpdateLaunchdLabel(label);
  if (normalized) {
    return { label: normalized, requiresMetadata: false };
  }
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  return OPENCLAW_PROFILE_UPDATE_LAUNCHD_LABEL_PATTERN.test(trimmed)
    ? { label: trimmed, requiresMetadata: true }
    : null;
}

function isCurrentGatewayLaunchdLabel(label: string, env: NodeJS.ProcessEnv): boolean {
  const gatewayProfileLabel = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  if (label === gatewayProfileLabel) {
    return true;
  }
  if (
    env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER ||
    env.OPENCLAW_SERVICE_KIND?.trim() !== GATEWAY_SERVICE_KIND
  ) {
    return false;
  }
  const configuredLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  return Boolean(configuredLabel && label === configuredLabel);
}

function resolveCurrentOpenClawUpdateLaunchdJobLabel(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawUpdateLaunchdLabelCandidate | null {
  for (const label of [
    env.LAUNCH_JOB_LABEL,
    env.LAUNCH_JOB_NAME,
    env.XPC_SERVICE_NAME,
    env.OPENCLAW_LAUNCHD_LABEL,
  ]) {
    const candidate = normalizeOpenClawUpdateLaunchdLabelCandidate(label);
    if (candidate) {
      if (isCurrentGatewayLaunchdLabel(candidate.label, env)) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

function assertValidLaunchAgentLabel(label: string): string {
  const trimmed = label.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid launchd label: ${sanitizeForLog(trimmed)}`);
  }
  return trimmed;
}

function resolveLaunchAgentLabel(args?: { env?: Record<string, string | undefined> }): string {
  const envLabel = args?.env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (envLabel) {
    return assertValidLaunchAgentLabel(envLabel);
  }
  return assertValidLaunchAgentLabel(resolveGatewayLaunchAgentLabel(args?.env?.OPENCLAW_PROFILE));
}

function resolveLaunchAgentPlistPathForLabel(
  env: Record<string, string | undefined>,
  label: string,
): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

function resolveLaunchAgentEnvDir(env: GatewayServiceEnv): string {
  return path.join(resolveGatewayStateDir(env), LAUNCH_AGENT_ENV_DIR_NAME);
}

function resolveLaunchAgentEnvFilePath(env: GatewayServiceEnv, label: string): string {
  return path.join(resolveLaunchAgentEnvDir(env), `${label}.env`);
}

function resolveLaunchAgentEnvWrapperPath(env: GatewayServiceEnv, label: string): string {
  return path.join(resolveLaunchAgentEnvDir(env), `${label}-env-wrapper.sh`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function collectLaunchAgentEnvironmentEntries(
  environment: GatewayServiceEnv | undefined,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(environment ?? {})) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    const value = rawValue?.trim();
    if (!key || !value) {
      continue;
    }
    entries.push([key, value]);
  }
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

function buildLaunchAgentEnvironmentFile(entries: Array<[string, string]>): string {
  return [
    "# Generated by OpenClaw. Do not edit while the gateway service is installed.",
    ...entries.map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
    "",
  ].join("\n");
}

function buildLaunchAgentEnvironmentWrapper(): string {
  return `#!/bin/sh
set -eu
env_file="$1"
shift
if [ -f "$env_file" ]; then
  . "$env_file"
fi
exec "$@"
`;
}

async function resolveLaunchAgentEnvironmentWrapperOverwriteWarnings(params: {
  wrapperPath: string;
  generatedWrapper: string;
}): Promise<string[]> {
  const existingWrapper = await fs.readFile(params.wrapperPath, "utf8").catch(() => null);
  if (existingWrapper === null || existingWrapper === params.generatedWrapper) {
    return [];
  }
  return [
    `Existing generated LaunchAgent env wrapper at ${params.wrapperPath} contains custom behavior and will be overwritten; move custom behavior to openclaw gateway install --wrapper <path> or OPENCLAW_WRAPPER.`,
  ];
}

function writeLaunchAgentOverwriteWarnings(
  stdout: NodeJS.WritableStream | undefined,
  warn: ((message: string) => void) | undefined,
  warnings: readonly string[],
): void {
  for (const warning of warnings) {
    if (warn) {
      warn(warning);
      continue;
    }
    if (!stdout) {
      continue;
    }
    stdout.write(`${formatLine("Warning", warning)}\n`);
  }
}

function isLaunchAgentEnvironmentWrapperArgs(params: {
  programArguments: string[];
  envFilePath: string;
  wrapperPath: string;
}): boolean {
  return (
    (params.programArguments[0] === params.wrapperPath &&
      params.programArguments[1] === params.envFilePath) ||
    (params.programArguments[0] === LAUNCH_AGENT_ENV_WRAPPER_SHELL &&
      params.programArguments[1] === params.wrapperPath &&
      params.programArguments[2] === params.envFilePath)
  );
}

async function prepareLaunchAgentProgramArguments(params: {
  env: GatewayServiceEnv;
  label: string;
  programArguments: string[];
  environment: GatewayServiceEnv | undefined;
  stdout?: NodeJS.WritableStream;
  warn?: (message: string) => void;
}): Promise<{
  programArguments: string[];
  inlineEnvironment?: GatewayServiceEnv;
}> {
  const entries = collectLaunchAgentEnvironmentEntries(params.environment);
  if (entries.length === 0) {
    return { programArguments: params.programArguments };
  }

  // Environment values with secrets live in an owner-only env file instead of
  // inline plist XML, which can be harder to rotate and audit.
  const envDir = resolveLaunchAgentEnvDir(params.env);
  const envFilePath = resolveLaunchAgentEnvFilePath(params.env, params.label);
  const wrapperPath = resolveLaunchAgentEnvWrapperPath(params.env, params.label);
  const generatedWrapper = buildLaunchAgentEnvironmentWrapper();
  await ensureSecureDirectory(envDir, LAUNCH_AGENT_PRIVATE_DIR_MODE);
  await fs.writeFile(envFilePath, buildLaunchAgentEnvironmentFile(entries), {
    encoding: "utf8",
    mode: LAUNCH_AGENT_ENV_FILE_MODE,
  });
  await fs.chmod(envFilePath, LAUNCH_AGENT_ENV_FILE_MODE).catch(() => undefined);
  const overwriteWarnings = await resolveLaunchAgentEnvironmentWrapperOverwriteWarnings({
    wrapperPath,
    generatedWrapper,
  });
  writeLaunchAgentOverwriteWarnings(params.stdout, params.warn, overwriteWarnings);
  await fs.writeFile(wrapperPath, generatedWrapper, {
    encoding: "utf8",
    mode: LAUNCH_AGENT_ENV_WRAPPER_MODE,
  });
  await fs.chmod(wrapperPath, LAUNCH_AGENT_ENV_WRAPPER_MODE).catch(() => undefined);

  if (
    isLaunchAgentEnvironmentWrapperArgs({
      programArguments: params.programArguments,
      envFilePath,
      wrapperPath,
    })
  ) {
    return { programArguments: params.programArguments };
  }

  return {
    programArguments: [
      LAUNCH_AGENT_ENV_WRAPPER_SHELL,
      wrapperPath,
      envFilePath,
      ...params.programArguments,
    ],
  };
}

export function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string {
  const label = resolveLaunchAgentLabel({ env });
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

function resolveLaunchAgentEnvironmentReadOptions(env: GatewayServiceEnv, label: string) {
  return {
    expectedEnvironmentWrapperPath: resolveLaunchAgentEnvWrapperPath(env, label),
    expectedEnvironmentFilePath: resolveLaunchAgentEnvFilePath(env, label),
    generatedEnvironmentLabel: label,
  };
}

export async function readLaunchAgentProgramArguments(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  return readLaunchAgentProgramArgumentsFromFile(
    plistPath,
    resolveLaunchAgentEnvironmentReadOptions(env, label),
  );
}

function buildLaunchAgentPlist({
  label = GATEWAY_LAUNCH_AGENT_LABEL,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label?: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  return buildLaunchAgentPlistImpl({
    label,
    comment,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? getWindowsCmdExePath() : "launchctl";
  const fileArgs = isWindows ? ["/d", "/s", "/c", "launchctl", ...args] : args;
  return await execFileUtf8(file, fileArgs, isWindows ? { windowsHide: true } : {});
}

export function parseLaunchctlListOpenClawUpdateJobs(
  output: string,
): StaleOpenClawUpdateLaunchdJob[] {
  return parseLaunchctlListOpenClawUpdateJobCandidates(output)
    .filter((job) => !job.requiresMetadata)
    .map(({ requiresMetadata: _requiresMetadata, ...job }) => job);
}

function parseLaunchctlListOpenClawUpdateJobCandidates(
  output: string,
): Array<StaleOpenClawUpdateLaunchdJob & OpenClawUpdateLaunchdLabelCandidate> {
  const jobs: Array<StaleOpenClawUpdateLaunchdJob & OpenClawUpdateLaunchdLabelCandidate> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const [pidRaw, statusRaw, ...labelParts] = parts;
    const candidate = normalizeOpenClawUpdateLaunchdLabelCandidate(labelParts.join(" "));
    if (!candidate) {
      continue;
    }
    const pid = pidRaw === "-" ? undefined : parseStrictPositiveInteger(pidRaw ?? "");
    const lastExitStatus = parseStrictInteger(statusRaw ?? "");
    jobs.push({
      label: candidate.label,
      requiresMetadata: candidate.requiresMetadata,
      ...(pid !== undefined ? { pid } : {}),
      ...(lastExitStatus !== undefined ? { lastExitStatus } : {}),
    });
  }
  return jobs.toSorted((a, b) => a.label.localeCompare(b.label));
}

function hasOpenClawUpdateLaunchdMarker(env: Record<string, string | undefined> | undefined) {
  return env?.OPENCLAW_UPDATE_RUN_HANDOFF?.trim() === "1";
}

function isOpenClawUpdateCommandPrefix(programArguments: string[], updateIndex: number): boolean {
  if (updateIndex === 1) {
    const cliName = path.basename(programArguments[0] ?? "").toLowerCase();
    return OPENCLAW_DIRECT_CLI_NAMES.has(cliName);
  }
  if (updateIndex !== 2) {
    return false;
  }
  const runtimeName = path.basename(programArguments[0] ?? "").toLowerCase();
  const entryName = path.basename(programArguments[1] ?? "").toLowerCase();
  return OPENCLAW_NODE_RUNTIME_NAMES.has(runtimeName) && OPENCLAW_SCRIPT_NAMES.has(entryName);
}

function isOpenClawUpdateProgramArguments(programArguments: string[] | undefined): boolean {
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    return false;
  }
  const updateIndex = programArguments.findIndex((arg) => arg.trim() === "update");
  if (updateIndex < 0 || !programArguments.slice(updateIndex + 1).includes("--yes")) {
    return false;
  }
  return (
    isOpenClawUpdateCommandPrefix(programArguments, updateIndex) &&
    !programArguments.some((arg) => arg.trim() === "gateway")
  );
}

async function isLaunchdJobConfirmedOpenClawUpdater(params: {
  label: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const plistPath = resolveLaunchAgentPlistPathForLabel(params.env, params.label);
  const command = await readLaunchAgentProgramArgumentsFromFile(plistPath);
  return (
    hasOpenClawUpdateLaunchdMarker(command?.environment) ||
    isOpenClawUpdateProgramArguments(command?.programArguments)
  );
}

export async function findStaleOpenClawUpdateLaunchdJobs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StaleOpenClawUpdateLaunchdJob[]> {
  if (process.platform !== "darwin") {
    return [];
  }
  const result = await execLaunchctl(["list"]);
  if (result.code !== 0) {
    return [];
  }
  // Never report the active gateway label as stale even when a wrapper exposes
  // update-like launchd metadata through the current environment.
  const jobs: StaleOpenClawUpdateLaunchdJob[] = [];
  for (const job of parseLaunchctlListOpenClawUpdateJobCandidates(result.stdout)) {
    if (isCurrentGatewayLaunchdLabel(job.label, env)) {
      continue;
    }
    if (
      job.requiresMetadata &&
      !(await isLaunchdJobConfirmedOpenClawUpdater({ label: job.label, env }))
    ) {
      continue;
    }
    jobs.push({
      label: job.label,
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      ...(job.lastExitStatus !== undefined ? { lastExitStatus: job.lastExitStatus } : {}),
    });
  }
  return jobs;
}

async function disableOpenClawUpdateLaunchdJobCandidate(params: {
  candidate: OpenClawUpdateLaunchdLabelCandidate;
  env: NodeJS.ProcessEnv;
  trustCurrentEnvMarker: boolean;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  if (
    params.candidate.requiresMetadata &&
    !(
      (params.trustCurrentEnvMarker && hasOpenClawUpdateLaunchdMarker(params.env)) ||
      (await isLaunchdJobConfirmedOpenClawUpdater({
        label: params.candidate.label,
        env: params.env,
      }))
    )
  ) {
    return false;
  }
  const serviceTarget = `${resolveGuiDomain()}/${assertValidLaunchAgentLabel(params.candidate.label)}`;
  const result = await execLaunchctl(["disable", serviceTarget]);
  return result.code === 0;
}

export async function disableOpenClawUpdateLaunchdJob(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const candidate = normalizeOpenClawUpdateLaunchdLabelCandidate(label);
  if (!candidate) {
    return false;
  }
  return await disableOpenClawUpdateLaunchdJobCandidate({
    candidate,
    env,
    trustCurrentEnvMarker: false,
  });
}

export async function disableCurrentOpenClawUpdateLaunchdJob(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const candidate = resolveCurrentOpenClawUpdateLaunchdJobLabel(env);
  if (!candidate) {
    return false;
  }
  return await disableOpenClawUpdateLaunchdJobCandidate({
    candidate,
    env,
    // Detached handoffs preserve the configured label, so only launchd-backed
    // current-process identity may turn the ambient marker into proof.
    trustCurrentEnvMarker: isCurrentProcessLaunchdServiceLabel(candidate.label, env, {
      allowConfiguredLabelFallback: false,
    }),
  });
}

function parseGatewayPortFromProgramArguments(
  programArguments: string[] | undefined,
): number | null {
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    return null;
  }
  for (let index = 0; index < programArguments.length; index += 1) {
    const current = programArguments[index]?.trim();
    if (!current) {
      continue;
    }
    if (current === "--port") {
      const next = parseTcpPort(programArguments[index + 1] ?? "");
      if (next !== null) {
        return next;
      }
      continue;
    }
    if (current.startsWith("--port=")) {
      const value = parseTcpPort(current.slice("--port=".length));
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

async function resolveLaunchAgentGatewayPort(env: GatewayServiceEnv): Promise<number | null> {
  const command = await readLaunchAgentProgramArguments(env).catch(() => null);
  const fromArgs = parseGatewayPortFromProgramArguments(command?.programArguments);
  if (fromArgs !== null) {
    return fromArgs;
  }
  const fromServiceEnv = parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT ?? "");
  if (fromServiceEnv !== null) {
    return fromServiceEnv;
  }
  return parseTcpPort(env.OPENCLAW_GATEWAY_PORT ?? "");
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

function throwBootstrapGuiSessionError(params: {
  detail: string;
  domain: string;
  actionHint: string;
}) {
  throw new Error(formatLaunchAgentGuiSessionError(params));
}

export function formatLaunchAgentGuiSessionError(params: {
  detail: string;
  domain: string;
  actionHint: string;
}): string {
  return [
    `launchctl bootstrap failed: ${params.detail}`,
    `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
    "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
    `Fix: sign in to the macOS desktop as the target user and rerun \`${params.actionHint}\`.`,
    "For headless VM setups, enable auto-login for the target user so macOS creates the GUI session after boot.",
    "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
  ].join("\n");
}

function writeLaunchAgentActionLine(
  stdout: NodeJS.WritableStream,
  label: string,
  value: string,
): void {
  try {
    stdout.write(`${formatLine(label, value)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
}

async function bootstrapLaunchAgentOrThrow(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  actionHint: string;
}) {
  // `disable` state survives bootout and plist rewrites; explicit start/repair
  // paths must clear it before asking launchd to load the job again.
  await execLaunchctl(["enable", params.serviceTarget]);
  const boot = await execLaunchctl(["bootstrap", params.domain, params.plistPath]);
  if (boot.code === 0) {
    return;
  }
  const detail = (boot.stderr || boot.stdout).trim();
  if (isUnsupportedGuiDomain(detail)) {
    throwBootstrapGuiSessionError({
      detail,
      domain: params.domain,
      actionHint: params.actionHint,
    });
  }
  if (isLaunchctlOperationAlreadyInProgress(detail)) {
    const state = await probeLaunchAgentState(params.serviceTarget);
    if (state.state === "running" || state.state === "stopped") {
      return;
    }
  }
  throw new Error(`launchctl bootstrap failed: ${detail}`);
}

async function ensureLaunchAgentPlistReadable(plistPath: string): Promise<void> {
  await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => undefined);
}

async function ensureSecureDirectory(
  targetPath: string,
  dirMode = LAUNCH_AGENT_DIR_MODE,
): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true, mode: dirMode });
  try {
    const stat = await fs.stat(targetPath);
    const mode = stat.mode & 0o777;
    const forbiddenMode = dirMode === LAUNCH_AGENT_PRIVATE_DIR_MODE ? 0o077 : 0o022;
    const tightenedMode = mode & ~forbiddenMode;
    if (tightenedMode !== mode) {
      await fs.chmod(targetPath, tightenedMode);
    }
  } catch {
    // Best effort: keep install working even if chmod/stat is unavailable.
  }
}

async function ensureLaunchAgentEnvironmentDirectories(
  environment: Record<string, string | undefined> | undefined,
): Promise<void> {
  const tmpDir = environment?.TMPDIR?.trim();
  if (tmpDir) {
    await ensureSecureDirectory(tmpDir, LAUNCH_AGENT_PRIVATE_DIR_MODE);
  }
}

type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

export function parseLaunchctlPrint(output: string): LaunchctlPrintInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: LaunchctlPrintInfo = {};
  const state = entries.state;
  if (state) {
    info.state = state;
  }
  const pidValue = entries.pid;
  if (pidValue) {
    const pid = parseStrictPositiveInteger(pidValue);
    if (pid !== undefined) {
      info.pid = pid;
    }
  }
  const exitStatusValue = entries["last exit status"];
  if (exitStatusValue) {
    const status = parseStrictInteger(exitStatusValue);
    if (status !== undefined) {
      info.lastExitStatus = status;
    }
  }
  const exitReason = entries["last exit reason"];
  if (exitReason) {
    info.lastExitReason = exitReason;
  }
  return info;
}

export async function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  return res.code === 0;
}

export async function launchAgentPlistExists(env: GatewayServiceEnv): Promise<boolean> {
  try {
    const plistPath = resolveLaunchAgentPlistPath(env);
    await fs.access(plistPath);
    return true;
  } catch {
    return false;
  }
}

export async function readLaunchAgentRuntime(
  env: Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  if (res.code !== 0) {
    const plistExists = await launchAgentPlistExists(env);
    const detail = (res.stderr || res.stdout).trim() || undefined;
    const missingGuiSession = plistExists && isUnsupportedGuiDomain(detail ?? "");
    return {
      status: "unknown",
      detail,
      ...(plistExists
        ? { missingSupervision: true, ...(missingGuiSession ? { missingGuiSession } : {}) }
        : { missingUnit: true }),
    };
  }
  const parsed = parseLaunchctlPrint(res.stdout || res.stderr || "");
  const plistExists = await launchAgentPlistExists(env);
  const state = normalizeLowercaseStringOrEmpty(parsed.state);
  const status = state === "running" || parsed.pid ? "running" : state ? "stopped" : "unknown";
  return {
    status,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

type LaunchAgentBootstrapRepairResult =
  | { ok: true; status: "repaired" | "already-loaded" }
  | {
      ok: false;
      status: "bootstrap-failed" | "kickstart-failed";
      detail?: string;
    }
  | { ok: false; status: "gui-session-unavailable"; detail: string; domain: string };

function isLaunchctlAlreadyLoaded(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return res.code === 130 || detail.includes("already exists in domain");
}

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}): Promise<LaunchAgentBootstrapRepairResult> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  const serviceTarget = `${domain}/${label}`;
  // Rewrite first so legacy inline environment secrets move into the private
  // env file before the plist becomes world-readable for launchd.
  const warn =
    args.warn ?? ((message: string) => process.stderr.write(`${formatLine("Warning", message)}\n`));
  await rewriteLaunchAgentPlistForRestart({ env, label, plistPath, warn });
  await execLaunchctl(["enable", serviceTarget]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  let repairStatus: "repaired" | "already-loaded" = "repaired";
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      return {
        ok: false,
        status: "gui-session-unavailable",
        detail,
        domain,
      };
    }
    if (!isLaunchctlAlreadyLoaded(boot)) {
      return { ok: false, status: "bootstrap-failed", detail: detail || undefined };
    }
    repairStatus = "already-loaded";
  }
  if (repairStatus === "repaired") {
    return { ok: true, status: repairStatus };
  }

  // Service is already bootstrapped. Only kickstart if it is not actively running —
  // kickstarting a healthy running service causes unnecessary session disconnects.
  const runtime = await readLaunchAgentRuntime(env);
  if (runtime.status === "running") {
    return { ok: true, status: repairStatus };
  }

  const kick = await execLaunchctl(["kickstart", serviceTarget]);
  if (kick.code !== 0) {
    return {
      ok: false,
      status: "kickstart-failed",
      detail: (kick.stderr || kick.stdout).trim() || undefined,
    };
  }
  return { ok: true, status: repairStatus };
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = toPosixPath(resolveHomeDir(env));
  const trashDir = path.posix.join(home, ".Trash");
  const dest = path.join(trashDir, `${label}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`${formatLine("Moved LaunchAgent to Trash", dest)}\n`);
  } catch {
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move)\n`);
  }
}

function isLaunchctlNotLoaded(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return (
    detail.includes("no such process") ||
    detail.includes("could not find service") ||
    detail.includes("not found")
  );
}

function isUnsupportedGuiDomain(detail: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("domain does not support specified action") ||
    normalized.includes("could not find domain for user gui") ||
    normalized.includes("bootstrap failed: 125")
  );
}

function isLaunchctlOperationAlreadyInProgress(detail: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("operation already in progress") ||
    normalized.includes("bootstrap failed: 37")
  );
}

function formatLaunchctlResultDetail(res: {
  stdout: string;
  stderr: string;
  code: number;
}): string {
  const sanitized = sanitizeForLog((res.stderr || res.stdout).replace(/[\r\n\t]+/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(sanitized, 1000);
}

async function bootoutLaunchAgentOrThrow(params: {
  serviceTarget: string;
  warning: string;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const bootout = await execLaunchctl(["bootout", params.serviceTarget]);
  if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
    throw new Error(
      `${params.warning}; launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`,
    );
  }
  params.stdout.write(`${formatLine("Warning", params.warning)}\n`);
}

type LaunchAgentProbeResult =
  | { state: "running" }
  | { state: "stopped" }
  | { state: "not-loaded" }
  | { state: "unknown"; detail?: string };

async function probeLaunchAgentState(serviceTarget: string): Promise<LaunchAgentProbeResult> {
  // `launchctl print` output is not a stable API, so this is only a stop
  // confirmation probe. Unknown output falls back to bootout instead of success.
  const probe = await execLaunchctl(["print", serviceTarget]);
  if (probe.code !== 0) {
    if (isLaunchctlNotLoaded(probe)) {
      return { state: "not-loaded" };
    }
    return {
      state: "unknown",
      detail: formatLaunchctlResultDetail(probe) || undefined,
    };
  }
  const runtime = parseLaunchctlPrint(probe.stdout || probe.stderr || "");
  if (
    normalizeLowercaseStringOrEmpty(runtime.state) === "running" ||
    (typeof runtime.pid === "number" && runtime.pid > 1)
  ) {
    return { state: "running" };
  }
  return { state: "stopped" };
}

async function waitForLaunchAgentStopped(serviceTarget: string): Promise<LaunchAgentProbeResult> {
  let lastUnknown: LaunchAgentProbeResult | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = await probeLaunchAgentState(serviceTarget);
    if (probe.state === "stopped" || probe.state === "not-loaded") {
      return probe;
    }
    if (probe.state === "unknown") {
      lastUnknown = probe;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return lastUnknown ?? { state: "running" };
}

async function waitForGatewayPortRelease(port: number): Promise<boolean> {
  const deadline = Date.now() + LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS, deadline - Date.now()));
    const status = await probePortUsage(port);
    if (status === "free") {
      return true;
    }
  }
  return false;
}

async function assertGatewayPortReleasedAfterStop(env: GatewayServiceEnv): Promise<void> {
  const port = await resolveLaunchAgentGatewayPort(env);
  if (port === null) {
    return;
  }
  cleanStaleGatewayProcessesSync(port);
  const diagnostics = await inspectPortUsage(port).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return;
  }
  if (await waitForGatewayPortRelease(port)) {
    return;
  }
  throw new Error(
    [
      `gateway port ${port} is still busy after LaunchAgent stop`,
      ...formatPortDiagnostics(diagnostics),
    ].join("\n"),
  );
}

export async function stopLaunchAgent({
  stdout,
  env,
  disable: persistDisable,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: serviceEnv });
  const serviceTarget = `${domain}/${label}`;

  if (
    isCurrentProcessLaunchdServiceLabel(label, process.env, { allowConfiguredLabelFallback: false })
  ) {
    throw new Error(
      `Refusing to stop LaunchAgent ${label} from inside the same launchd service; run this command from an external shell.`,
    );
  }

  if (!persistDisable) {
    // Default: bootout only. Removes the job from the current launchd domain without
    // persisting a disable, so KeepAlive auto-recovery survives future crashes and
    // `openclaw gateway start` re-enables cleanly without a manual `launchctl enable`.
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent", serviceTarget)}\n`);
    return;
  }

  // --disable: persistently suppress KeepAlive/RunAtLoad before stopping.
  // Without this, launchd can relaunch the process as soon as `stop` exits.
  const disableResult = await execLaunchctl(["disable", serviceTarget]);
  if (disableResult.code !== 0) {
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning: `launchctl disable failed; used bootout fallback and left service unloaded: ${formatLaunchctlResultDetail(disableResult)}`,
    });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }

  // `launchctl stop` targets the plain label (not the fully-qualified service target).
  const stop = await execLaunchctl(["stop", label]);
  if (stop.code !== 0 && !isLaunchctlNotLoaded(stop)) {
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning: `launchctl stop failed; used bootout fallback and left service unloaded: ${formatLaunchctlResultDetail(stop)}`,
    });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }

  const stopState = await waitForLaunchAgentStopped(serviceTarget);
  if (stopState.state !== "stopped" && stopState.state !== "not-loaded") {
    const warning =
      stopState.state === "unknown"
        ? `launchctl print could not confirm stop; used bootout fallback and left service unloaded: ${stopState.detail ?? "unknown error"}`
        : "launchctl stop did not fully stop the service; used bootout fallback and left service unloaded";
    await bootoutLaunchAgentOrThrow({ serviceTarget, stdout, warning });
    await assertGatewayPortReleasedAfterStop(serviceEnv);
    stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", serviceTarget)}\n`);
    return;
  }

  await assertGatewayPortReleasedAfterStop(serviceEnv);
  stdout.write(`${formatLine("Stopped LaunchAgent", serviceTarget)}\n`);
}

async function writeLaunchAgentPlist({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
  stdout,
  warn,
}: GatewayServiceInstallArgs): Promise<{ plistPath: string; stdoutPath: string }> {
  const { logDir, stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  await ensureSecureDirectory(logDir);

  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    await execLaunchctl(["bootout", domain, legacyPlistPath]);
    await execLaunchctl(["unload", legacyPlistPath]);
    try {
      await fs.unlink(legacyPlistPath);
    } catch {
      // ignore
    }
  }

  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
  const home = toPosixPath(resolveHomeDir(env));
  const libraryDir = path.posix.join(home, "Library");
  await ensureSecureDirectory(home);
  await ensureSecureDirectory(libraryDir);
  await ensureSecureDirectory(path.dirname(plistPath));
  await ensureLaunchAgentEnvironmentDirectories(environment);
  const prepared = await prepareLaunchAgentProgramArguments({
    env,
    label,
    programArguments,
    environment,
    stdout,
    warn,
  });

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments: prepared.programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath: LAUNCH_AGENT_STDERR_PATH,
    environment: prepared.inlineEnvironment,
  });
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: LAUNCH_AGENT_PLIST_MODE });
  await ensureLaunchAgentPlistReadable(plistPath);
  return { plistPath, stdoutPath };
}

export async function stageLaunchAgent({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist({ ...args, stdout });
  writeFormattedLines(
    stdout,
    [
      { label: "Staged LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}

async function activateLaunchAgent(params: { env: GatewayServiceEnv; plistPath: string }) {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: params.env });

  await execLaunchctl(["bootout", domain, params.plistPath]);
  await execLaunchctl(["unload", params.plistPath]);
  // launchd can persist "disabled" state even after bootout + plist removal; clear it before bootstrap.
  await bootstrapLaunchAgentOrThrow({
    domain,
    serviceTarget: `${domain}/${label}`,
    plistPath: params.plistPath,
    actionHint: "openclaw gateway install --force",
  });
}

export async function installLaunchAgent(
  args: GatewayServiceInstallArgs,
): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist(args);
  await activateLaunchAgent({ env: args.env, plistPath });
  // `bootstrap` already loads RunAtLoad agents. Avoid `kickstart -k` here:
  // on slow macOS guests it SIGTERMs the freshly booted gateway and pushes the
  // real listener startup past setup's health deadline.
  writeFormattedLines(
    args.stdout,
    [
      { label: "Installed LaunchAgent", value: plistPath },
      { label: "Logs", value: stdoutPath },
    ],
    { leadingBlankLine: true },
  );
  return { plistPath };
}

async function rewriteLaunchAgentPlistForRestart({
  env,
  label,
  plistPath,
  stdout,
  warn,
}: {
  env: GatewayServiceEnv;
  label: string;
  plistPath: string;
  stdout?: NodeJS.WritableStream;
  warn?: (message: string) => void;
}): Promise<boolean> {
  const existing = await readLaunchAgentProgramArgumentsFromFile(
    plistPath,
    resolveLaunchAgentEnvironmentReadOptions(env, label),
  );
  if (!existing?.programArguments.length) {
    return false;
  }

  const { logDir, stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  await ensureSecureDirectory(logDir);

  const serviceDescription = resolveGatewayServiceDescription({
    env,
    environment: existing.environment,
  });
  const prepared = await prepareLaunchAgentProgramArguments({
    env,
    label,
    programArguments: existing.programArguments,
    environment: existing.environment,
    stdout,
    warn,
  });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments: prepared.programArguments,
    workingDirectory: existing.workingDirectory,
    stdoutPath,
    stderrPath: LAUNCH_AGENT_STDERR_PATH,
    environment: prepared.inlineEnvironment,
  });
  const previousPlist = await fs.readFile(plistPath, "utf8").catch(() => "");
  if (previousPlist === plist) {
    await ensureLaunchAgentPlistReadable(plistPath);
    return false;
  }
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: LAUNCH_AGENT_PLIST_MODE });
  await ensureLaunchAgentPlistReadable(plistPath);
  return true;
}

async function ensureLaunchAgentLoadedAfterFailure(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
}): Promise<void> {
  const probe = await execLaunchctl(["print", params.serviceTarget]);
  if (probe.code === 0) {
    return;
  }
  try {
    await bootstrapLaunchAgentOrThrow({
      domain: params.domain,
      serviceTarget: params.serviceTarget,
      plistPath: params.plistPath,
      actionHint: "openclaw gateway start",
    });
  } catch {
    // Best-effort only. Preserve the original kickstart failure below.
  }
}

export async function restartLaunchAgent({
  stdout,
  env,
  warn,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: serviceEnv });
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
  const serviceTarget = `${domain}/${label}`;

  // Restart requests issued from inside the managed gateway process tree need a
  // detached handoff. A direct `kickstart -k` would terminate the caller before
  // it can finish the restart command.
  if (isCurrentProcessLaunchdServiceLabel(label)) {
    const plistReloadNeeded = await rewriteLaunchAgentPlistForRestart({
      env: serviceEnv,
      label,
      plistPath,
      stdout,
      warn,
    });
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      env: serviceEnv,
      mode: plistReloadNeeded ? "reload" : "kickstart",
      waitForPid: process.pid,
    });
    if (!handoff.ok) {
      throw new Error(`launchd restart handoff failed: ${handoff.error}`);
    }
    writeLaunchAgentActionLine(stdout, "Scheduled LaunchAgent restart", serviceTarget);
    return { outcome: "scheduled" };
  }

  const cleanupPort = await resolveLaunchAgentGatewayPort(serviceEnv);
  if (cleanupPort !== null) {
    cleanStaleGatewayProcessesSync(cleanupPort);
    const diagnostics = await inspectPortUsage(cleanupPort).catch(() => null);
    if (diagnostics?.status === "busy") {
      throw new Error(
        [
          `gateway port ${cleanupPort} is still busy before LaunchAgent restart`,
          ...formatPortDiagnostics(diagnostics),
        ].join("\n"),
      );
    }
  }
  const plistReloadNeeded = await rewriteLaunchAgentPlistForRestart({
    env: serviceEnv,
    label,
    plistPath,
    stdout,
    warn,
  });

  // `openclaw gateway restart` is an explicit operator request to bring the
  // LaunchAgent back, so clear any persisted disabled state before restart.
  await execLaunchctl(["enable", serviceTarget]);

  if (plistReloadNeeded) {
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
    }
    await bootstrapLaunchAgentOrThrow({
      domain,
      serviceTarget,
      plistPath,
      actionHint: "openclaw gateway restart",
    });
    writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
    return { outcome: "completed" };
  }

  const start = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (start.code === 0) {
    writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
    return { outcome: "completed" };
  }

  if (!isLaunchctlNotLoaded(start)) {
    await ensureLaunchAgentLoadedAfterFailure({ domain, serviceTarget, plistPath });
    throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
  }

  // If the service was previously booted out, re-register the rewritten plist and retry.
  await bootstrapLaunchAgentOrThrow({
    domain,
    serviceTarget,
    plistPath,
    actionHint: "openclaw gateway restart",
  });
  writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
  return { outcome: "completed" };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
