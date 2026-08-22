import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentExecutionBackendConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type AgentExecutionBackendType = "process" | "container" | "kubernetes";

export type AgentExecutionPlacementRequest = {
  backend?: string;
  profile?: string;
};

export type AgentExecutionPlacement = {
  backend: string;
  type: AgentExecutionBackendType;
  profile?: string;
};

type AgentExecutionPlacementResult = Result<AgentExecutionPlacement, string>;

function readExecutionBackends(cfg: OpenClawConfig): Record<string, AgentExecutionBackendConfig> {
  return cfg.agents?.executionBackends ?? {};
}

function readProfileNames(backend: AgentExecutionBackendConfig): Set<string> {
  return new Set(Object.keys(backend.profiles ?? {}));
}

export function resolveAgentExecutionPlacement(params: {
  cfg: OpenClawConfig;
  request?: AgentExecutionPlacementRequest;
}): AgentExecutionPlacementResult {
  const requestedBackend = (normalizeOptionalString(params.request?.backend) ?? "local").slice(
    0,
    128,
  );
  const requestedProfile = normalizeOptionalString(params.request?.profile)?.slice(0, 128);
  const configuredBackends = readExecutionBackends(params.cfg);
  const configuredBackend = configuredBackends[requestedBackend];
  const backendTypeRaw = requestedBackend === "local" ? "process" : configuredBackend?.type;

  if (requestedBackend !== "local" && !configuredBackend) {
    return err(
      `unknown execution backend "${requestedBackend}"; use "local" or configure the backend first`,
    );
  }
  if (requestedBackend !== "local") {
    return err(
      `execution backend "${requestedBackend}" is not supported until it has a dispatcher`,
    );
  }
  if (backendTypeRaw !== "process") {
    return err(`unknown execution backend "${requestedBackend}"`);
  }
  const backendType: AgentExecutionBackendType = backendTypeRaw;

  if (requestedProfile) {
    const profileNames = readProfileNames(configuredBackend ?? { type: "process" });
    if (profileNames.size === 0) {
      return err(
        `execution backend "${requestedBackend}" does not define profile "${requestedProfile}"`,
      );
    }
    if (!profileNames.has(requestedProfile)) {
      return err(
        `unknown execution profile "${requestedProfile}" for backend "${requestedBackend}"`,
      );
    }
  }

  return ok({
    backend: requestedBackend,
    type: backendType,
    ...(requestedProfile ? { profile: requestedProfile } : {}),
  });
}
