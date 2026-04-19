import fs from "node:fs/promises";
import path from "node:path";
import { parseStrictInteger, parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  resolveGatewayServiceDescription,
  resolveGatewayLaunchAgentLabel,
  resolveLegacyGatewayLaunchAgentLabels,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildLaunchAgentPlist as buildLaunchAgentPlistImpl,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import {
  isCurrentProcessLaunchdServiceLabel,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
import { resolveGatewayLogPaths } from "./restart-logs.js";
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
const LAUNCH_AGENT_PLIST_MODE = 0o644;

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

export function resolveLaunchAgentPlistPath(env: GatewayServiceEnv): string {
  const label = resolveLaunchAgentLabel({ env });
  return resolveLaunchAgentPlistPathForLabel(env, label);
}

export async function readLaunchAgentProgramArguments(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  return readLaunchAgentProgramArgumentsFromFile(plistPath);
}

export function buildLaunchAgentPlist({
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
  const file = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "launchctl";
  const fileArgs = isWindows ? ["/d", "/s", "/c", "launchctl", ...args] : args;
  return await execFileUtf8(file, fileArgs, isWindows ? { windowsHide: true } : {});
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
      const next = parseStrictPositiveInteger(programArguments[index + 1] ?? "");
      if (next !== undefined) {
        return next;
      }
      continue;
    }
    if (current.startsWith("--port=")) {
      const value = parseStrictPositiveInteger(current.slice("--port=".length));
      if (value !== undefined) {
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
  const fromEnv = parseStrictPositiveInteger(env.OPENCLAW_GATEWAY_PORT ?? "");
  return fromEnv ?? null;
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
  throw new Error(
    [
      `launchctl bootstrap failed: ${params.detail}`,
      `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
      "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
      `Fix: sign in to the macOS desktop as the target user and rerun \`${params.actionHint}\`.`,
      "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
    ].join("\n"),
  );
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
  throw new Error(`launchctl bootstrap failed: ${detail}`);
}

async function ensureSecureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true, mode: LAUNCH_AGENT_DIR_MODE });
  try {
    const stat = await fs.stat(targetPath);
    const mode = stat.mode & 0o777;
    const tightenedMode = mode & ~0o022;
    if (tightenedMode !== mode) {
      await fs.chmod(targetPath, tightenedMode);
    }
  } catch {
    // Best effort: keep install working even if chmod/stat is unavailable.
  }
}

export type LaunchctlPrintInfo = {
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

export async function isLaunchAgentListed(args: GatewayServiceEnvArgs): Promise<boolean> {
  const label = resolveLaunchAgentLabel({ env: args.env });
  const res = await execLaunchctl(["list"]);
  if (res.code !== 0) {
    return false;
  }
  return res.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === label);
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
    return {
      status: "unknown",
      detail: (res.stderr || res.stdout).trim() || undefined,
      missingUnit: true,
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

export type LaunchAgentBootstrapRepairResult =
  | { ok: true; status: "repaired" | "already-loaded" }
  | { ok: false; status: "bootstrap-failed" | "kickstart-failed"; detail?: string };

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
}): Promise<LaunchAgentBootstrapRepairResult> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });
  const plistPath = resolveLaunchAgentPlistPath(env);
  await execLaunchctl(["enable", `${domain}/${label}`]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  let repairStatus: LaunchAgentBootstrapRepairResult["status"] = "repaired";
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    const normalized = normalizeLowercaseStringOrEmpty(detail);
    const alreadyLoaded = boot.code === 130 || normalized.includes("already exists in domain");
    if (!alreadyLoaded) {
      return { ok: false, status: "bootstrap-failed", detail: detail || undefined };
    }
    repairStatus = "already-loaded";
  }
  const kick = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
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
    normalized.includes("bootstrap failed: 125")
  );
}

function formatLaunchctlResultDetail(res: {
  stdout: string;
  stderr: string;
  code: number;
}): string {
  return sanitizeForLog((res.stderr || res.stdout).replace(/[\r\n\t]+/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
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
  params.stdout.write(`${formatLine("Stopped LaunchAgent (degraded)", params.serviceTarget)}\n`);
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

export async function stopLaunchAgent({ stdout, env }: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env: serviceEnv });
  const serviceTarget = `${domain}/${label}`;

  // Keep the LaunchAgent installed, but persistently suppress KeepAlive/RunAtLoad
  // before stopping the current process. Without `disable`, launchd can relaunch
  // the process as soon as `stop` exits.
  const disable = await execLaunchctl(["disable", serviceTarget]);
  if (disable.code !== 0) {
    await bootoutLaunchAgentOrThrow({
      serviceTarget,
      stdout,
      warning: `launchctl disable failed; used bootout fallback and left service unloaded: ${formatLaunchctlResultDetail(disable)}`,
    });
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
    return;
  }

  const stopState = await waitForLaunchAgentStopped(serviceTarget);
  if (stopState.state !== "stopped" && stopState.state !== "not-loaded") {
    const warning =
      stopState.state === "unknown"
        ? `launchctl print could not confirm stop; used bootout fallback and left service unloaded: ${stopState.detail ?? "unknown error"}`
        : "launchctl stop did not fully stop the service; used bootout fallback and left service unloaded";
    await bootoutLaunchAgentOrThrow({ serviceTarget, stdout, warning });
    return;
  }

  stdout.write(`${formatLine("Stopped LaunchAgent", serviceTarget)}\n`);
}

async function writeLaunchAgentPlist({
  env,
  programArguments,
  workingDirectory,
  environment,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{ plistPath: string; stdoutPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
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

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: LAUNCH_AGENT_PLIST_MODE });
  await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => undefined);
  return { plistPath, stdoutPath };
}

export async function stageLaunchAgent({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { plistPath, stdoutPath } = await writeLaunchAgentPlist(args);
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
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      env: serviceEnv,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    if (!handoff.ok) {
      throw new Error(`launchd restart handoff failed: ${handoff.detail ?? "unknown error"}`);
    }
    writeLaunchAgentActionLine(stdout, "Scheduled LaunchAgent restart", serviceTarget);
    return { outcome: "scheduled" };
  }

  const cleanupPort = await resolveLaunchAgentGatewayPort(serviceEnv);
  if (cleanupPort !== null) {
    cleanStaleGatewayProcessesSync(cleanupPort);
  }

  // `openclaw gateway restart` is an explicit operator request to bring the
  // LaunchAgent back, so clear any persisted disabled state before restart.
  await execLaunchctl(["enable", serviceTarget]);

  const start = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (start.code === 0) {
    writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
    return { outcome: "completed" };
  }

  if (!isLaunchctlNotLoaded(start)) {
    await ensureLaunchAgentLoadedAfterFailure({ domain, serviceTarget, plistPath });
    throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
  }

  // If the service was previously booted out, re-register the plist and retry.
  await bootstrapLaunchAgentOrThrow({
    domain,
    serviceTarget,
    plistPath,
    actionHint: "openclaw gateway restart",
  });

  const retry = await execLaunchctl(["kickstart", "-k", serviceTarget]);
  if (retry.code !== 0) {
    await ensureLaunchAgentLoadedAfterFailure({ domain, serviceTarget, plistPath });
    throw new Error(`launchctl kickstart failed: ${retry.stderr || retry.stdout}`.trim());
  }
  writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
  return { outcome: "completed" };
}
