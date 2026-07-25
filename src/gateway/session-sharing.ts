import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSharingRole,
  type SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import {
  isSessionMember,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionEntry,
} from "../config/sessions.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { verifyBoardViewTicket } from "./board-view-ticket.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  invalidateSessionSharingSnapshot,
  loadCachedSessionSharingSnapshot,
  type SessionSharingSnapshot,
} from "./session-sharing-snapshot-cache.js";
import {
  resolveFreshestSessionStoreMatchFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

const ADMIN_SCOPE = "operator.admin";

type SessionSharingTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storeKey: string;
  storePath: string;
};

type SessionMutationTarget = {
  sessionKey: string;
  agentId?: string;
};

type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Pick<
    SessionSharingTarget,
    "agentId" | "canonicalKey" | "storeKey" | "storePath"
  > | null;
  sessionId: string | null;
};

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

export { invalidateSessionSharingSnapshot };

export function resolveSessionVisibility(
  entry: Pick<SessionEntry, "visibility">,
): SessionVisibility {
  return entry.visibility ?? "shared";
}

export function isGatewayAdmin(client: Pick<GatewayClient, "connect"> | null): boolean {
  // Internal/plugin-runtime runs reach authorization with a client that has no
  // connect handshake; treat a connect-less client as a non-admin, never a crash.
  return client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;
}

export function allowedSessionVisibilities(cfg: OpenClawConfig): SessionVisibility[] {
  const policy = cfg.session?.sharing;
  return [
    "shared",
    ...(policy?.readOnly === false ? [] : (["read-only"] as const)),
    ...(policy?.suggest === false ? [] : (["suggest"] as const)),
    ...(policy?.drafts === false ? [] : (["draft"] as const)),
  ];
}

export function isSessionVisibilityAllowed(
  cfg: OpenClawConfig,
  visibility: SessionVisibility,
): boolean {
  return allowedSessionVisibilities(cfg).includes(visibility);
}

export function resolveSessionSharingTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): SessionSharingTarget | null {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.sessionKey,
    agentId: params.agentId,
  });
  const match = resolveFreshestSessionStoreMatchFromStoreKeys(target.store, target.storeKeys);
  return match
    ? {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry: match.entry,
        storeKey: match.key,
        storePath: target.storePath,
      }
    : null;
}

export function resolveSessionSharingRole(params: {
  client: GatewayClient | null;
  target: SessionSharingTarget;
  includeMembership?: boolean;
  isMember?: boolean;
}): SessionSharingRole {
  if (isGatewayAdmin(params.client)) {
    return "admin";
  }
  const identity = gatewayClientSessionCreator(params.client);
  // Shared-secret/no-auth solo deployments have no durable person identity.
  if (!identity) {
    return "owner";
  }
  if (params.target.entry.createdActor?.id === identity.id) {
    return "owner";
  }
  if (params.isMember !== undefined) {
    return params.isMember ? "member" : "viewer";
  }
  if (params.includeMembership === false) {
    return "viewer";
  }
  if (
    isSessionMember(
      {
        agentId: params.target.agentId,
        sessionKey: params.target.storeKey,
        storePath: params.target.storePath,
      },
      identity.id,
    )
  ) {
    return "member";
  }
  return "viewer";
}

export function canManageSessionSharing(role: SessionSharingRole): boolean {
  return role === "admin" || role === "owner";
}

function canMutateSession(params: {
  role: SessionSharingRole;
  visibility: SessionVisibility;
}): boolean {
  // Drafts stay creator/admin-only; membership becomes active only after promotion.
  if (params.visibility === "draft") {
    return params.role === "admin" || params.role === "owner";
  }
  return params.visibility === "shared" || params.role !== "viewer";
}

function incognitoSessionNotFound(sessionKey: string): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, `Incognito session "${sessionKey}" was not found.`);
}

