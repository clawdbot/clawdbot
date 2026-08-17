// Model probe gateway method reuses the CLI auth-probe engine behind an admin-scoped RPC.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  ErrorCodes,
  errorShape,
  type ModelsProbeParams,
  type ModelsProbeResult,
  validateModelsProbeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  type AuthProbeResult,
  type AuthProbeReasonCode,
  type AuthProbeStatus,
  redactAuthProbeError,
  runAuthProbes,
} from "../../commands/models/list.probe.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const PROBE_CONCURRENCY = 2;
const PROBE_MAX_TOKENS = 8;

const FAILURE_PRIORITY: readonly AuthProbeStatus[] = [
  "auth",
  "billing",
  "rate_limit",
  "timeout",
  "format",
  "no_model",
  "unknown",
];

const PROBE_ERROR_MESSAGES: Record<Exclude<AuthProbeStatus, "ok">, string> = {
  auth: "Authentication failed.",
  rate_limit: "The provider rate limit was reached.",
  billing: "The provider reported a billing problem.",
  timeout: "The connection timed out.",
  format: "The provider rejected the model or request format.",
  unknown: "The connection probe failed.",
  no_model: "No model is available for this provider.",
};

function safeProbeError(status: AuthProbeStatus): string | undefined {
  return status === "ok" ? undefined : PROBE_ERROR_MESSAGES[status];
}

const PROBE_REASON_MESSAGES: Partial<Record<AuthProbeReasonCode, string>> = {
  excluded_by_auth_order:
    "This profile is excluded by the provider auth order. Update the order or choose another profile, then retry.",
  missing_credential:
    "This credential is missing. Add it or remove the stale configuration, then retry.",
  expired: "This credential has expired. Sign in again or replace it, then retry.",
  invalid_expires:
    "This credential has invalid expiry metadata. Sign in again or replace it, then retry.",
  unresolved_ref:
    "The configured credential could not be resolved. Update or remove it, then retry.",
  ineligible_profile:
    "This profile is not compatible with the provider configuration. Choose another profile, then retry.",
  no_model: "No model is available for this provider. Configure a model, then retry.",
};

function safeProbeTargetLabel(result: AuthProbeResult): string {
  const owner =
    result.source === "profile"
      ? `Profile ${result.label}`
      : result.source === "models.json"
        ? result.label === "config"
          ? "Configured credential"
          : "Provider configuration"
        : `Environment credential (${result.label})`;
  return result.model ? `${owner} · ${result.model}` : owner;
}

function safeProbeTargetError(result: AuthProbeResult): string | undefined {
  if (result.status === "ok") {
    return undefined;
  }
  return (
    (result.reasonCode && PROBE_REASON_MESSAGES[result.reasonCode]) ?? safeProbeError(result.status)
  );
}

function modelCandidatesFromConfig(cfg: OpenClawConfig): string[] {
  const configured = cfg.agents?.defaults?.model;
  const primary = typeof configured === "string" ? configured : configured?.primary;
  const fallbacks = typeof configured === "string" ? [] : (configured?.fallbacks ?? []);
  return [primary, ...fallbacks, cfg.agents?.defaults?.utilityModel]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function selectRollupStatus(results: AuthProbeResult[]): AuthProbeStatus {
  if (results.some((result) => result.status === "ok")) {
    return "ok";
  }
  return (
    FAILURE_PRIORITY.find((status) => results.some((result) => result.status === status)) ??
    "unknown"
  );
}

function mapProbeResult(provider: string, results: AuthProbeResult[]): ModelsProbeResult {
  const status = selectRollupStatus(results);
  const statusResults = results.filter((result) => result.status === status);
  const latencyMs = statusResults
    .map((result) => result.latencyMs)
    .filter((value): value is number => typeof value === "number")
    .toSorted((left, right) => left - right)[0];
  const error = safeProbeError(status);
  return {
    provider,
    status,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(error ? { error } : {}),
    results: results.map((result) => {
      const targetError = safeProbeTargetError(result);
      return {
        ...(result.profileId ? { profileId: result.profileId } : {}),
        label: safeProbeTargetLabel(result),
        status: result.status,
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        ...(targetError ? { error: targetError } : {}),
      };
    }),
  };
}

export const modelsProbeHandlers: GatewayRequestHandlers = {
  "models.probe": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsProbeParams, "models.probe", respond)) {
      return;
    }
    const request = params as ModelsProbeParams;
    const provider = normalizeProviderId(request.provider);
    const profileId = request.profileId?.trim();
    if (!provider || (request.profileId !== undefined && !profileId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provider and profileId must not be blank"),
      );
      return;
    }
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, request.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const workspaceDir = resolveAgentWorkspaceDir(cfg, scope.agentId);
      // Probe under the requested provider so model selection, catalog rows, and
      // a models.providers.<id> override resolve against the surface the client
      // asked about. The probe planner resolves credentials separately through
      // the provider's auth alias, matching normal agent runtime planning.
      const summary = await runAuthProbes({
        cfg,
        agentId: scope.agentId,
        agentDir: scope.agentDir,
        workspaceDir,
        providers: [provider],
        modelCandidates: modelCandidatesFromConfig(cfg),
        options: {
          provider,
          ...(profileId ? { profileIds: [profileId] } : {}),
          ...(!profileId ? { includeDirectKeys: true } : {}),
          timeoutMs,
          concurrency: PROBE_CONCURRENCY,
          maxTokens: PROBE_MAX_TOKENS,
        },
      });
      const result = mapProbeResult(provider, summary.results);
      if (result.results.length === 0) {
        result.error = "No probe targets are available for this provider.";
      }
      respond(true, result, undefined);
    } catch (error) {
      context.logGateway.warn("Model connection probe failed.", {
        event: "models_probe_failed",
        provider,
        timeoutMs,
        error: redactAuthProbeError(formatForLog(error)),
      });
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Connection probe failed."));
    }
  },
};
