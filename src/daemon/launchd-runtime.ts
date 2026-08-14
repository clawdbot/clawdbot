/** launchctl state parsing, inspection, and bootstrap primitives. */
import fs from "node:fs/promises";
import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { sleep } from "../utils.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import {
  resolveLaunchAgentPlistPath,
  readLaunchAgentProgramArguments,
} from "./launchd-service-files.js";
import {
  formatSystemLaunchDaemonOwnershipSummary,
  inspectSystemLaunchDaemonOwnership,
} from "./launchd-system.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv, GatewayServiceEnvArgs } from "./service-types.js";

// launchd reserves the label until the outgoing job actually exits, and it
// SIGKILLs that job once ExitTimeOut elapses. Bound the bootstrap retry by that
// same deadline plus slack so a drain-on-SIGTERM gateway cannot outlast it.
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_TIMEOUT_MS = (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000;
const LAUNCH_AGENT_BOOTSTRAP_TEARDOWN_POLL_MS = 500;
export async function resolveLaunchAgentGatewayContext(env: GatewayServiceEnv): Promise<{
  port: number | null;
  probeHosts: readonly string[];
}> {
  const command = await readLaunchAgentProgramArguments(env).catch(() => null);
  const fromArgs = parseTcpPortFromArgs(command?.programArguments);
  if (fromArgs !== null) {
    return {
      port: fromArgs,
      probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
    };
  }
  const fromServiceEnv = parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT ?? "");
  if (fromServiceEnv !== null) {
    return {
      port: fromServiceEnv,
      probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
    };
  }
  return {
    port: parseTcpPort(env.OPENCLAW_GATEWAY_PORT ?? ""),
    probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
  };
}

export function resolveLaunchAgentGuiDomain(): string {
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
      throwBootstrapGuiSessionError({
        detail,
        domain: params.domain,
        actionHint: params.actionHint,
      });
    }
    if (isLaunchctlOperationAlreadyInProgress(detail)) {
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
    if (state === "=> enabled") {
      return true;
    }
    if (state === "=> disabled") {
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
  const res = await execLaunchctl(["print-disabled", domain]);
  if (res.code !== 0) {
    throw new Error(`launchctl print-disabled failed: ${formatLaunchctlResultDetail(res)}`);
  }
  return parseLaunchAgentEnabled(res.stdout || res.stderr || "", label);
}

export async function isLaunchAgentLoaded(args: GatewayServiceEnvArgs): Promise<boolean> {
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(args.env);
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  if (res.code === 0) {
    return true;
  }
  if (isLaunchctlNotLoaded(res)) {
    return false;
  }
  throw new Error(`launchctl print failed: ${formatLaunchctlResultDetail(res)}`);
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
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const [res, systemOwnership] = await Promise.all([
    execLaunchctl(["print", `${domain}/${label}`]),
    inspectSystemLaunchDaemonOwnership(label, { scanInstalledPlists: false }),
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

export function isLaunchctlAlreadyLoaded(res: {
  stdout: string;
  stderr: string;
  code: number;
}): boolean {
  const detail = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return res.code === 130 || detail.includes("already exists in domain");
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

function isLaunchctlBootstrapPendingTeardown(res: {
  stdout: string;
  stderr: string;
  code: number;
}): boolean {
  // `bootout` returns once launchd accepts the request, not once the job is gone,
  // so bootstrapping the same label mid-teardown answers EIO. The plist is valid
  // here, so this is a timing conflict to retry rather than a real I/O fault.
  //
  // launchd answers the same EIO for a label that is simply still registered
  // ("already exists in domain"). That job is not tearing down, so waiting for a
  // teardown that never comes only delays the failure.
  if (isLaunchctlAlreadyLoaded(res)) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(res.stderr || res.stdout);
  return normalized.includes("bootstrap failed: 5") || normalized.includes("input/output error");
}
type LaunchAgentProbeResult =
  | { state: "running" }
  | { state: "stopped" }
  | { state: "not-loaded" }
  | { state: "unknown"; detail?: string };

export async function probeLaunchAgentState(
  serviceTarget: string,
): Promise<LaunchAgentProbeResult> {
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

export async function waitForLaunchAgentStopped(
  serviceTarget: string,
): Promise<LaunchAgentProbeResult> {
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