export function authorizeIncognitoSessionTarget(params: {
  client: GatewayClient | null;
  sessionKey: string;
  target: SessionSharingTarget | null;
}): ErrorShape | null {
  const incognito = params.target
    ? params.target.entry.incognito === true || isIncognitoSessionKey(params.target.canonicalKey)
    : isIncognitoSessionKey(params.sessionKey);
  if (!incognito) {
    return null;
  }
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const identity = gatewayClientSessionCreator(params.client);
  if (!identity) {
    return null;
  }
  return incognitoSessionNotFound(params.sessionKey);
}

export function canAccessIncognitoSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  return (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: params.sessionKey,
      target: resolveSessionSharingTarget(params),
    }) === null
  );
}

export function authorizeResolvedSessionMutation(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): ErrorShape | null {
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const target = resolveSessionSharingTarget(params);
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target,
  });
  if (incognitoError) {
    return incognitoError;
  }
  if (!target) {
    return null;
  }
  return authorizeSessionSharingTarget({ client: params.client, target });
}

export function authorizeSessionSharingTarget(params: {
  client: GatewayClient | null;
  target: SessionSharingTarget;
}): ErrorShape | null {
  const visibility = resolveSessionVisibility(params.target.entry);
  const role = resolveSessionSharingRole({ client: params.client, target: params.target });
  return canMutateSession({ role, visibility })
    ? null
    : errorShape(ErrorCodes.INVALID_REQUEST, `session is ${visibility} for this connection`, {
        details: {
          code: "SESSION_PARTICIPATION_REQUIRED",
          sessionKey: params.target.canonicalKey,
          visibility,
        },
      });
}

function resolveDirectIncognitoTargets(method: string, params: unknown): SessionMutationTarget[] {
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
    typeof candidate === "string" && isIncognitoSessionKey(candidate)
      ? [{ sessionKey: candidate, ...(agentId ? { agentId } : {}) }]
      : [],
  );
}

function readStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  return normalizeOptionalString((params as Record<string, unknown>)[key]);
}

const SESSION_KEY_PARAM_BY_METHOD = new Map<string, "key" | "sessionKey">([
  ["agent", "sessionKey"],
  ["board.event", "sessionKey"],
  ["board.update", "sessionKey"],
  ["board.widget.grant", "sessionKey"],
  ["board.widget.put", "sessionKey"],
  ["chat.abort", "sessionKey"],
  ["chat.inject", "sessionKey"],
  ["chat.send", "sessionKey"],
  ["message.action", "sessionKey"],
  ["plugins.sessionAction", "sessionKey"],
  ["send", "sessionKey"],
  ["session.discussion.open", "sessionKey"],
  ["sessions.abort", "key"],
  ["sessions.compaction.branch", "key"],
  ["sessions.compaction.restore", "key"],
  ["sessions.compact", "key"],
  ["sessions.delete", "key"],
  ["sessions.dispatch", "key"],
  ["sessions.files.set", "sessionKey"],
  ["sessions.fork", "key"],
  ["sessions.patch", "key"],
  ["sessions.pluginPatch", "key"],
  ["sessions.reclaim", "key"],
  ["sessions.reset", "key"],
  ["sessions.rewind", "key"],
  ["sessions.send", "key"],
  ["sessions.steer", "key"],
  ["sessions.branches.switch", "key"],
  ["tools.invoke", "sessionKey"],
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
  "session.discussion.open",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
]);

function resolveSessionGroupMutationTargets(params: {
  getCfg: () => OpenClawConfig;
  requestParams: unknown;
}): SessionMutationTarget[] | undefined {
  const groupName = readStringParam(params.requestParams, "name");
  if (!groupName) {
    return undefined;
  }
  return resolveAllAgentSessionStoreTargetsSync(params.getCfg()).flatMap((storeTarget) =>
    listSessionEntries({
      agentId: storeTarget.agentId,
      storePath: storeTarget.storePath,
    }).flatMap(({ sessionKey, entry }) =>
      entry.category?.trim() === groupName ? [{ sessionKey, agentId: storeTarget.agentId }] : [],
    ),
  );
}

