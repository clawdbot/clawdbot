/**
 * Output helpers for non-interactive onboarding.
 *
 * JSON success/failure payloads and human-readable gateway health diagnostics
 * are kept here so local and remote setup report failures consistently.
 */
import { formatCliCommand } from "../../../cli/command-format.js";
import type { GatewayServiceLoadState } from "../../../daemon/service-types.js";
import { redactSecrets } from "../../../logging/redact.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

/** Structured daemon/service details attached to gateway health failures. */
export type GatewayHealthFailureDiagnostics = {
  service?: {
    label: string;
    loaded: boolean | null;
    loadState: GatewayServiceLoadState;
    loadedText: string;
    runtimeStatus?: string;
    state?: string;
    pid?: number;
    lastExitStatus?: number;
    lastExitReason?: string;
  };
  lastGatewayError?: string;
  inspectError?: string;
};

/** Coarse recovery category for gateway health failures. */
type GatewayHealthFailureClassification =
  | "not-listening"
  | "auth-mismatch"
  | "service-missing"
  | "service-stopped"
  | "startup-blocked"
  | "module-missing";

/** Emits the JSON success payload for non-interactive onboarding when requested. */
export function logNonInteractiveOnboardingJson(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  mode: "local" | "remote";
  workspaceDir?: string;
  authChoice?: string;
  gateway?: {
    port: number;
    bind: string;
    authMode: string;
    tailscaleMode: string;
    reachable?: boolean;
  };
  installDaemon?: boolean;
  daemonInstall?: {
    requested: boolean;
    installed: boolean;
    skippedReason?: string;
  };
  daemonRuntime?: string;
  skipSkills?: boolean;
  skipHealth?: boolean;
}) {
  if (!params.opts.json) {
    return;
  }
  writeRuntimeJson(params.runtime, {
    ok: true,
    mode: params.mode,
    workspace: params.workspaceDir,
    authChoice: params.authChoice,
    gateway: params.gateway,
    installDaemon: Boolean(params.installDaemon),
    daemonInstall: params.daemonInstall,
    daemonRuntime: params.daemonRuntime,
    skipSkills: Boolean(params.skipSkills),
    skipHealth: Boolean(params.skipHealth),
  });
}

function formatGatewayRuntimeSummary(
  diagnostics: GatewayHealthFailureDiagnostics | undefined,
): string | undefined {
  const service = diagnostics?.service;
  if (!service?.runtimeStatus) {
    return undefined;
  }
  const parts = [service.runtimeStatus];
  if (typeof service.pid === "number") {
    parts.push(`pid ${service.pid}`);
  }
  if (service.state) {
    parts.push(`state ${service.state}`);
  }
  if (typeof service.lastExitStatus === "number") {
    parts.push(`last exit ${service.lastExitStatus}`);
  }
  if (service.lastExitReason) {
    parts.push(`reason ${service.lastExitReason}`);
  }
  return parts.join(", ");
}

function hasConnectionRefusedDetail(detail: string): boolean {
  return /\b(?:econnrefused|connection refused|connect refused)\b/i.test(detail);
}

export function classifyGatewayHealthFailure(params: {
  detail?: string;
  diagnostics?: GatewayHealthFailureDiagnostics;
}): GatewayHealthFailureClassification | undefined {
  const detail = params.detail ?? "";
  const lastGatewayError = params.diagnostics?.lastGatewayError ?? "";
  const combined = `${detail}\n${lastGatewayError}`;
  // Classify from both the active probe and the daemon's last error so a fast
  // restart failure still gets the same recovery hint as a direct probe error.
  if (
    /\b(?:unauthorized|forbidden|invalid token|invalid password|auth mismatch)\b/i.test(combined)
  ) {
    return "auth-mismatch";
  }
  if (
    /\b(?:runtime[- ]deps?|runtime dependencies|cannot find module|sqlite-vec|loadextension)\b/i.test(
      combined,
    )
  ) {
    return "module-missing";
  }
  if (
    params.diagnostics?.service?.loadState.status === "not-loaded" &&
    hasConnectionRefusedDetail(detail)
  ) {
    return "service-missing";
  }
  const runtimeStatus = params.diagnostics?.service?.runtimeStatus;
  if (
    runtimeStatus &&
    runtimeStatus !== "running" &&
    runtimeStatus !== "active" &&
    hasConnectionRefusedDetail(detail)
  ) {
    return "service-stopped";
  }
  if (lastGatewayError.trim()) {
    return "startup-blocked";
  }
  if (hasConnectionRefusedDetail(detail)) {
    return "not-listening";
  }
  return undefined;
}

