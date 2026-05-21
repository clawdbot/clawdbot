import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

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

export type AgentExecutionPlacementResult =
  | { ok: true; execution: AgentExecutionPlacement }
  | { ok: false; error: string };

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
  const requestedBackend = normalizeOptionalString(params.request?.backend) ?? "local";
  const requestedProfile = normalizeOptionalString(params.request?.profile);
  const configuredBackends = readExecutionBackends(params.cfg);
  const configuredBackend = configuredBackends[requestedBackend];
  const backendTypeRaw =
    configuredBackend?.type ?? (requestedBackend === "local" ? "process" : undefined);

  if (
    typeof backendTypeRaw !== "string" ||
    !AGENT_EXECUTION_BACKEND_TYPES.includes(backendTypeRaw as AgentExecutionBackendType)
  ) {
    return {
      ok: false,
      error: `unknown execution backend "${requestedBackend}"`,
    };
  }
  const backendType = backendTypeRaw as AgentExecutionBackendType;

  if (backendType !== "process") {
    return {
      ok: false,
      error: `execution backend "${requestedBackend}" has type "${backendType}", but only local process execution is supported in this release`,
    };
  }

  if (requestedProfile) {
    const profileNames = readProfileNames(configuredBackend ?? {});
    if (profileNames.size === 0) {
      return {
        ok: false,
        error: `execution backend "${requestedBackend}" does not define profile "${requestedProfile}"`,
      };
    }
    if (!profileNames.has(requestedProfile)) {
      return {
        ok: false,
        error: `unknown execution profile "${requestedProfile}" for backend "${requestedBackend}"`,
      };
    }
  }

  return {
    ok: true,
    execution: {
      backend: requestedBackend,
      type: backendType,
      ...(requestedProfile ? { profile: requestedProfile } : {}),
    },
  };
}