function resolveApprovalSessionTarget(
  method: string,
  params: unknown,
  context: GatewayRequestContext,
): SessionMutationTarget | undefined {
  const id = readStringParam(params, "id");
  if (!id) {
    return undefined;
  }
  const kind = readStringParam(params, "kind");
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
  const sessionKey = readStringParam(request, "sessionKey");
  const agentId = readStringParam(request, "agentId");
  return sessionKey
    ? {
        sessionKey,
        ...(agentId ? { agentId } : {}),
      }
    : undefined;
}

function resolveSessionMutationTargets(params: {
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  getCfg: () => OpenClawConfig;
}): SessionMutationTarget[] | undefined {
  if (params.method === "sessions.groups.rename" || params.method === "sessions.groups.delete") {
    return resolveSessionGroupMutationTargets({
      getCfg: params.getCfg,
      requestParams: params.requestParams,
    });
  }
  if (
    params.method === "exec.approval.resolve" ||
    params.method === "plugin.approval.resolve" ||
    params.method === "approval.resolve"
  ) {
    const target = resolveApprovalSessionTarget(
      params.method,
      params.requestParams,
      params.context,
    );
    return target ? [target] : undefined;
  }
  const field = SESSION_KEY_PARAM_BY_METHOD.get(params.method);
  const directKey = field ? readStringParam(params.requestParams, field) : undefined;
  if (!directKey && (params.method === "board.event" || params.method === "board.action")) {
    const ticket = readStringParam(params.requestParams, "ticket");
    const claims = ticket ? verifyBoardViewTicket(ticket) : undefined;
    if (!claims) {
      return undefined;
    }
    const requestedAgentId = readStringParam(params.requestParams, "agentId");
    if (requestedAgentId && requestedAgentId !== claims.agentId) {
      return undefined;
    }
    return [
      {
        sessionKey: claims.sessionKey,
        ...(claims.agentId ? { agentId: claims.agentId } : {}),
      },
    ];
  }
  if (directKey || params.method !== "sessions.abort") {
    const agentId = readStringParam(params.requestParams, "agentId");
    return directKey
      ? [
          {
            sessionKey: directKey,
            ...(agentId ? { agentId } : {}),
          },
        ]
      : undefined;
  }
  const runId = readStringParam(params.requestParams, "runId");
  const run = runId ? params.context.chatAbortControllers.get(runId) : undefined;
  return run
    ? [{ sessionKey: run.sessionKey, ...(run.agentId ? { agentId: run.agentId } : {}) }]
    : undefined;
}

export function resolveSessionMutationAuthorization(params: {
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
}): { authorization?: SessionMutationAuthorization; error: ErrorShape | null } {
  if (isGatewayAdmin(params.client)) {
    return { error: null };
  }
  // Resolve runtime config at most once per request and only when a path needs it. The context
  // getter reloads/resolves gateway config, so non-session requests (the vast majority) must not
  // pay it. Group discovery and the authorization loop then share one snapshot, so a mid-request
  // config change cannot split target discovery from authorization.
  let cachedCfg: OpenClawConfig | undefined;
  const getCfg = (): OpenClawConfig => (cachedCfg ??= params.context.getRuntimeConfig());
  // Incognito direct reads and writes share this central participation choke point;
  // hidden keys use the stale-session refusal instead of revealing existence.
  for (const targetRef of resolveDirectIncognitoTargets(params.method, params.requestParams)) {
    const target = resolveSessionSharingTarget({
      cfg: getCfg(),
      sessionKey: targetRef.sessionKey,
      agentId: targetRef.agentId,
    });
    const error = authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: targetRef.sessionKey,
      target,
    });
    if (error) {
      return { error };
    }
  }
  const targetRefs = resolveSessionMutationTargets({
    method: params.method,
    requestParams: params.requestParams,
    context: params.context,
    getCfg,
  });
  if (!targetRefs) {
    if (REQUIRED_SESSION_TARGET_METHODS.has(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  const cfg = getCfg();
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const target = resolveSessionSharingTarget({
      cfg,
      sessionKey: targetRef.sessionKey,
      agentId: targetRef.agentId,
    });
    const error = target ? authorizeSessionSharingTarget({ client: params.client, target }) : null;
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
    });
  }
  return {
    error: null,
    authorization: (() => {
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
      ) => {
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
        });
        const sameResolvedTarget =
          expected === undefined ||
          (current === null
            ? expected.resolved === null
            : expected.resolved !== null &&
              current.agentId === expected.resolved.agentId &&
              current.canonicalKey === expected.resolved.canonicalKey &&
              current.storeKey === expected.resolved.storeKey &&
              current.storePath === expected.resolved.storePath &&
              (current.entry.sessionId?.trim() || null) === expected.sessionId);
        if (!sameResolvedTarget) {
          throw new SessionMutationAuthorizationChangedError(
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `session changed before ${params.method}; retry the request`,
              {
                details: {
                  code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                  method: params.method,
                  sessionKey: targetRef.sessionKey,
                },
              },
            ),
          );
        }
        if (!current) {
          return;
        }
        const error = authorizeSessionSharingTarget({ client: params.client, target: current });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      return {
        assertCurrent: () => {
          const currentCfg = params.context.getRuntimeConfig();
          for (const authorized of authorizedTargets) {
            assertTargetCurrent(authorized, authorized, currentCfg);
          }
        },
        assertTargetCurrent: (targetRef: SessionMutationTarget) => {
          const expected = authorizedTargets.find(
            (target) =>
              target.sessionKey === targetRef.sessionKey && target.agentId === targetRef.agentId,
          );
          assertTargetCurrent(targetRef, expected, params.context.getRuntimeConfig());
        },
      };
    })(),
  };
}