function recoveryHintForGatewayHealthFailure(
  classification: GatewayHealthFailureClassification | undefined,
): string | undefined {
  switch (classification) {
    case "auth-mismatch":
    case "module-missing":
      return `Fix: run \`${formatCliCommand("openclaw doctor --fix")}\`.`;
    case "service-missing":
      return `Fix: run \`${formatCliCommand("openclaw gateway install --force")}\`.`;
    case "service-stopped":
      return `Fix: run \`${formatCliCommand("openclaw gateway restart")}\`.`;
    case "startup-blocked":
      return `Fix: run \`${formatCliCommand("openclaw gateway status --deep")}\`.`;
    case "not-listening":
      return `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, or run \`${formatCliCommand("openclaw gateway restart")}\` for a managed gateway.`;
    default:
      return undefined;
  }
}

/** Emits JSON or human-readable failure output for non-interactive onboarding. */
export function logNonInteractiveOnboardingFailure(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  mode: "local" | "remote";
  phase: string;
  message: string;
  detail?: string;
  hints?: string[];
  gateway?: {
    wsUrl?: string;
    httpUrl?: string;
  };
  installDaemon?: boolean;
  daemonInstall?: {
    requested: boolean;
    installed: boolean;
    skippedReason?: string;
  };
  daemonRuntime?: string;
  diagnostics?: GatewayHealthFailureDiagnostics;
  informational?: boolean;
}) {
  const classification = classifyGatewayHealthFailure({
    detail: params.detail,
    diagnostics: params.diagnostics,
  });
  const callerHints = params.hints?.filter(Boolean) ?? [];
  // A caller-supplied Fix has phase context that the generic classification cannot know.
  const recoveryHint = callerHints.some((hint) => hint.startsWith("Fix:"))
    ? undefined
    : recoveryHintForGatewayHealthFailure(classification);
  const hints = [...(recoveryHint ? [recoveryHint] : []), ...callerHints];
  const output = redactSecrets({
    message: params.message,
    detail: params.detail,
    hints,
    gateway: params.gateway,
    daemonInstall: params.daemonInstall,
    daemonRuntime: params.daemonRuntime,
    diagnostics: params.diagnostics,
  });
  const gatewayRuntime = formatGatewayRuntimeSummary(output.diagnostics);
  const service = output.diagnostics?.service;
  const serviceLoadText = service
    ? service.loadState.status === "loaded"
      ? service.loadedText
      : service.loadState.status.replace("-", " ")
    : undefined;

  if (params.opts.json) {
    writeRuntimeJson(params.runtime, {
      ok: false,
      mode: params.mode,
      phase: params.phase,
      message: output.message,
      classification,
      detail: output.detail,
      gateway: output.gateway,
      installDaemon: Boolean(params.installDaemon),
      daemonInstall: output.daemonInstall,
      daemonRuntime: output.daemonRuntime,
      diagnostics: output.diagnostics,
      hints: output.hints.length > 0 ? output.hints : undefined,
    });
    return;
  }

  const lines = [
    output.message,
    classification ? `Classification: ${classification}` : undefined,
    output.detail ? `Last probe: ${output.detail}` : undefined,
    service ? `Service: ${service.label} (${serviceLoadText})` : undefined,
    gatewayRuntime ? `Runtime: ${gatewayRuntime}` : undefined,
    output.diagnostics?.lastGatewayError
      ? `Last gateway error: ${output.diagnostics.lastGatewayError}`
      : undefined,
    output.diagnostics?.inspectError
      ? `Diagnostics warning: ${output.diagnostics.inspectError}`
      : undefined,
    output.hints.length > 0 ? output.hints.join("\n") : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  if (params.informational) {
    params.runtime.log(lines);
  } else {
    params.runtime.error(lines);
  }
}
