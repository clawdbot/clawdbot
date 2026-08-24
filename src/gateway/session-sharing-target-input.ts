import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { verifyBoardViewTicket } from "./board-view-ticket.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";

export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
): Map<string, SessionMutationTarget[]> {
  const targetsByName = new Map<string, SessionMutationTarget[]>();
  for (const storeTarget of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    for (const { sessionKey, entry } of listSessionEntriesCore({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
    })) {
      const groupName = normalizeOptionalString(entry.category);
      if (!groupName) {
        continue;
      }
      const targets = targetsByName.get(groupName) ?? [];
      targets.push({ sessionKey, agentId: storeTarget.agentId });
      targetsByName.set(groupName, targets);
    }
  }
  return targetsByName;
}

export type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

type SessionMutationTargetField = "key" | "parentSessionKey" | "sessionKey";

const SESSION_TARGET_FIELDS_BY_METHOD = new Map<string, readonly SessionMutationTargetField[]>([
  ["agent", ["sessionKey"]],
  ["board.event", ["sessionKey"]],
  ["board.update", ["sessionKey"]],
  ["board.widget.grant", ["sessionKey"]],
  ["board.widget.put", ["sessionKey"]],
  ["chat.abort", ["sessionKey"]],
  ["chat.inject", ["sessionKey"]],
  ["chat.send", ["sessionKey"]],
  ["mcp.app.callTool", ["sessionKey"]],
  ["mcp.app.updateModelContext", ["sessionKey"]],
  ["message.action", ["sessionKey"]],
  ["plugins.sessionAction", ["sessionKey"]],
  ["progressCard.get", ["sessionKey"]],
  ["progressCard.put", ["sessionKey"]],
  ["send", ["sessionKey"]],
  ["session.discussion.open", ["sessionKey"]],
  ["sessions.abort", ["key"]],
  ["sessions.assignOwner", ["key"]],
  ["sessions.companion.ask", ["sessionKey"]],
  ["sessions.companion.reset", ["sessionKey"]],
  ["sessions.companion.state", ["sessionKey"]],
  ["sessions.compaction.branch", ["key"]],
  ["sessions.compaction.restore", ["key"]],
  ["sessions.compact", ["key"]],
  ["sessions.create", ["key", "parentSessionKey"]],
  ["sessions.delete", ["key"]],
  ["sessions.dispatch", ["key"]],
  ["sessions.files.set", ["sessionKey"]],
  ["sessions.github.publish", ["sessionKey"]],
  ["sessions.fork", ["sessionKey"]],
  ["sessions.patch", ["key"]],
  ["sessions.pluginPatch", ["key"]],
  ...(["sessions.move", "sessions.reclaim"] as const).map((method) => [method, ["key"]] as const),
  ["sessions.recover", ["key"]],
  ["sessions.reset", ["key"]],
  ["sessions.rewind", ["sessionKey"]],
  ["sessions.send", ["key"]],
  ["sessions.steer", ["key"]],
  ["sessions.branches.switch", ["sessionKey"]],
  ...(
    [
      "taskSuggestions.create",
      "talk.client.close",
      "talk.client.create",
      "talk.client.steer",
      "talk.client.toolCall",
      "talk.client.transcript",
      "talk.session.create",
      "talk.session.steer",
      "wake",
    ] as const
  ).map((method) => [method, ["sessionKey"]] as const),
  ["tools.invoke", ["sessionKey"]],
]);

const REQUIRED_SESSION_TARGET_METHODS = new Set([
  "board.action",
  "board.event",
  "board.update",
  "board.widget.grant",
  "board.widget.put",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "mcp.app.callTool",
  "mcp.app.updateModelContext",
  "progressCard.get",
  "progressCard.put",
  "session.discussion.open",
  "sessions.abort",
  "sessions.assignOwner",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.companion.reset",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.github.publish",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.recover",
  "sessions.move",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
  "talk.client.close",
  "talk.client.steer",
  "talk.client.toolCall",
  "talk.client.transcript",
  "taskSuggestions.create",
]);

const APPROVAL_SESSION_TARGET_METHODS = new Set([
  "approval.resolve",
  "exec.approval.resolve",
  "plugin.approval.resolve",
]);

const READ_ONLY_SESSION_TARGET_METHODS = new Set([
  "sessions.companion.ask",
  "sessions.companion.state",
]);

const LEGACY_PROFILE_INDEPENDENT_MUTATION_METHODS = new Set([
  "talk.client.close",
  "talk.client.create",
  "talk.client.steer",
  "talk.client.toolCall",
  "talk.client.transcript",
  "talk.session.create",
  "talk.session.steer",
  "wake",
]);

export function sessionMutationTargetFields(method: string): readonly SessionMutationTargetField[] {
  return READ_ONLY_SESSION_TARGET_METHODS.has(method)
    ? []
    : (SESSION_TARGET_FIELDS_BY_METHOD.get(method) ?? []);
}

export function isRequiredSessionTargetMethod(method: string): boolean {
  return REQUIRED_SESSION_TARGET_METHODS.has(method);
}

function isApprovalSessionTargetMethod(method: string): boolean {
  return APPROVAL_SESSION_TARGET_METHODS.has(method);
}

export function isSessionProfileDependentMethod(method: string): boolean {
  if (LEGACY_PROFILE_INDEPENDENT_MUTATION_METHODS.has(method)) {
    return false;
  }
  return (
    SESSION_TARGET_FIELDS_BY_METHOD.has(method) ||
    REQUIRED_SESSION_TARGET_METHODS.has(method) ||
    APPROVAL_SESSION_TARGET_METHODS.has(method) ||
    method === "sessions.patchMany"
  );
}

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
    const claims = ticket ? verifyBoardViewTicket(ticket) : undefined;
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
