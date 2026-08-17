/** Discovery and shutdown of stale OpenClaw launchd updater jobs. */
import path from "node:path";
import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
} from "./constants.js";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";
import { execLaunchctl } from "./launchd-exec.js";
import { assertValidLaunchAgentLabel } from "./launchd-label.js";
import { readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { resolveLaunchAgentPlistPathForLabel } from "./launchd-service-files.js";

const OPENCLAW_UPDATE_LAUNCHD_LABEL_PREFIX = "ai.openclaw.update.";
const OPENCLAW_MANUAL_UPDATE_LAUNCHD_LABEL_PATTERN = /^ai\.openclaw\.manual-update\.\d+$/;
const OPENCLAW_PROFILE_UPDATE_LAUNCHD_LABEL_PATTERN =
  /^ai\.openclaw\.[A-Za-z0-9._-]+\.update\.[A-Za-z0-9._-]+$/;
const OPENCLAW_DIRECT_CLI_NAMES = new Set(["openclaw", "openclaw.mjs"]);
const OPENCLAW_NODE_RUNTIME_NAMES = new Set(["bun", "bun.exe", "node", "node.exe"]);
const OPENCLAW_SCRIPT_NAMES = new Set(["openclaw.mjs"]);
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
  const serviceTarget = `${resolveLaunchAgentGuiDomain()}/${assertValidLaunchAgentLabel(params.candidate.label)}`;
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
