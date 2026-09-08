/** launchctl state parsing, inspection, and bootstrap primitives. */
import fs from "node:fs/promises";
import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { sleep } from "../utils.js";
import { GATEWAY_SERVICE_KIND } from "./constants.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
  type LaunchctlResult,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvironmentReadOptions,
} from "./launchd-service-files.js";
import {
  formatSystemLaunchDaemonOwnershipSummary,
  inspectSystemLaunchDaemonOwnership,
} from "./launchd-system.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
} from "./service-types.js";

export async function readLaunchAgentProgramArguments(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const label = resolveLaunchAgentLabel(env);
  const command = await readLaunchAgentProgramArgumentsFromFile(resolveLaunchAgentPlistPath(env), {
    ...resolveLaunchAgentEnvironmentReadOptions(env, label),
    ...options,
  });
  if (!command && options?.requireEffective) {
    // A removed plist can leave its job registered; only launchd can prove absence.
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 5_000) : 5_000;
    const probe = await probeLaunchAgentState(
      `${resolveLaunchAgentGuiDomain()}/${label}`,
      timeoutMs,
    ).catch(() => null);
    if (probe?.state !== "not-loaded") {
      throw new Error("Effective LaunchAgent service command could not be inspected.");
    }
  }
  return command;
}

// launchd reserves the label until the outgoing job actually exits, and it
// SIGKILLs that job once ExitTimeOut elapses. Bound the bootstrap retry by that
// same deadline plus slack so a drain-on-SIGTERM gateway cannot outlast it.
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_TIMEOUT_MS = (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000;
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_POLL_MS = 500;
export async function resolveLaunchAgentGatewayContext(env: GatewayServiceEnv): Promise<{
  port: number | null;
  probeHosts: readonly string[];
}> {
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  if (serviceKind && serviceKind !== GATEWAY_SERVICE_KIND) {
    return { port: null, probeHosts: [] };
  }
  const command = await readLaunchAgentProgramArguments(env).catch(() => null);
  return {
    port:
      parseTcpPortFromArgs(command?.programArguments) ??
      parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT ?? "") ??
      parseTcpPort(env.OPENCLAW_GATEWAY_PORT ?? ""),
    probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
  };
}

export function resolveLaunchAgentGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
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

export async function bootstrapLaunchAgentOrThrow(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  actionHint: string;
  onMutation?: (mode: "enable" | "bootstrap") => void;
  skipEnable?: boolean;
  // Opt-in for callers that just issued `bootout` on this label. Only those can
  // race a pending teardown, so start/install/recovery paths keep failing fast
  // on an unrelated EIO instead of waiting out the teardown deadline.
  retryPendingTeardown?: boolean;
}) {
  // `disable` state survives bootout and plist rewrites; explicit start/repair
  // paths must clear it before asking launchd to load the job again.
  if (!params.skipEnable) {
    const enable = await execLaunchctl(["enable", params.serviceTarget]);
    if (enable.code === 0) {
      params.onMutation?.("enable");
    }
  }
  const teardownDeadline = Date.now() + LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_TIMEOUT_MS;
  for (;;) {
    const boot = await execLaunchctl(["bootstrap", params.domain, params.plistPath]);
    if (boot.code === 0) {
      params.onMutation?.("bootstrap");
      return;
    }
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error(
        formatLaunchAgentGuiSessionError({
          detail,
          domain: params.domain,
          actionHint: params.actionHint,
        }),
      );
    }
    if (boot.termination === "exit" && isLaunchctlOperationAlreadyInProgress(detail)) {
      const state = await probeLaunchAgentState(params.serviceTarget);
      if (state.state === "running" || state.state === "stopped") {
        params.onMutation?.("bootstrap");
        return;
      }
    }
    const remainingMs = teardownDeadline - Date.now();
    if (
      !params.retryPendingTeardown ||
      !isLaunchctlBootstrapPendingTeardown(boot) ||
      remainingMs <= 0
    ) {
      throw new Error(`launchctl bootstrap failed: ${detail}`);
    }
    await sleep(Math.min(LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_POLL_MS, remainingMs));
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

export function parseLaunchAgentEnabled(output: string, label: string): boolean {
  const labelPrefix = `"${label}"`;
  for (const line of output.split("\n")) {
    const entry = line.trim();
    if (!entry.startsWith(labelPrefix)) {
      continue;
    }
    const state = entry.slice(labelPrefix.length).trim();
    if (state === "=> enabled" || state === "=> false") {
      return true;
    }
    if (state === "=> disabled" || state === "=> true") {
      return false;
    }
    throw new Error(`launchctl print-disabled returned an unrecognized state for ${label}`);
  }
  // No persisted override means launchd uses the plist's normal enabled state.
  return true;
}

export async function isLaunchAgentEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(args.env);
  const res = await execLaunchctl(["print-disabled", domain], args.timeoutMs);
  if (res.code !== 0) {
    throw new Error(`launchctl print-disabled failed: ${formatLaunchctlResultDetail(res)}`);
  }
  return parseLaunchAgentEnabled(res.stdout || res.stderr || "", label);
}

