/**
 * Session key resolution helpers.
 *
 * Normalizes display/internal/current-session aliases and resolves session-id inputs through Gateway.
 */
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  listSpawnedSessionKeysWithResult,
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
  lookupFailedOperationMessage,
  sessionOwnershipLookupFailure,
  type SessionOwnershipLookupFailure,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  isAcpSessionKey,
  isIncognitoSessionKey,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

type GatewayCaller = AgentToolGatewayRequestCaller;

const CURRENT_SESSION_CLIENT_ALIAS_IDS = new Set<string>([
  GATEWAY_CLIENT_IDS.TUI,
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
}) {
  if (params.key === "current") {
    return params.requesterInternalKey ?? params.key;
  }
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export function resolveCurrentSessionClientAlias(params: {
  key: string;
  requesterInternalKey?: string;
}): string | undefined {
  const requesterKey = normalizeOptionalString(params.requesterInternalKey);
  if (!requesterKey) {
    return undefined;
  }
  const clientId = normalizeGatewayClientId(params.key);
  if (!clientId || !CURRENT_SESSION_CLIENT_ALIAS_IDS.has(clientId)) {
    return undefined;
  }
  // UI/client labels can appear next to the real session key in status text.
  // Treat them as the current requester instead of probing them as sessionIds.
  return requesterKey;
}

export function isExpectedSessionLookupMiss(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("No session found") &&
    (!(error instanceof GatewayClientRequestError) || error.gatewayCode === "INVALID_REQUEST")
  );
}

function isUnsupportedSpawnedSessionResolve(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === "unknown method: sessions.resolve"
  );
}

export async function lookupRequesterSessionOwnership(params: {
  requesterSessionKey: string;
  requesterAgentId: string;
  targetSessionKey: string;
  targetAgentId?: string;
  callGateway?: GatewayCaller;
}): Promise<Result<boolean, SessionOwnershipLookupFailure>> {
  if (
    params.requesterSessionKey === params.targetSessionKey &&
    params.targetAgentId === params.requesterAgentId
  ) {
    return ok(true);
  }
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  try {
    const resolved = await requestResolvedSession(
      {
        key: params.targetSessionKey,
        agentId: params.targetAgentId,
        spawnedBy: params.requesterSessionKey,
        allowMissing: true,
      },
      gatewayCall,
    );
    return ok(resolved?.key === params.targetSessionKey);
  } catch (error) {
    if (isExpectedSessionLookupMiss(error)) {
      return ok(false);
    }
    if (isUnsupportedSpawnedSessionResolve(error)) {
      // Older gateways may lack the exact spawned-session selector. Preserve
      // their list-based contract without hiding operational resolver failures.
      const listed = await listSpawnedSessionKeysWithResult({
        requesterSessionKey: params.requesterSessionKey,
        callGateway: gatewayCall,
      });
      return listed.ok
        ? ok(
            params.targetAgentId === params.requesterAgentId &&
              listed.value.has(params.targetSessionKey),
          )
        : err(listed.error);
    }
    return err(sessionOwnershipLookupFailure(error));
  }
}

