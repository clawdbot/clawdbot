import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { resolveAuthorizedBoardViewTicketClaims } from "./board-view-ticket.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  listSessionGroups,
  normalizeGroupNames,
  resolveSessionGroupMutationTargetsByName,
} from "./session-groups.js";
import {
  isApprovalSessionTargetMethod,
  sessionMutationTargetFields,
} from "./session-method-policy.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";
import { resolveUnifiedTalkSessionTarget } from "./talk-session-registry.js";

export type { SessionMutationTarget } from "./session-mutation-authorization-error.js";

export function resolveDirectSessionTargets(
  method: string,
  params: unknown,
): SessionMutationTarget[] {
  if (method === "sessions.create" || method === "sessions.list") {
    return [];
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const record = params as Record<string, unknown>;
  const candidates = [record.key, record.sessionKey];
  if (Array.isArray(record.keys)) {
    candidates.push(...record.keys);
  }
  if (Array.isArray(record.sessionKeys)) {
    candidates.push(...record.sessionKeys);
  }
  const agentId = normalizeOptionalString(record.agentId);
  return candidates.flatMap((candidate): SessionMutationTarget[] =>
    typeof candidate === "string"
      ? [{ sessionKey: candidate, ...(agentId ? { agentId } : {}) }]
      : [],
  );
}

export function resolveDirectIncognitoTargets(
  method: string,
  params: unknown,
): SessionMutationTarget[] {
  return resolveDirectSessionTargets(method, params).filter((target) =>
    isIncognitoSessionKey(
      canonicalizeSessionKeyForAgent(target.agentId ?? DEFAULT_AGENT_ID, target.sessionKey),
    ),
  );
}

function readSessionSharingStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  return normalizeOptionalString((params as Record<string, unknown>)[key]);
}

function resolveSessionGroupMutationTargets(params: {
  getCfg: () => OpenClawConfig;
  requestParams: unknown;
}): SessionMutationTarget[] | undefined {
  const groupName = readSessionSharingStringParam(params.requestParams, "name");
  return groupName
    ? (resolveSessionGroupMutationTargetsByName(params.getCfg()).get(groupName) ?? [])
    : undefined;
}

function resolveSessionGroupsPutMutationTargets(
  getCfg: () => OpenClawConfig,
  requestParams: unknown,
): SessionMutationTarget[] | undefined {
  const names =
    requestParams && typeof requestParams === "object" && "names" in requestParams
      ? requestParams.names
      : undefined;
  if (!Array.isArray(names)) {
    return undefined;
  }
  const requested = new Set(normalizeGroupNames(names.filter((name) => typeof name === "string")));
  const dropped = listSessionGroups()
    .map((group) => group.name)
    .filter((name) => !requested.has(name));
  if (dropped.length === 0) {
    return [];
  }
  const byName = resolveSessionGroupMutationTargetsByName(getCfg());
  return dropped.flatMap((name) => byName.get(name) ?? []);
}

function resolveApprovalSessionTarget(
  method: string,
  params: unknown,
  context: GatewayRequestContext,
): SessionMutationTarget | undefined {
  const id = readSessionSharingStringParam(params, "id");
  if (!id) {
    return undefined;
  }
  const kind = readSessionSharingStringParam(params, "kind");
  const manager =
    method === "plugin.approval.resolve" || kind === "plugin"
      ? context.pluginApprovalManager
      : method === "approval.resolve" && kind === "system-agent"
        ? context.systemAgentApprovalManager
        : context.execApprovalManager;
  const resolvedId = manager?.lookupApprovalId(id, { includeResolved: true });
  const recordId =
    resolvedId?.kind === "exact" || resolvedId?.kind === "prefix" ? resolvedId.id : id;
  const request = manager?.getSnapshot(recordId)?.request;
  const sessionKey = readSessionSharingStringParam(request, "sessionKey");
  const agentId = readSessionSharingStringParam(request, "agentId");
  return sessionKey
    ? {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      }
    : undefined;
}