export async function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(args.env);
  const probe = await probeLaunchAgentState(`${domain}/${label}`, args.timeoutMs);
  if (probe.state === "running" || probe.state === "stopped") {
    return true;
  }
  if (probe.state === "not-loaded") {
    return false;
  }
  throw new Error(`launchctl print failed: ${probe.detail ?? "unknown error"}`);
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
  opts?: Pick<GatewayServiceEnvArgs, "timeoutMs">,
): Promise<GatewayServiceRuntime> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const [probe, systemOwnership] = await Promise.all([
    probeLaunchAgentState(`${domain}/${label}`, opts?.timeoutMs),
    inspectSystemLaunchDaemonOwnership(label, { ...opts, scanInstalledPlists: false }),
  ]);
  if (systemOwnership.status !== "absent") {
    return {
      status: "unknown",
      detail: formatSystemLaunchDaemonOwnershipSummary(systemOwnership),
      systemLaunchDaemon: {
        status: systemOwnership.status,
        serviceTarget: systemOwnership.serviceTarget,
        ...(systemOwnership.status === "installed" ? { plistPath: systemOwnership.plistPath } : {}),
      },
    };
  }
  if (probe.state === "not-loaded") {
    const plistExists = await launchAgentPlistExists(env);
    return plistExists ? { status: "stopped" } : { status: "unknown", missingUnit: true };
  }
  if (probe.state === "unknown") {
    const plistExists = await launchAgentPlistExists(env);
    const missingGuiSession = plistExists && isUnsupportedGuiDomain(probe.detail ?? "");
    return {
      status: "unknown",
      detail: probe.detail,
      ...(plistExists
        ? missingGuiSession
          ? { missingGuiSession: true }
          : {}
        : { missingUnit: true }),
    };
  }
  const parsed = probe.runtime;
  const plistExists = await launchAgentPlistExists(env);
  return {
    status: probe.state,
    state: parsed.state,
    pid: parsed.pid,
    lastExitStatus: parsed.lastExitStatus,
    lastExitReason: parsed.lastExitReason,
    cachedLabel: !plistExists,
  };
}

export function isLaunchctlAlreadyLoaded(res: LaunchctlResult): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return (
    res.termination === "exit" && (res.code === 130 || detail.includes("already exists in domain"))
  );
}

export function isUnsupportedGuiDomain(detail: string): boolean {
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

function isLaunchctlBootstrapPendingTeardown(res: LaunchctlResult): boolean {
  // `bootout` returns once launchd accepts the request, not once the job is gone,
  // so bootstrapping the same label mid-teardown answers EIO. The plist is valid
  // here, so this is a timing conflict to retry rather than a real I/O fault.
  //
  // launchd answers the same EIO for a label that is simply still registered
  // ("already exists in domain"). That job is not tearing down, so waiting for a
  // teardown that never comes only delays the failure.
  if (res.termination !== "exit" || isLaunchctlAlreadyLoaded(res)) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return normalized.includes("bootstrap failed: 5") || normalized.includes("input/output error");
}
type LaunchAgentProbeResult =
  | { state: "running"; runtime: LaunchctlPrintInfo }
  | { state: "stopped"; runtime: LaunchctlPrintInfo }
  | { state: "not-loaded" }
  | { state: "unknown"; detail?: string };

export async function probeLaunchAgentState(
  serviceTarget: string,
  timeoutMs?: number,
): Promise<LaunchAgentProbeResult> {
  // `launchctl print` output is not a stable API. Keep expected absence and
  // unexpected failures distinct so every caller applies one classification.
  const probe = await execLaunchctl(["print", serviceTarget], timeoutMs);
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
    return { state: "running", runtime };
  }
  return { state: "stopped", runtime };
}

export async function waitForLaunchAgentStopped(
  serviceTarget: string,
): Promise<LaunchAgentProbeResult> {
  let lastProbe: LaunchAgentProbeResult = { state: "unknown" };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = await probeLaunchAgentState(serviceTarget);
    lastProbe = probe;
    if (probe.state === "stopped" || probe.state === "not-loaded") {
      return probe;
    }
    await sleep(100);
  }
  return lastProbe;
}
