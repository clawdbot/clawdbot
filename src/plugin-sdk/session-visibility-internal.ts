/** Core-private spawned-session ownership lookup; not a published plugin SDK subpath. */
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import {
  GatewayCredentialsRequiredError,
  GatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  callGateway as defaultCallGateway,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { redactIdentifier } from "../logging/redact-identifier.js";

type GatewayCaller = typeof defaultCallGateway;

export type LookupFailureKind = "transient" | "credentials" | "unknown";

export function classifyLookupFailure(error: unknown): LookupFailureKind {
  if (error instanceof GatewayClientRequestError && error.retryable) {
    return "transient";
  }
  if (
    isGatewayTransportError(error) &&
    (error.kind === "timeout" || error.code === 1006 || error.code === 1013)
  ) {
    return "transient";
  }
  if (
    error instanceof GatewayCredentialsRequiredError ||
    error instanceof GatewayExplicitAuthRequiredError ||
    error instanceof GatewaySecretRefUnavailableError
  ) {
    return "credentials";
  }
  return "unknown";
}

export function lookupFailedDenialSuffix(kind: LookupFailureKind): string {
  if (kind === "transient") {
    return "spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.";
  }
  if (kind === "credentials") {
    return "spawned-session ownership lookup failed; ask the operator to check gateway configuration and credentials.";
  }
  return "spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.";
}

export function lookupFailedDenialMessage(
  action: "history" | "send" | "status" | "list" | "search",
  kind: LookupFailureKind,
): string {
  const label = action === "list" ? "Session list" : `Session ${action}`;
  return `${label} denied because ${lookupFailedDenialSuffix(kind)}`;
}

export function lookupFailedOperationMessage(
  action: "history" | "send" | "status" | "list" | "search",
  kind: LookupFailureKind,
): string {
  const label = action === "list" ? "Session list" : `Session ${action}`;
  const guidance =
    kind === "transient"
      ? "retry once, then ask the operator to inspect OpenClaw logs"
      : kind === "credentials"
        ? "ask the operator to check gateway configuration and credentials"
        : "ask the operator to inspect OpenClaw logs";
  return `${label} failed because session lookup failed${kind === "transient" ? " (transient)" : ""}; ${guidance}.`;
}

export type SessionOwnershipLookupFailure = {
  kind: LookupFailureKind;
  diagnostic: string;
};

export function sessionOwnershipLookupFailure(error: unknown): SessionOwnershipLookupFailure {
  return {
    kind: classifyLookupFailure(error),
    diagnostic: formatErrorMessage(error),
  };
}

export function logSessionOwnershipLookupFailure(params: {
  requesterSessionKey: string;
  failure: SessionOwnershipLookupFailure;
}): void {
  logWarn(
    `session-visibility: spawned-session ownership lookup failed for requester=${redactIdentifier(params.requesterSessionKey)}: ${params.failure.diagnostic}`,
  );
}

/** List sessions spawned by the requester through the gateway session list method. */
export async function listSpawnedSessionKeysWithResult(params: {
  requesterSessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<Result<Set<string>, SessionOwnershipLookupFailure>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  try {
    const list = await (params.callGateway ?? defaultCallGateway)<{
      sessions: Array<{ key?: unknown }>;
    }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        ...(limit !== undefined ? { limit } : {}),
        spawnedBy: params.requesterSessionKey,
      },
    });
    if (!Array.isArray(list?.sessions)) {
      return err({
        kind: "unknown",
        diagnostic: "gateway sessions.list returned an invalid response",
      });
    }
    const sessions = list.sessions;
    const keys = normalizeTrimmedStringList(sessions.map((entry) => entry?.key));
    return ok(new Set(keys));
  } catch (error) {
    return err(sessionOwnershipLookupFailure(error));
  }
}