function loadSharingSnapshot(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId?: string,
): SessionSharingSnapshot {
  return loadCachedSessionSharingSnapshot({
    agentId,
    sessionKey,
    resolve: () => {
      const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId });
      return {
        canonicalKey: target?.canonicalKey ?? sessionKey,
        canonicalAgentId: target?.agentId ?? agentId,
        snapshot: {
          // Missing rows occur after deletion. Fail closed here; the delete path also
          // emits an unscoped catalog invalidation so identified readers still refresh.
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          ...(target ? { creatorId: target.entry.createdActor?.id } : {}),
        },
      };
    },
  });
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  client: GatewayWsClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  const identity = gatewayClientSessionCreator(params.client);
  if (!identity) {
    return params.event !== "session.suggestion" && params.event !== "session.typing";
  }
  const visible = params.sessionKeys.every((sessionKey) => {
    const snapshot = loadSharingSnapshot(params.cfg, sessionKey, params.agentId);
    if (snapshot.incognito) {
      return false;
    }
    if (snapshot.visibility !== "draft" || snapshot.creatorId === identity.id) {
      return true;
    }
    if (params.event !== "session.typing") {
      return false;
    }
    const target = resolveSessionSharingTarget({
      cfg: params.cfg,
      sessionKey,
      agentId: params.agentId,
    });
    return (
      target !== null &&
      canManageSessionSharing(resolveSessionSharingRole({ client: params.client, target }))
    );
  });
  if (!visible || params.event !== "session.suggestion") {
    return visible;
  }
  const authorId =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id
      : undefined;
  if (authorId === identity.id) {
    return true;
  }
  return params.sessionKeys.every((sessionKey) => {
    const target = resolveSessionSharingTarget({
      cfg: params.cfg,
      sessionKey,
      agentId: params.agentId,
    });
    return (
      target !== null && resolveSessionSharingRole({ client: params.client, target }) !== "viewer"
    );
  });
}

export function filterDraftSessionsForClient(params: {
  client: GatewayClient | null;
  store: Record<string, SessionEntry>;
}): Record<string, SessionEntry> {
  const identity = gatewayClientSessionCreator(params.client);
  if (isGatewayAdmin(params.client) || !identity) {
    return params.store;
  }
  return Object.fromEntries(
    Object.entries(params.store).filter(([sessionKey, entry]) => {
      const owner = entry.createdActor?.id === identity.id;
      const incognito = entry.incognito === true || isIncognitoSessionKey(sessionKey);
      return !incognito && (owner || resolveSessionVisibility(entry) !== "draft");
    }),
  );
}