function looksLikeSessionKey(value: string): boolean {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown" || raw === "current") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

type SessionReferenceResolution =
  | {
      ok: true;
      agentId?: string;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
      requesterOwned?: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string; notFound?: boolean };

type SessionReferenceAction = "history" | "send" | "status" | "list" | "search";

type VisibleSessionReferenceResolution =
  | {
      ok: true;
      agentId?: string;
      key: string;
      displayKey: string;
      missing?: true;
      requesterOwned: boolean;
    }
  | {
      ok: false;
      status: "error" | "forbidden";
      error: string;
      displayKey: string;
    };

function buildResolvedSessionReference(params: {
  agentId?: string;
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
  requesterOwned: boolean;
}): Extract<SessionReferenceResolution, { ok: true }> {
  return {
    ok: true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    key: params.key,
    displayKey: resolveDisplaySessionKey({
      key: params.key,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    resolvedViaSessionId: params.resolvedViaSessionId,
    requesterOwned: params.requesterOwned,
  };
}

function buildFailedSessionReference(
  error: unknown,
  raw: string,
  restrictToSpawned: boolean,
): Extract<SessionReferenceResolution, { ok: false }> {
  return restrictToSpawned
    ? {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${raw}`,
      }
    : {
        ok: false,
        status: "error",
        error:
          formatErrorMessage(error) ||
          `Session not found: ${raw} (use the full sessionKey from sessions_list)`,
      };
}

async function requestResolvedSession(
  params: Record<string, unknown> & { allowMissing?: boolean },
  callGateway: GatewayCaller,
): Promise<{ agentId?: string; key: string } | undefined> {
  const toResolvedSession = (result: { agentId?: unknown; key?: unknown } | undefined) => {
    const key = normalizeOptionalString(result?.key);
    if (!key) {
      return undefined;
    }
    const agentId = normalizeOptionalString(result?.agentId);
    return { key, ...(agentId ? { agentId } : {}) };
  };
  try {
    const result = await callGateway<{ agentId?: unknown; key?: unknown }>({
      method: "sessions.resolve",
      params,
    });
    return toResolvedSession(result);
  } catch (error) {
    const olderGatewayRejectedProbe =
      params.allowMissing === true &&
      error instanceof GatewayClientRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message.includes("invalid sessions.resolve params") &&
      error.message.includes("unexpected property 'allowMissing'");
    if (!olderGatewayRejectedProbe) {
      throw error;
    }
    // Protocol v4 gateways predating allowMissing reject the additive field.
    // Retry without it for mixed-version correctness; remove at the next protocol break.
    const legacyParams: Record<string, unknown> = { ...params };
    delete legacyParams.allowMissing;
    const result = await callGateway<{ agentId?: unknown; key?: unknown }>({
      method: "sessions.resolve",
      params: legacyParams,
    });
    return toResolvedSession(result);
  }
}

function buildSessionResolveQuery(params: {
  input: string;
  kind: "key" | "sessionId";
  agentId?: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Record<string, unknown> & { allowMissing?: boolean } {
  return {
    [params.kind]: params.input,
    agentId: params.agentId,
    spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
    ...(params.kind === "sessionId"
      ? {
          includeGlobal: !params.restrictToSpawned,
          includeUnknown: !params.restrictToSpawned,
        }
      : {}),
    ...(params.allowMissing ? { allowMissing: true } : {}),
  };
}

type ResolvedReference = Extract<SessionReferenceResolution, { ok: true }>;
type ReferenceLookupResult = Result<ResolvedReference | null, SessionOwnershipLookupFailure>;

async function lookupSessionReference(params: {
  input: string;
  kind: "key" | "sessionId";
  keyAgentId?: string;
  agentId?: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
  callGateway: GatewayCaller;
}): Promise<ReferenceLookupResult> {
  try {
    const resolved = await requestResolvedSession(
      buildSessionResolveQuery({
        input: params.input,
        kind: params.kind,
        agentId:
          params.kind === "key"
            ? (parseAgentSessionKey(params.input)?.agentId ?? params.keyAgentId ?? params.agentId)
            : params.agentId,
        requesterInternalKey: params.requesterInternalKey,
        restrictToSpawned: params.restrictToSpawned,
        allowMissing: params.allowMissing,
      }),
      params.callGateway,
    );
    if (!resolved) {
      return ok(null);
    }
    return ok(
      buildResolvedSessionReference({
        ...resolved,
        alias: params.alias,
        mainKey: params.mainKey,
        resolvedViaSessionId: params.kind === "sessionId",
        requesterOwned: params.restrictToSpawned,
      }),
    );
  } catch (error) {
    if (isExpectedSessionLookupMiss(error)) {
      return ok(null);
    }
    return err(sessionOwnershipLookupFailure(error));
  }
}

async function resolveSessionReferenceByKeyOrSessionId(params: {
  raw: string;
  keyAgentId?: string;
  agentId?: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
  skipKeyLookup?: boolean;
  forceSessionIdLookup?: boolean;
  callGateway: GatewayCaller;
}): Promise<ReferenceLookupResult> {
  if (!params.skipKeyLookup) {
    // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
    const resolvedByKey = await lookupSessionReference({
      input: params.raw,
      kind: "key",
      keyAgentId: params.keyAgentId,
      agentId: params.agentId,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      allowMissing: params.allowMissing,
      callGateway: params.callGateway,
    });
    if (!resolvedByKey.ok || resolvedByKey.value) {
      return resolvedByKey;
    }
  }
  if (!(params.forceSessionIdLookup || shouldResolveSessionIdInput(params.raw))) {
    return ok(null);
  }
  return await lookupSessionReference({
    input: params.raw,
    kind: "sessionId",
    keyAgentId: params.keyAgentId,
    agentId: params.agentId,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
    restrictToSpawned: params.restrictToSpawned,
    allowMissing: params.allowMissing,
    callGateway: params.callGateway,
  });
}

export async function resolveSessionReference(params: {
  action: SessionReferenceAction;
  sessionKey: string;
  /** Owner already selected for literal key lookup; session-id lookup remains cross-agent. */
  keyAgentId?: string;
  agentId?: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  callGateway?: GatewayCaller;
}): Promise<SessionReferenceResolution> {
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const failedLookup = (failure: SessionOwnershipLookupFailure): SessionReferenceResolution => {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterInternalKey ?? "unknown",
      failure,
    });
    return {
      ok: false,
      status: params.restrictToSpawned ? "forbidden" : "error",
      error: params.restrictToSpawned
        ? lookupFailedDenialMessage(params.action, failure.kind)
        : lookupFailedOperationMessage(params.action, failure.kind),
    };
  };
  const rawInput =
    resolveCurrentSessionClientAlias({
      key: params.sessionKey,
      requesterInternalKey: params.requesterInternalKey,
    }) ?? params.sessionKey.trim();
  const raw =
    rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
  if (shouldResolveSessionIdInput(raw)) {
    const resolvedByGateway = await resolveSessionReferenceByKeyOrSessionId({
      raw,
      keyAgentId: params.keyAgentId,
      agentId: params.agentId,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
      callGateway: gatewayCall,
    });
    if (!resolvedByGateway.ok) {
      return failedLookup(resolvedByGateway.error);
    }
    if (resolvedByGateway.value) {
      return resolvedByGateway.value;
    }
    return {
      ok: false,
      status: params.restrictToSpawned ? "forbidden" : "error",
      notFound: true,
      error: params.restrictToSpawned
        ? `Session not visible from this sandboxed agent session: ${raw}`
        : `Session not found: ${raw} (use the full sessionKey from sessions_list)`,
    };
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });
  const semanticAliasAgentId =
    params.agentId ??
    (rawInput === "current"
      ? (parseAgentSessionKey(resolvedKey)?.agentId ?? params.keyAgentId)
      : rawInput === "main" || rawInput === params.mainKey
        ? params.keyAgentId
        : undefined);
  const displayKey = resolveDisplaySessionKey({
    key: resolvedKey,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  return {
    ok: true,
    ...(semanticAliasAgentId ? { agentId: semanticAliasAgentId } : {}),
    key: resolvedKey,
    displayKey,
    resolvedViaSessionId: false,
    requesterOwned:
      resolvedKey === params.requesterInternalKey &&
      (!semanticAliasAgentId ||
        semanticAliasAgentId ===
          (parseAgentSessionKey(params.requesterInternalKey ?? "")?.agentId ?? params.keyAgentId)),
  };
}

export async function resolveVisibleSessionReference(params: {
  action: SessionReferenceAction;
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  requesterAgentId: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
  allowMissingKey?: boolean;
  concealResolutionError?: string;
  callGateway?: GatewayCaller;
}): Promise<VisibleSessionReferenceResolution> {
  let resolvedKey = params.resolvedSession.key;
  let resolvedAgentId =
    params.resolvedSession.agentId ?? parseAgentSessionKey(resolvedKey)?.agentId;
  let displayKey = params.resolvedSession.displayKey;
  let missing = false;
  const requesterOwnedByResolution =
    params.resolvedSession.requesterOwned ??
    (params.restrictToSpawned && params.resolvedSession.resolvedViaSessionId);
  // Cross-session tools persist their results into the caller transcript; an
  // incognito target must remain unreachable even from an incognito requester.
  if (isIncognitoSessionKey(resolvedKey)) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  const input = params.visibilitySessionKey.trim();
  const isExplicitKey =
    !params.resolvedSession.resolvedViaSessionId &&
    input !== "current" &&
    input !== "main" &&
    input !== "global" &&
    input !== "unknown" &&
    !shouldResolveSessionIdInput(input);
  if (
    isExplicitKey &&
    !params.restrictToSpawned &&
    (params.action === "history" || params.action === "send")
  ) {
    try {
      const resolved = await requestResolvedSession(
        buildSessionResolveQuery({
          input: resolvedKey,
          kind: "key",
          agentId: resolvedAgentId,
          requesterInternalKey: params.requesterSessionKey,
          restrictToSpawned: params.restrictToSpawned,
          allowMissing: params.allowMissingKey,
        }),
        params.callGateway ?? callAgentToolGatewayRequest,
      );
      if (resolved) {
        resolvedKey = resolved.key;
        resolvedAgentId = resolved.agentId ?? parseAgentSessionKey(resolved.key)?.agentId;
        displayKey = resolved.key;
      } else if (params.allowMissingKey) {
        missing = true;
      }
    } catch (error) {
      if (params.concealResolutionError && !params.restrictToSpawned) {
        return {
          ok: false,
          status: "forbidden",
          error: params.concealResolutionError,
          displayKey,
        };
      }
      const failed = buildFailedSessionReference(
        error,
        params.visibilitySessionKey,
        params.restrictToSpawned,
      );
      return { ...failed, displayKey };
    }
  }
  if (isIncognitoSessionKey(resolvedKey)) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from session tools: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  return {
    ok: true,
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    key: resolvedKey,
    displayKey,
    requesterOwned:
      requesterOwnedByResolution ||
      (params.requesterSessionKey === resolvedKey && resolvedAgentId === params.requesterAgentId),
    ...(missing ? { missing: true } : {}),
  };
}
