import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const AGENT_EXECUTION_BACKEND_TYPES = ["process", "container", "kubernetes"] as const;

export type AgentExecutionBackendType = (typeof AGENT_EXECUTION_BACKEND_TYPES)[number];

export type AgentExecutionPlacementRequest = {
  backend?: string;
  profile?: string;
};

export type AgentExecutionPlacement = {
  backend: string;
  type: AgentExecutionBackendType;
  profile?: string;
};

export type AgentExecutionPlacementResult = Result<AgentExecutionPlacement, string>;

type RawExecutionBackendConfig = {
  type?: unknown;
  profiles?: unknown;
};

function readExecutionBackends(cfg: OpenClawConfig): Record<string, RawExecutionBackendConfig> {
  const raw = (cfg.agents as unknown as { executionBackends?: unknown } | undefined)
    ?.executionBackends;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, RawExecutionBackendConfig>;
}

function readProfileNames(backend: RawExecutionBackendConfig): Set<string> {
  if (
    !backend.profiles ||
    typeof backend.profiles !== "object" ||
    Array.isArray(backend.profiles)
  ) {
    return new Set();
  }
  return new Set(Object.keys(backend.profiles));
}

export function resolveAgentExecutionPlacement(params: {
  cfg: OpenClawConfig;
  request?: AgentExecutionPlacementRequest;
}): AgentExecutionPlacementResult {
  const requestedBackend = (normalizeOptionalString(params.request?.backend) ?? "local").slice(0, 128);
  const requestedProfile = normalizeOptionalString(params.request?.profile)?.slice(0, 128);
  const configuredBackends = readExecutionBackends(params.cfg);
  const configuredBackend = configuredBackends[requestedBackend];
  const backendTypeRaw = requestedBackend === "local" ? "process" : configuredBackend?.type;

  if (requestedBackend !== "local") {
    return err(`execution backend "${requestedBackend}" is not supported until it has a dispatcher`);
  }
  if (
    typeof backendTypeRaw !== "string" ||
    !AGENT_EXECUTION_BACKEND_TYPES.includes(backendTypeRaw as AgentExecutionBackendType)
  ) {
    return err(`unknown execution backend "${requestedBackend}"`);
  }
  const backendType = backendTypeRaw as AgentExecutionBackendType;

  if (backendType !== "process") {
    return err(`execution backend "${requestedBackend}" has type "${backendType}", but only local process execution is supported in this release`);
  }

  if (requestedProfile) {
    const profileNames = readProfileNames(configuredBackend ?? {});
    if (profileNames.size === 0) {
      return err(`execution backend "${requestedBackend}" does not define profile "${requestedProfile}"`);
    }
    if (!profileNames.has(requestedProfile)) {
      return err(`unknown execution profile "${requestedProfile}" for backend "${requestedBackend}"`);
    }
  }

  return ok({
    backend: requestedBackend,
    type: backendType,
    ...(requestedProfile ? { profile: requestedProfile } : {}),
  });
}