/** Realtime creates authorize their effective default; transcription stays sessionless. */
export function resolveTalkSessionTargetInput(
  method: string,
  params: unknown,
  connId?: string,
):
  | { kind: "request"; sessionKey?: string }
  | ({ kind: "relay" } & NonNullable<ReturnType<typeof resolveUnifiedTalkSessionTarget>>)
  | undefined {
  if (method === "talk.session.steer") {
    const sessionId = readSessionSharingStringParam(params, "sessionId");
    const retained = sessionId ? resolveUnifiedTalkSessionTarget(sessionId, connId) : undefined;
    return retained ? { kind: "relay", ...retained } : undefined;
  }
  if (
    method !== "talk.client.create" &&
    method !== "talk.client.toolCall" &&
    method !== "talk.session.create" &&
    method !== "talk.client.transcript" &&
    method !== "talk.client.close" &&
    method !== "talk.client.steer"
  ) {
    return undefined;
  }
  const sessionKey = readSessionSharingStringParam(params, "sessionKey");
  if (sessionKey) {
    return { kind: "request", sessionKey };
  }
  if (method === "talk.client.create") {
    return { kind: "request" };
  }
  if (
    method === "talk.session.create" &&
    (readSessionSharingStringParam(params, "mode") ?? "realtime") === "realtime" &&
    readSessionSharingStringParam(params, "transport") !== "managed-room"
  ) {
    return { kind: "request" };
  }
  return undefined;
}

export function resolveSessionMutationTargets(params: {
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  getCfg: () => OpenClawConfig;
}): SessionMutationTarget[] | undefined {
  if (params.method === "sessions.patchMany") {
    const targets =
      params.requestParams &&
      typeof params.requestParams === "object" &&
      "targets" in params.requestParams
        ? params.requestParams.targets
        : undefined;
    return Array.isArray(targets)
      ? targets.slice(0, 101).flatMap((target): SessionMutationTarget[] => {
          const sessionKey = readSessionSharingStringParam(target, "key");
          const agentId = readSessionSharingStringParam(target, "agentId");
          return sessionKey ? [{ sessionKey, ...(agentId ? { agentId } : {}) }] : [];
        })
      : undefined;
  }
  if (
    params.method === "sessions.groups.rename" ||
    params.method === "sessions.groups.delete" ||
    params.method === "sessions.groups.update"
  ) {
    return resolveSessionGroupMutationTargets({
      getCfg: params.getCfg,
      requestParams: params.requestParams,
    });
  }
  if (params.method === "sessions.groups.put") {
    return resolveSessionGroupsPutMutationTargets(params.getCfg, params.requestParams);
  }
  if (isApprovalSessionTargetMethod(params.method)) {
    const target = resolveApprovalSessionTarget(
      params.method,
      params.requestParams,
      params.context,
    );
    return target ? [target] : undefined;
  }
  const requestedAgentId = readSessionSharingStringParam(params.requestParams, "agentId");
  const directTargets: SessionMutationTarget[] = [];
  for (const field of sessionMutationTargetFields(params.method)) {
    const sessionKey = readSessionSharingStringParam(params.requestParams, field);
    if (!sessionKey) {
      continue;
    }
    // sessions.create applies its selected agent to the parent only for the
    // unqualified global sentinels; other parents resolve their own store.
    const parentUsesRequestedAgent =
      field !== "parentSessionKey" || ["global", "unknown"].includes(sessionKey.toLowerCase());
    directTargets.push({
      sessionKey,
      ...(requestedAgentId && parentUsesRequestedAgent ? { agentId: requestedAgentId } : {}),
    });
  }
  if (directTargets.length) {
    return directTargets;
  }
  if (params.method === "board.event" || params.method === "board.action") {
    const ticket = readSessionSharingStringParam(params.requestParams, "ticket");
    const claims = ticket
      ? resolveAuthorizedBoardViewTicketClaims(ticket, { gatewayContext: params.context })
      : undefined;
    if (!claims || (requestedAgentId && requestedAgentId !== claims.agentId)) {
      return undefined;
    }
    return [
      {
        sessionKey: claims.sessionKey,
        ...(claims.agentId ? { agentId: claims.agentId } : {}),
      },
    ];
  }
  if (params.method !== "sessions.abort") {
    return undefined;
  }
  const runId = readSessionSharingStringParam(params.requestParams, "runId");
  const run = runId ? params.context.chatAbortControllers.get(runId) : undefined;
  return run
    ? [{ sessionKey: run.sessionKey, ...(run.agentId ? { agentId: run.agentId } : {}) }]
    : undefined;
}
