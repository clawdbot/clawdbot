import { type RuntimeEnv, writeRuntimeJson } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

export type GatewayHealthFailureDiagnostics = {
  service?: {
    label: string;
    loaded: boolean;
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

export type GatewayHealthFailureClassification =
  | "not-listening"
  | "auth-mismatch"
  | "service-missing"
  | "service-stopped"
  | "startup-blocked"
  | "runtime-deps-broken";

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

function classifyGatewayHealthFailure(params: {
  detail?: string;
  diagnostics?: GatewayHealthFailureDiagnostics;
}): GatewayHealthFailureClassification | undefined {
  const detail = params.detail ?? "";
  const lastGatewayError = params.diagnostics?.lastGatewayError ?? "";
  const combined = `${detail}\n${lastGatewayError}`;
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
    return "runtime-deps-broken";
  }
  if (params.diagnostics?.service?.loaded === false && hasConnectionRefusedDetail(detail)) {
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
      return "Fix: run `openclaw doctor --fix`.";
    case "runtime-deps-broken":
      return "Fix: run `openclaw doctor --fix`.";
    case "service-missing":
      return "Fix: run `openclaw gateway install --force`.";
    case "service-stopped":
      return "Fix: run `openclaw gateway restart`.";
    case "startup-blocked":
      return "Fix: run `openclaw gateway status --deep`.";
    case "not-listening":
      return "Fix: start `openclaw gateway run`, or run `openclaw gateway restart` for a managed gateway.";
    default:
      return undefined;
  }
}

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
}) {
  const classification = classifyGatewayHealthFailure({
    detail: params.detail,
    diagnostics: params.diagnostics,
  });
  const recoveryHint = recoveryHintForGatewayHealthFailure(classification);
  const hints = [...(recoveryHint ? [recoveryHint] : []), ...(params.hints?.filter(Boolean) ?? [])];
  const gatewayRuntime = formatGatewayRuntimeSummary(params.diagnostics);

  if (params.opts.json) {
    writeRuntimeJson(params.runtime, {
      ok: false,
      mode: params.mode,
      phase: params.phase,
      message: params.message,
      classification,
      detail: params.detail,
      gateway: params.gateway,
      installDaemon: Boolean(params.installDaemon),
      daemonInstall: params.daemonInstall,
      daemonRuntime: params.daemonRuntime,
      diagnostics: params.diagnostics,
      hints: hints.length > 0 ? hints : undefined,
    });
    return;
  }

  const lines = [
    params.message,
    classification ? `Classification: ${classification}` : undefined,
    params.detail ? `Last probe: ${params.detail}` : undefined,
    params.diagnostics?.service
      ? `Service: ${params.diagnostics.service.label} (${params.diagnostics.service.loaded ? params.diagnostics.service.loadedText : "not loaded"})`
      : undefined,
    gatewayRuntime ? `Runtime: ${gatewayRuntime}` : undefined,
    params.diagnostics?.lastGatewayError
      ? `Last gateway error: ${params.diagnostics.lastGatewayError}`
      : undefined,
    params.diagnostics?.inspectError
      ? `Diagnostics warning: ${params.diagnostics.inspectError}`
      : undefined,
    hints.length > 0 ? hints.join("\n") : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  params.runtime.error(lines);
}
