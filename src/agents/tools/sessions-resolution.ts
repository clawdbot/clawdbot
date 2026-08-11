/**
 * Session key resolution helpers.
 *
 * Normalizes display/internal/current-session aliases and resolves session-id inputs through Gateway.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  normalizeGatewayClientId,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createSessionVisibilityChecker,
  listSpawnedSessionKeys,
} from "../../plugin-sdk/session-visibility.js";
import {
  isAcpSessionKey,
  isIncognitoSessionKey,
  normalizeMainKey,
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

async function isRequesterSpawnedSessionVisible(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
  callGateway?: GatewayCaller;
}): Promise<boolean> {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  try {
    const resolved = await gatewayCall({
      method: "sessions.resolve",
      params: {
        key: params.targetSessionKey,
        spawnedBy: params.requesterSessionKey,
      },
    });
    if (normalizeOptionalString(resolved?.key) === params.targetSessionKey) {
      return true;
    }
  } catch {
    // Older Gateways can reject exact spawned-session resolution.
  }
  return (
    await listSpawnedSessionKeys({
      requesterSessionKey: params.requesterSessionKey,
      callGateway: gatewayCall,
    })
  ).has(params.targetSessionKey);
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
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

type VisibleSessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
    }
  | {
      ok: false;
      status: "forbidden";
      error: string;
      displayKey: string;
    };

function buildResolvedSessionReference(params: {
  key: string;
  alias: string;
  mainKey: string;
  resolvedViaSessionId: boolean;
}): Extract<SessionReferenceResolution, { ok: true }> {
  return {
    ok: true,
    key: params.key,
    displayKey: resolveDisplaySessionKey({
      key: params.key,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    resolvedViaSessionId: params.resolvedViaSessionId,
  };
}

async function requestResolvedSessionKey(
  params: Record<string, unknown> & { allowMissing?: boolean },
  callGateway: GatewayCaller,
): Promise<string | undefined> {
  try {
    const result = await callGateway<{ key?: unknown }>({
      method: "sessions.resolve",
      params,
    });
    return normalizeOptionalString(result?.key);
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
    const result = await callGateway<{ key?: unknown }>({
      method: "sessions.resolve",
      params: legacyParams,
    });
    return normalizeOptionalString(result?.key);
  }
}

function buildSessionResolveQuery(params: {
  input: string;
  kind: "key" | "sessionId";
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  allowMissing?: boolean;
}): Record<string, unknown> & { allowMissing?: boolean } {
  return {
    [params.kind]: params.input,
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

export async function resolveSessionReference(params: {
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
  callGateway?: GatewayCaller;
}): Promise<SessionReferenceResolution> {
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const buildReference = (key: string, resolvedViaSessionId: boolean) =>
    buildResolvedSessionReference({
      key,
      alias: params.alias,
      mainKey: params.mainKey,
      resolvedViaSessionId,
    });
  const tryResolve = async (input: string, kind: "key" | "sessionId", allowMissing = false) => {
    try {
      const key = await requestResolvedSessionKey(
        buildSessionResolveQuery({
          input,
          kind,
          requesterInternalKey: params.requesterInternalKey,
          restrictToSpawned: params.restrictToSpawned,
          allowMissing,
        }),
        gatewayCall,
      );
      return key ? buildReference(key, kind === "sessionId") : null;
    } catch {
      return null;
    }
  };
  const rawInput =
    resolveCurrentSessionClientAlias({
      key: params.sessionKey,
      requesterInternalKey: params.requesterInternalKey,
    }) ?? params.sessionKey.trim();
  if (rawInput === "current") {
    const resolvedCurrent =
      (params.restrictToSpawned ? null : await tryResolve(rawInput, "key", true)) ??
      (await tryResolve(rawInput, "sessionId", true));
    if (resolvedCurrent) {
      return resolvedCurrent;
    }
  }
  const raw =
    rawInput === "current" && params.requesterInternalKey ? params.requesterInternalKey : rawInput;
  if (shouldResolveSessionIdInput(raw)) {
    const resolvedByKey = await tryResolve(raw, "key");
    if (resolvedByKey) {
      return resolvedByKey;
    }
    try {
      const key = await requestResolvedSessionKey(
        buildSessionResolveQuery({
          input: raw,
          kind: "sessionId",
          requesterInternalKey: params.requesterInternalKey,
          restrictToSpawned: params.restrictToSpawned,
        }),
        gatewayCall,
      );
      if (!key) {
        throw new Error(`Session not found: ${raw} (use the full sessionKey from sessions_list)`);
      }
      return buildReference(key, true);
    } catch (error) {
      if (params.restrictToSpawned) {
        return {
          ok: false,
          status: "forbidden",
          error: `Session not visible from this sandboxed agent session: ${raw}`,
        };
      }
      return {
        ok: false,
        status: "error",
        error:
          formatErrorMessage(error) ||
          `Session not found: ${raw} (use the full sessionKey from sessions_list)`,
      };
    }
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.requesterInternalKey,
  });
  const displayKey = resolveDisplaySessionKey({
    key: resolvedKey,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  return { ok: true, key: resolvedKey, displayKey, resolvedViaSessionId: false };
}

export async function resolveVisibleSessionReference(params: {
  action: "history" | "send" | "status" | "list";
  resolvedSession: Extract<SessionReferenceResolution, { ok: true }>;
  requesterSessionKey: string;
  restrictToSpawned: boolean;
  visibilitySessionKey: string;
  callGateway?: GatewayCaller;
}): Promise<VisibleSessionReferenceResolution> {
  const resolvedKey = params.resolvedSession.key;
  const displayKey = params.resolvedSession.displayKey;
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
  const shouldVerifySpawnedVisibility =
    params.restrictToSpawned &&
    !params.resolvedSession.resolvedViaSessionId &&
    params.requesterSessionKey !== resolvedKey;
  const scopedAccess =
    params.action === "list"
      ? undefined
      : createSessionVisibilityChecker.resolveScopedAccess({
          action: params.action,
          requesterSessionKey: params.requesterSessionKey,
          targetSessionKey: resolvedKey,
        });
  const visible =
    Boolean(scopedAccess) ||
    !shouldVerifySpawnedVisibility ||
    (await isRequesterSpawnedSessionVisible({
      requesterSessionKey: params.requesterSessionKey,
      targetSessionKey: resolvedKey,
      callGateway: params.callGateway,
    }));
  if (!visible) {
    return {
      ok: false,
      status: "forbidden",
      error: `Session not visible from this sandboxed agent session: ${params.visibilitySessionKey}`,
      displayKey,
    };
  }
  return { ok: true, key: resolvedKey, displayKey };
}
