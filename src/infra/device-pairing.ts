// Manages device pairing requests, approvals, and token issuance.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  resolveDeviceProfileRoleScopes,
  resolveDeviceProfileScopes,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "../shared/operator-scope-compat.js";
import { revokeDeviceBootstrapTokensForDevice } from "./device-bootstrap.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState as persistState,
} from "./device-pairing-store.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRecord,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDeviceApprovalKind,
} from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

export type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDevicePendingNodeSurface,
} from "./device-pairing.types.js";

/** Pending request summary returned when a replacement supersedes older requests. */
type DevicePairingSupersededRequest = Pick<DevicePairingPendingRequest, "requestId" | "deviceId">;

/** Result for creating or refreshing a pending device pairing request. */
type RequestDevicePairingResult = {
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
  superseded?: DevicePairingSupersededRequest[];
};

/** Redacted token metadata safe for list/status responses. */
export type DeviceAuthTokenSummary = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

/** Deny reasons returned when rotating an existing paired-device token. */
export type RotateDeviceTokenDenyReason =
  | "unknown-device-or-role"
  | "missing-approved-scope-baseline"
  | "scope-outside-approved-baseline"
  | "caller-missing-scope";

/** Token rotation result with the replacement token entry on success. */
type RotateDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RotateDeviceTokenDenyReason; scope?: string };

export type RevokeDeviceTokenDenyReason = "unknown-device-or-role" | "caller-missing-scope";

/** Token revocation result with the revoked entry on success. */
type RevokeDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RevokeDeviceTokenDenyReason; scope?: string };

/** Metadata fields a device may refresh without changing approval or token state. */
type PairedDeviceMetadataPatch = Pick<
  PairedDevice,
  | "displayName"
  | "operatorLabel"
  | "platform"
  | "clientId"
  | "clientMode"
  | "remoteIp"
  | "lastSeenAtMs"
  | "lastSeenReason"
>;

/** Paired-device access metadata refreshed when an existing device reconnects. */
type DevicePairingAccessMetadata = Pick<
  PairedDevice,
  "displayName" | "remoteIp" | "lastSeenAtMs" | "lastSeenReason"
>;

/** Combined pending/paired view returned by pairing list APIs. */
type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

/** Authorization failure categories for owner approval and bootstrap approval flows. */
type DevicePairingForbiddenReason =
  | "caller-scopes-required"
  | "caller-missing-scope"
  | "scope-outside-requested-roles"
  | "bootstrap-role-not-allowed"
  | "bootstrap-scope-not-allowed";

/** Structured forbidden result with the missing/disallowed role or scope when known. */
type DevicePairingForbiddenResult = {
  status: "forbidden";
  reason: DevicePairingForbiddenReason;
  scope?: string;
  role?: string;
};

/** Pairing approval outcome: approved, forbidden with reason, or request not found. */
type ApproveDevicePairingResult =
  | { status: "approved"; requestId: string; device: PairedDevice }
  | DevicePairingForbiddenResult
  | null;

type DevicePairingStateFile = {
  pendingById: Record<string, DevicePairingPendingRecord>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";
const SHARED_GATEWAY_AUTH_ISSUER_KIND = "shared-gateway-auth";
const BROWSER_DEVICE_CLIENT_IDS = new Set(["openclaw-control-ui", "webchat-ui"]);
const BROWSER_DEVICE_CLIENT_MODE = "webchat";

const withLock = createAsyncLock();

/** Format a device-pairing authorization failure for CLI/API callers. */
export function formatDevicePairingForbiddenMessage(result: DevicePairingForbiddenResult): string {
  switch (result.reason) {
    case "caller-scopes-required":
      return `missing scope: ${result.scope ?? "callerScopes-required"}`;
    case "caller-missing-scope":
      return `missing scope: ${result.scope ?? "unknown"}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${result.scope ?? "unknown"}`;
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${result.role ?? "unknown"}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${result.scope ?? "unknown"}`;
  }
  throw new Error("Unsupported device pairing forbidden reason");
}

async function loadState(baseDir?: string): Promise<DevicePairingStateFile> {
  const state: DevicePairingStateFile = loadDevicePairingStoreState(baseDir);
  const now = Date.now();
  pruneExpiredPending(state.pendingById, now, PENDING_TTL_MS);
  // Pending node-surface requests share the pairing TTL; requests refresh
  // their ts on reconnect so an actively retrying node keeps one alive.
  for (const device of Object.values(state.pairedByDeviceId)) {
    if (device.pendingNodeSurface && now - device.pendingNodeSurface.ts > PENDING_TTL_MS) {
      delete device.pendingNodeSurface;
    }
  }
  return state;
}

/**
 * Internal seam for the node-surface module (node-pairing.ts): run one
 * operation against the paired-device records under the shared pairing lock.
 * Return `persist: true` to write the paired store after the mutation. Not a
 * public API — node surface state lives inside device records, and both
 * modules must serialize through the same lock to avoid lost updates.
 */
export async function withPairedDeviceRecords<T>(
  baseDir: string | undefined,
  operate: (
    pairedByDeviceId: Record<string, PairedDevice>,
  ) => { value: T; persist: boolean } | Promise<{ value: T; persist: boolean }>,
): Promise<T> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const outcome = await operate(state.pairedByDeviceId);
    if (outcome.persist) {
      persistState(state, baseDir, "paired");
    }
    return outcome.value;
  });
}

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function normalizeRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

function mergeRoles(...items: Array<string | string[] | undefined>): string[] | undefined {
  const roles = new Set<string>();
  for (const item of items) {
    for (const role of normalizeUniqueSingleOrTrimmedStringList(item)) {
      roles.add(role);
    }
  }
  if (roles.size === 0) {
    return undefined;
  }
  return [...roles];
}

function listActiveTokenRoles(
  tokens: Record<string, DeviceAuthToken> | undefined,
): string[] | undefined {
  if (!tokens) {
    return undefined;
  }
  return mergeRoles(
    Object.values(tokens)
      .filter((entry) => !entry.revokedAtMs)
      .map((entry) => entry.role),
  );
}

/** List the durable roles an owner approved for a paired device record. */
export function listApprovedPairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles">,
): string[] {
  // Approved roles come from the pairing record itself. This is the durable
  // contract the owner approved, independent of any currently active tokens.
  return mergeRoles(device.roles, device.role) ?? [];
}

/** List active-token roles, bounded by the durable approved pairing roles. */
export function listEffectivePairedDeviceRoles(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
): string[] {
  const activeTokenRoles = listActiveTokenRoles(device.tokens);
  if (activeTokenRoles && activeTokenRoles.length > 0) {
    // Effective roles are the active token roles, bounded by the approved
    // pairing contract. A stray token entry must not grant new access.
    const approvedRoles = new Set(listApprovedPairedDeviceRoles(device));
    return activeTokenRoles.filter((role) => approvedRoles.has(role));
  }
  // Token entries are authoritative. Tokenless legacy records fail closed so
  // sticky historical role fields cannot retain access after token migration.
  return [];
}

/** Return whether a paired device currently has an active token for one role. */
export function hasEffectivePairedDeviceRole(
  device: Pick<PairedDevice, "role" | "roles" | "tokens">,
  role: string,
): boolean {
  const normalized = normalizeRole(role);
  if (!normalized) {
    return false;
  }
  return listEffectivePairedDeviceRoles(device).includes(normalized);
}

function mergeScopes(...items: Array<string[] | undefined>): string[] | undefined {
  const scopes = new Set<string>();
  let sawExplicitScopeList = false;
  for (const item of items) {
    if (!Array.isArray(item)) {
      continue;
    }
    sawExplicitScopeList = true;
    for (const scope of normalizeUniqueSingleOrTrimmedStringList(item)) {
      scopes.add(scope);
    }
  }
  if (scopes.size === 0) {
    return sawExplicitScopeList ? [] : undefined;
  }
  return [...scopes];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  for (const value of left) {
    if (!rightSet.has(value)) {
      return false;
    }
  }
  return true;
}

function resolveRequestedRoles(input: { role?: string; roles?: string[] }): string[] {
  return mergeRoles(input.roles, input.role) ?? [];
}

function resolveRequestedScopes(input: { scopes?: string[] }): string[] {
  return normalizeDeviceAuthScopes(input.scopes);
}

function samePendingApprovalSnapshot(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeRole(existing.role) !== normalizeRole(incoming.role)) {
    return false;
  }
  if (
    !sameStringSet(resolveRequestedRoles(existing), resolveRequestedRoles(incoming)) ||
    !sameStringSet(resolveRequestedScopes(existing), resolveRequestedScopes(incoming))
  ) {
    return false;
  }
  return true;
}

function isStringSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const supersetSet = new Set(superset);
  for (const value of subset) {
    if (!supersetSet.has(value)) {
      return false;
    }
  }
  return true;
}

// True when the incoming request only asks for roles/scopes a single existing pending
// request (same key + role) already covers. Such subset re-requests refresh in place so
// the owner's listed requestId stays valid; escalations still supersede with a fresh id.
function incomingApprovalCoveredByExisting(
  existing: DevicePairingPendingRequest,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
): boolean {
  if (existing.publicKey !== incoming.publicKey) {
    return false;
  }
  if (existing.browserOrigin !== incoming.browserOrigin) {
    return false;
  }
  if (normalizeRole(existing.role) !== normalizeRole(incoming.role)) {
    return false;
  }
  const incomingRoles = resolveRequestedRoles(incoming);
  if (!isStringSubset(incomingRoles, resolveRequestedRoles(existing))) {
    return false;
  }
  const existingScopes = resolveRequestedScopes(existing);
  for (const scope of resolveRequestedScopes(incoming)) {
    const covered = incomingRoles.some((role) =>
      roleScopesAllow({
        role,
        requestedScopes: [scope],
        allowedScopes: existingScopes,
      }),
    );
    if (!covered) {
      return false;
    }
  }
  return true;
}

function refreshPendingDevicePairingRequest(
  existing: DevicePairingPendingRecord,
  incoming: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  isRepair: boolean,
): DevicePairingPendingRecord {
  return {
    ...existing,
    publicKey: incoming.publicKey,
    displayName: incoming.displayName ?? existing.displayName,
    platform: incoming.platform ?? existing.platform,
    deviceFamily: incoming.deviceFamily ?? existing.deviceFamily,
    clientId: incoming.clientId ?? existing.clientId,
    clientMode: incoming.clientMode ?? existing.clientMode,
    browserOrigin: existing.browserOrigin,
    remoteIp: incoming.remoteIp ?? existing.remoteIp,
    // If either request is interactive, keep the pending request visible for approval.
    silent: Boolean(existing.silent && incoming.silent),
    isRepair: existing.isRepair || isRepair,
    // Preserve the original creation timestamp so that reconnects cannot bump this
    // request's queue position. Using Date.now() here would let an attacker silently
    // refresh recency and win the implicit --latest approval race.
    ts: existing.ts,
    // Keepalive for the pending TTL only (see pruneExpiredPending); never affects ordering.
    refreshedAtMs: Date.now(),
  };
}

function resolveSupersededPendingSilent(params: {
  existing: readonly DevicePairingPendingRequest[];
  incomingSilent: boolean | undefined;
}): boolean {
  return Boolean(
    params.incomingSilent && params.existing.every((pending) => pending.silent === true),
  );
}

function toPublicPendingDevicePairingRequest(
  pending: DevicePairingPendingRecord,
): DevicePairingPendingRequest {
  const { refreshedAtMs: _refreshedAtMs, ...request } = pending;
  return request;
}

function buildPendingDevicePairingRequest(params: {
  requestId?: string;
  deviceId: string;
  isRepair: boolean;
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
}): DevicePairingPendingRequest {
  const role = normalizeRole(params.req.role) ?? undefined;
  return {
    requestId: params.requestId ?? randomUUID(),
    deviceId: params.deviceId,
    publicKey: params.req.publicKey,
    displayName: params.req.displayName,
    platform: params.req.platform,
    deviceFamily: params.req.deviceFamily,
    clientId: params.req.clientId,
    clientMode: params.req.clientMode,
    browserOrigin: params.req.browserOrigin,
    role,
    roles: mergeRoles(params.req.roles, role),
    scopes: mergeScopes(params.req.scopes),
    remoteIp: params.req.remoteIp,
    silent: params.req.silent,
    isRepair: params.isRepair,
    ts: Date.now(),
  };
}

function newToken() {
  return generatePairingToken();
}

function getPairedDeviceFromState(
  state: DevicePairingStateFile,
  deviceId: string,
): PairedDevice | null {
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

function cloneDeviceTokens(device: PairedDevice): Record<string, DeviceAuthToken> {
  return device.tokens ? { ...device.tokens } : {};
}

function isBrowserRelatedPairedDevice(device: Pick<PairedDevice, "clientId" | "clientMode">) {
  const clientMode = device.clientMode?.trim().toLowerCase();
  if (clientMode === BROWSER_DEVICE_CLIENT_MODE) {
    return true;
  }
  const clientId = device.clientId?.trim().toLowerCase();
  return clientId ? BROWSER_DEVICE_CLIENT_IDS.has(clientId) : false;
}

function deviceTokenIssuerMatches(
  entry: DeviceAuthToken,
  issuer: DeviceAuthToken["issuer"] | undefined,
): boolean {
  if (!issuer) {
    return !entry.issuer;
  }
  return entry.issuer?.kind === issuer.kind && entry.issuer.generation === issuer.generation;
}

function buildDeviceAuthToken(params: {
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  existing?: DeviceAuthToken;
  preserveExistingIssuer?: boolean;
  now: number;
  rotatedAtMs?: number;
}): DeviceAuthToken {
  return {
    token: newToken(),
    role: params.role,
    scopes: params.scopes,
    issuer: params.issuer ?? (params.preserveExistingIssuer ? params.existing?.issuer : undefined),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    rotatedAtMs: params.rotatedAtMs,
    revokedAtMs: undefined,
    lastUsedAtMs: params.existing?.lastUsedAtMs,
  };
}

// Interactive approvals must stay sticky: a later silent repair/re-approve of the
// same device id cannot downgrade an owner/bootstrap record into prune-eligible
// state. Pre-provenance records (approvedVia undefined) may have been approved by
// an owner, so a non-interactive re-approve must keep them protected (undefined).
function mergeApprovalKind(
  existing: PairedDevice | undefined,
  incoming: PairedDeviceApprovalKind,
): PairedDeviceApprovalKind | undefined {
  if (incoming === "owner" || !existing) {
    return incoming;
  }
  if (existing.approvedVia === undefined) {
    return incoming === "bootstrap" ? "bootstrap" : undefined;
  }
  if (existing.approvedVia === "owner" || existing.approvedVia === "bootstrap") {
    return existing.approvedVia;
  }
  return incoming;
}

function buildApprovedPairedDevice(params: {
  pending: DevicePairingPendingRequest;
  existing: PairedDevice | undefined;
  roles: string[] | undefined;
  approvedScopes: string[] | undefined;
  tokens: Record<string, DeviceAuthToken>;
  now: number;
  approvedVia: PairedDeviceApprovalKind;
  accessMetadata?: DevicePairingAccessMetadata;
}): PairedDevice {
  return {
    deviceId: params.pending.deviceId,
    publicKey: params.pending.publicKey,
    displayName: params.accessMetadata?.displayName ?? params.pending.displayName,
    platform: params.pending.platform,
    deviceFamily: params.pending.deviceFamily,
    clientId: params.pending.clientId,
    clientMode: params.pending.clientMode,
    browserOrigin: params.pending.browserOrigin,
    role: params.pending.role,
    roles: params.roles,
    scopes: params.approvedScopes,
    approvedScopes: params.approvedScopes,
    remoteIp: params.accessMetadata?.remoteIp ?? params.pending.remoteIp,
    tokens: params.tokens,
    approvedVia: mergeApprovalKind(params.existing, params.approvedVia),
    // Node capability approvals ride on the device record; device repair or
    // role re-approval must not silently revoke an approved node surface.
    ...(params.existing?.nodeSurface ? { nodeSurface: params.existing.nodeSurface } : {}),
    ...(params.existing?.pendingNodeSurface
      ? { pendingNodeSurface: params.existing.pendingNodeSurface }
      : {}),
    // Operator-assigned label is owner-side state; device repair or role
    // re-approval must not silently drop it.
    ...(params.existing?.operatorLabel ? { operatorLabel: params.existing.operatorLabel } : {}),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    approvedAtMs: params.now,
    lastSeenAtMs: params.accessMetadata?.lastSeenAtMs ?? params.existing?.lastSeenAtMs,
    lastSeenReason: params.accessMetadata?.lastSeenReason ?? params.existing?.lastSeenReason,
  };
}

function resolveRoleScopedDeviceTokenScopes(role: string, scopes: string[] | undefined): string[] {
  const normalized = normalizeDeviceAuthScopes(scopes);
  if (role === "operator") {
    return normalized.filter((scope) => scope.startsWith(OPERATOR_SCOPE_PREFIX));
  }
  return normalized.filter((scope) => !scope.startsWith(OPERATOR_SCOPE_PREFIX));
}

function preserveRoleScopedApprovalScopes(role: string, scopes: string[] | undefined): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(scopes).filter((scope) =>
    role === OPERATOR_ROLE
      ? scope.startsWith(OPERATOR_SCOPE_PREFIX)
      : !scope.startsWith(OPERATOR_SCOPE_PREFIX),
  );
}

function resolveApprovedTokenScopes(params: {
  role: string;
  pending: DevicePairingPendingRequest;
  existingToken?: DeviceAuthToken;
  approvedScopes?: string[];
  existing?: PairedDevice;
}): string[] {
  const pendingScopes = resolveRoleScopedDeviceTokenScopes(params.role, params.pending.scopes);
  if (pendingScopes.length > 0) {
    const approvedBaseline = resolveRoleScopedDeviceTokenScopes(
      params.role,
      params.existing?.approvedScopes ?? params.existing?.scopes,
    );
    const requestedScopeDelta =
      params.existingToken && approvedBaseline.length > 0
        ? pendingScopes.filter((scope) => !approvedBaseline.includes(scope))
        : pendingScopes;
    if (requestedScopeDelta.length === 0 && params.existingToken) {
      return resolveRoleScopedDeviceTokenScopes(params.role, params.existingToken.scopes);
    }
    return resolveRoleScopedDeviceTokenScopes(
      params.role,
      mergeScopes(params.existingToken?.scopes, requestedScopeDelta),
    );
  }
  return resolveRoleScopedDeviceTokenScopes(
    params.role,
    params.existingToken?.scopes ??
      params.approvedScopes ??
      params.existing?.approvedScopes ??
      params.existing?.scopes,
  );
}

function resolveApprovedDeviceScopeBaseline(device: PairedDevice): string[] | null {
  const baseline = device.approvedScopes ?? device.scopes;
  if (!Array.isArray(baseline)) {
    return null;
  }
  return normalizeDeviceAuthScopes(baseline);
}

function scopesWithinApprovedDeviceBaseline(params: {
  role: string;
  scopes: readonly string[];
  approvedScopes: readonly string[] | null;
}): boolean {
  if (!params.approvedScopes) {
    return false;
  }
  return roleScopesAllow({
    role: params.role,
    requestedScopes: params.scopes,
    allowedScopes: params.approvedScopes,
  });
}

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById)
    .map(toPublicPendingDevicePairingRequest)
    .toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

/** Return one paired device by normalized device id. */
export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<PairedDevice | null> {
  const state = await loadState(baseDir);
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

/** Return one pending pairing request by request id. */
export async function getPendingDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<DevicePairingPendingRequest | null> {
  const state = await loadState(baseDir);
  const pending = state.pendingById[requestId];
  return pending ? toPublicPendingDevicePairingRequest(pending) : null;
}

/** Result shape for creating or refreshing a pending pairing request. */
type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

/** Refresh one compatible pending request or replace a superseded request set atomically. */
function reconcilePendingPairingRequests<
  TPending extends { requestId: string },
  TIncoming,
>(params: {
  pendingById: Record<string, TPending>;
  existing: readonly TPending[];
  incoming: TIncoming;
  canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
  refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
  buildReplacement: (params: { existing: readonly TPending[]; incoming: TIncoming }) => TPending;
  persist: () => void;
}): PendingPairingRequestResult<TPending> {
  if (
    params.existing.length === 1 &&
    params.canRefreshSingle(
      expectDefined(params.existing[0], "existing entry at 0"),
      params.incoming,
    )
  ) {
    const refreshed = params.refreshSingle(
      expectDefined(params.existing[0], "existing entry at 0"),
      params.incoming,
    );
    params.pendingById[refreshed.requestId] = refreshed;
    params.persist();
    return { status: "pending", request: refreshed, created: false };
  }

  for (const existing of params.existing) {
    delete params.pendingById[existing.requestId];
  }

  const request = params.buildReplacement({
    existing: params.existing,
    incoming: params.incoming,
  });
  params.pendingById[request.requestId] = request;
  params.persist();
  return { status: "pending", request, created: true };
}

/** Create or refresh a pending device pairing request for owner approval. */
export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<RequestDevicePairingResult> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      throw new Error("deviceId required");
    }
    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const pendingForDevice = Object.values(state.pendingById)
      .filter((pending) => pending.deviceId === deviceId)
      .toSorted((left, right) => right.ts - left.ts);
    const result = reconcilePendingPairingRequests({
      pendingById: state.pendingById,
      existing: pendingForDevice,
      incoming: req,
      canRefreshSingle: (existing, incoming) =>
        samePendingApprovalSnapshot(existing, incoming) ||
        incomingApprovalCoveredByExisting(existing, incoming),
      refreshSingle: (existing, incoming) =>
        refreshPendingDevicePairingRequest(existing, incoming, isRepair),
      buildReplacement: ({ existing, incoming }) => {
        const latestPending = existing[0];
        const mergedRoles = mergeRoles(
          ...existing.flatMap((pending) => [pending.roles, pending.role]),
          incoming.roles,
          incoming.role,
        );
        const mergedScopes = mergeScopes(
          ...existing.map((pending) => pending.scopes),
          incoming.scopes,
        );
        return buildPendingDevicePairingRequest({
          deviceId,
          isRepair,
          req: {
            ...incoming,
            role: normalizeRole(incoming.role) ?? latestPending?.role,
            roles: mergedRoles,
            scopes: mergedScopes,
            // Preserve interactive visibility when superseding pending requests:
            // if any previous pending request was interactive, keep this one interactive.
            silent: resolveSupersededPendingSilent({
              existing,
              incomingSilent: incoming.silent,
            }),
          },
        });
      },
      persist: () => persistState(state, baseDir, "pending"),
    });
    // Surface superseded requestIds so callers can broadcast their resolution;
    // clients otherwise keep prompting for requests that can no longer be approved.
    const superseded = result.created
      ? pendingForDevice
          .filter((pending) => pending.requestId !== result.request.requestId)
          .map((pending) => ({ requestId: pending.requestId, deviceId: pending.deviceId }))
      : [];
    const publicResult = {
      ...result,
      request: toPublicPendingDevicePairingRequest(result.request),
    };
    return superseded.length > 0 ? { ...publicResult, superseded } : publicResult;
  });
}

/** Approve a pending request with optional caller-scope checks for operator grants. */
export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  options: {
    callerScopes?: readonly string[];
    accessMetadata?: DevicePairingAccessMetadata;
    approvedVia?: Extract<
      PairedDeviceApprovalKind,
      "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "ssh-verified"
    >;
    /**
     * Replace the pending scopes only for a brand-new operator device, or — under
     * trusted-proxy approval — for a known operator device re-requesting with its
     * already-paired public key. The live role set is rechecked under the pairing
     * lock so a merged request cannot inherit non-operator access through browser
     * auto-approval.
     */
    autoApproveNewDeviceScopes?: readonly string[];
  },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  optionsOrBaseDir?:
    | {
        callerScopes?: readonly string[];
        accessMetadata?: DevicePairingAccessMetadata;
        approvedVia?: Extract<
          PairedDeviceApprovalKind,
          "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "ssh-verified"
        >;
        autoApproveNewDeviceScopes?: readonly string[];
      }
    | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pendingRecord = state.pendingById[requestId];
    if (!pendingRecord) {
      return null;
    }
    const autoApproveScopes = options?.autoApproveNewDeviceScopes;
    const requestedRoles = resolveRequestedRoles(pendingRecord);
    const knownDevice = state.pairedByDeviceId[pendingRecord.deviceId];
    // Trusted-proxy connects carry an SSO-authenticated user, and the connect
    // handshake has already proven possession of the pending public key. A
    // matching key on the paired record is therefore the same physical device
    // re-requesting (typically a scope upgrade) and may auto-approve; a key
    // mismatch is a real repair — possibly a deviceId squat — and stays a
    // manual owner decision.
    const trustedProxySameKeyDevice =
      options?.approvedVia === "trusted-proxy" &&
      knownDevice !== undefined &&
      knownDevice.publicKey === pendingRecord.publicKey;
    if (
      autoApproveScopes &&
      (((pendingRecord.isRepair || knownDevice) && !trustedProxySameKeyDevice) ||
        !sameStringSet(requestedRoles, [OPERATOR_ROLE]))
    ) {
      return null;
    }
    const pending = autoApproveScopes
      ? { ...pendingRecord, scopes: [...autoApproveScopes] }
      : pendingRecord;
    const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
    const roleMismatchScope = resolveScopeOutsideRequestedRoles({
      requestedRoles,
      requestedScopes,
    });
    if (roleMismatchScope) {
      return {
        status: "forbidden",
        reason: "scope-outside-requested-roles",
        scope: roleMismatchScope,
      };
    }
    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const approvedScopes = mergeScopes(
      existing?.approvedScopes ?? existing?.scopes,
      pending.scopes,
    );
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    const nextTokenScopesByRole = new Map<string, string[]>();
    for (const roleForToken of requestedRoles) {
      const existingToken = tokens[roleForToken];
      const nextScopes = resolveApprovedTokenScopes({
        role: roleForToken,
        pending,
        existingToken,
        approvedScopes,
        existing,
      });
      nextTokenScopesByRole.set(roleForToken, nextScopes);
      if (roleForToken === OPERATOR_ROLE && nextScopes.length > 0) {
        const callerRequiredScopes =
          mergeScopes(
            resolveRoleScopedDeviceTokenScopes(roleForToken, pending.scopes),
            nextScopes,
          ) ?? nextScopes;
        if (!options?.callerScopes) {
          return {
            status: "forbidden",
            reason: "caller-scopes-required",
            scope: callerRequiredScopes[0],
          };
        }
        const missingScope = resolveMissingRequestedScope({
          role: OPERATOR_ROLE,
          requestedScopes: callerRequiredScopes,
          allowedScopes: options.callerScopes,
        });
        if (missingScope) {
          return { status: "forbidden", reason: "caller-missing-scope", scope: missingScope };
        }
      }
    }
    for (const [roleForToken, nextScopes] of nextTokenScopesByRole) {
      const existingToken = tokens[roleForToken];
      const tokenNow = Date.now();
      tokens[roleForToken] = {
        token: newToken(),
        role: roleForToken,
        scopes: nextScopes,
        createdAtMs: existingToken?.createdAtMs ?? tokenNow,
        rotatedAtMs: existingToken ? tokenNow : undefined,
        revokedAtMs: undefined,
        lastUsedAtMs: existingToken?.lastUsedAtMs,
      };
    }
    const device = buildApprovedPairedDevice({
      pending,
      existing,
      roles,
      approvedScopes,
      tokens,
      now,
      approvedVia: options?.approvedVia ?? "owner",
      accessMetadata: options?.accessMetadata,
    });
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, baseDir, "both");
    return { status: "approved", requestId, device };
  });
}

/** Approve a pending request through a bounded bootstrap profile handoff. */
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: { accessMetadata?: DevicePairingAccessMetadata },
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  optionsOrBaseDir?: { accessMetadata?: DevicePairingAccessMetadata } | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options =
    typeof optionsOrBaseDir === "string" || optionsOrBaseDir === undefined
      ? undefined
      : optionsOrBaseDir;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  const approvedRoles = mergeRoles(bootstrapProfile.roles) ?? [];
  const approvedScopes = resolveDeviceProfileScopes(bootstrapProfile, approvedRoles);
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const requestedRoles = resolveRequestedRoles(pending);
    const missingRole = requestedRoles.find((role) => !approvedRoles.includes(role));
    if (missingRole) {
      return { status: "forbidden", reason: "bootstrap-role-not-allowed", role: missingRole };
    }
    const requestedOperatorScopes = normalizeDeviceAuthScopes(pending.scopes).filter((scope) =>
      scope.startsWith(OPERATOR_SCOPE_PREFIX),
    );
    const missingScope = resolveMissingRequestedScope({
      role: OPERATOR_ROLE,
      requestedScopes: requestedOperatorScopes,
      allowedScopes: approvedScopes,
    });
    if (missingScope) {
      return { status: "forbidden", reason: "bootstrap-scope-not-allowed", scope: missingScope };
    }

    const now = Date.now();
    const existing = state.pairedByDeviceId[pending.deviceId];
    const grantedRoles = requestedRoles;
    const grantedScopes = resolveDeviceProfileScopes(
      bootstrapProfile,
      grantedRoles,
      pending.scopes ?? [],
    );
    const grantedRoleSet = new Set(grantedRoles);
    const preservedExistingScopes = (mergeRoles(existing?.roles, existing?.role) ?? []).flatMap(
      (existingRole) =>
        grantedRoleSet.has(existingRole)
          ? []
          : preserveRoleScopedApprovalScopes(
              existingRole,
              existing?.approvedScopes ?? existing?.scopes,
            ),
    );
    const roles = mergeRoles(existing?.roles, existing?.role, pending.roles, pending.role);
    const nextApprovedScopes = mergeScopes(preservedExistingScopes, grantedScopes);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    for (const roleForToken of grantedRoles) {
      const existingToken = tokens[roleForToken];
      const tokenScopes =
        roleForToken === OPERATOR_ROLE
          ? resolveDeviceProfileRoleScopes(bootstrapProfile, roleForToken, grantedScopes)
          : [];
      tokens[roleForToken] = buildDeviceAuthToken({
        role: roleForToken,
        scopes: tokenScopes,
        existing: existingToken,
        now,
        ...(existingToken ? { rotatedAtMs: now } : {}),
      });
    }

    const device = buildApprovedPairedDevice({
      pending,
      existing,
      roles,
      approvedScopes: nextApprovedScopes,
      tokens,
      now,
      approvedVia: "bootstrap",
      accessMetadata: options?.accessMetadata,
    });
    delete state.pendingById[requestId];
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, baseDir, "both");
    return { status: "approved", requestId, device };
  });
}

/** Reject a pending request and revoke matching bootstrap tokens for that device. */
export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; deviceId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    delete state.pendingById[requestId];
    persistState(state, baseDir, "pending");
    await revokeDeviceBootstrapTokensForDevice({
      deviceId: pending.deviceId,
      publicKey: pending.publicKey,
      baseDir,
    });
    return { requestId, deviceId: pending.deviceId };
  });
}

/** Remove a paired device and any pending repair requests for the same device id. */
export async function removePairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<{ deviceId: string } | null> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized || !state.pairedByDeviceId[normalized]) {
      return null;
    }
    delete state.pairedByDeviceId[normalized];
    for (const [requestId, pending] of Object.entries(state.pendingById)) {
      if (pending.deviceId === normalized) {
        delete state.pendingById[requestId];
      }
    }
    persistState(state, baseDir, "both");
    return { deviceId: normalized };
  });
}

// Silent pairings from the same client software on the same host mint a fresh
// deviceId whenever their state dir (and thus keypair) is ephemeral. The cluster
// key groups those records so a replacement pairing can retire its predecessors.
function silentPairingClusterKey(
  device: Pick<PairedDevice, "clientId" | "clientMode" | "displayName">,
): string | null {
  const clientId = device.clientId?.trim().toLowerCase() ?? "";
  const clientMode = device.clientMode?.trim().toLowerCase() ?? "";
  const displayName = device.displayName?.trim().toLowerCase() ?? "";
  if (!clientId && !clientMode && !displayName) {
    return null;
  }
  return `${clientId}\0${clientMode}\0${displayName}`;
}

/** Superseded silent pairing removed in favor of a newer record for the same client. */
export type PrunedSupersededPairedDevice = {
  deviceId: string;
  roles: string[];
};

// A concurrently approved sibling may still be mid-handshake and not yet visible
// to the connected-clients check; freshly approved records are never prune
// candidates so parallel silent pairings cannot delete each other's rows.
const PRUNE_RECENT_APPROVAL_GRACE_MS = 60_000;

/**
 * Remove silent-approved sibling records superseded by a newly approved silent
 * pairing of the same client cluster. Only records whose latest approval was
 * same-host local ("silent") are eligible, as anchor and as victim: local
 * clients re-pair silently by construction and share the gateway host, so the
 * metadata cluster key cannot match a different machine. Currently connected
 * devices are skipped so concurrent sessions with distinct state dirs keep
 * their tokens while live.
 */
export async function pruneSupersededSilentPairedDevices(params: {
  deviceId: string;
  baseDir?: string;
  isDeviceConnected?: (deviceId: string) => boolean;
  nowMs?: number;
}): Promise<PrunedSupersededPairedDevice[]> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const anchor = state.pairedByDeviceId[normalizeDeviceId(params.deviceId)];
    if (!anchor || anchor.approvedVia !== "silent") {
      return [];
    }
    const anchorKey = silentPairingClusterKey(anchor);
    if (!anchorKey) {
      return [];
    }
    const nowMs = params.nowMs ?? Date.now();
    const removed: PrunedSupersededPairedDevice[] = [];
    for (const device of Object.values(state.pairedByDeviceId)) {
      if (device.deviceId === anchor.deviceId) {
        continue;
      }
      // Legacy records without approvedVia stay untouched (fail-safe).
      if (device.approvedVia !== "silent") {
        continue;
      }
      if (silentPairingClusterKey(device) !== anchorKey) {
        continue;
      }
      if (nowMs - device.approvedAtMs < PRUNE_RECENT_APPROVAL_GRACE_MS) {
        continue;
      }
      if (params.isDeviceConnected?.(device.deviceId)) {
        continue;
      }
      delete state.pairedByDeviceId[device.deviceId];
      for (const [requestId, pending] of Object.entries(state.pendingById)) {
        if (pending.deviceId === device.deviceId) {
          delete state.pendingById[requestId];
        }
      }
      removed.push({
        deviceId: device.deviceId,
        roles: listApprovedPairedDeviceRoles(device),
      });
    }
    if (removed.length === 0) {
      return [];
    }
    persistState(state, params.baseDir, "both");
    return removed;
  });
}

/** Remove one approved paired-device role while preserving unrelated role tokens. */
export async function removePairedDeviceRole(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<{ deviceId: string; role: string; removedDevice: boolean } | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const normalizedDeviceId = normalizeDeviceId(params.deviceId);
    const role = normalizeRole(params.role);
    const device = state.pairedByDeviceId[normalizedDeviceId];
    if (!device || !role || !listApprovedPairedDeviceRoles(device).includes(role)) {
      return null;
    }

    const tokens = cloneDeviceTokens(device);
    delete tokens[role];
    const remainingRoles = listApprovedPairedDeviceRoles(device).filter((entry) => entry !== role);
    if (remainingRoles.length === 0) {
      for (const [requestId, pending] of Object.entries(state.pendingById)) {
        if (pending.deviceId === normalizedDeviceId) {
          delete state.pendingById[requestId];
        }
      }
      delete state.pairedByDeviceId[normalizedDeviceId];
      persistState(state, params.baseDir, "both");
      return { deviceId: normalizedDeviceId, role, removedDevice: true };
    }

    for (const [requestId, pending] of Object.entries(state.pendingById)) {
      if (pending.deviceId !== normalizedDeviceId) {
        continue;
      }
      const pendingRoles = resolveRequestedRoles(pending);
      if (!pendingRoles.includes(role)) {
        continue;
      }
      const nextPendingRoles = pendingRoles.filter((entry) => entry !== role);
      if (nextPendingRoles.length === 0) {
        delete state.pendingById[requestId];
        continue;
      }
      const pendingScopes = Array.isArray(pending.scopes)
        ? mergeScopes(
            ...nextPendingRoles.map((entry) =>
              preserveRoleScopedApprovalScopes(entry, pending.scopes),
            ),
          )
        : undefined;
      state.pendingById[requestId] = {
        ...pending,
        role: nextPendingRoles[0],
        roles: nextPendingRoles,
        scopes: pendingScopes,
      };
    }

    const scopeBaseline = device.approvedScopes ?? device.scopes;
    const preservedScopes = Array.isArray(scopeBaseline)
      ? mergeScopes(
          ...remainingRoles.map((entry) => preserveRoleScopedApprovalScopes(entry, scopeBaseline)),
        )
      : undefined;
    const next: PairedDevice = {
      ...device,
      role: remainingRoles[0],
      roles: remainingRoles,
      ...(preservedScopes !== undefined
        ? { scopes: preservedScopes, approvedScopes: preservedScopes }
        : {}),
      tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    };
    if (role === "node") {
      // The node capability surface is bound to the node role; revoking the
      // role must revoke approved command exposure with it.
      delete next.nodeSurface;
      delete next.pendingNodeSurface;
    }
    state.pairedByDeviceId[normalizedDeviceId] = next;
    persistState(state, params.baseDir, "both");
    return { deviceId: normalizedDeviceId, role, removedDevice: false };
  });
}

/** Update non-auth metadata for a paired device presence/status refresh. */
export async function updatePairedDeviceMetadata(
  deviceId: string,
  patch: Partial<PairedDeviceMetadataPatch>,
  baseDir?: string,
): Promise<boolean> {
  return await withLock(async () => {
    const state = await loadState(baseDir);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const existing = state.pairedByDeviceId[normalizedDeviceId];
    if (!existing) {
      return false;
    }
    const next = { ...existing };
    if ("displayName" in patch) {
      next.displayName = patch.displayName;
    }
    if ("operatorLabel" in patch) {
      next.operatorLabel = patch.operatorLabel;
    }
    if ("platform" in patch) {
      next.platform = patch.platform;
    }
    if ("clientId" in patch) {
      next.clientId = patch.clientId;
    }
    if ("clientMode" in patch) {
      next.clientMode = patch.clientMode;
    }
    if ("remoteIp" in patch) {
      next.remoteIp = patch.remoteIp;
    }
    if ("lastSeenAtMs" in patch) {
      next.lastSeenAtMs = patch.lastSeenAtMs;
    }
    if ("lastSeenReason" in patch) {
      next.lastSeenReason = patch.lastSeenReason;
    }
    state.pairedByDeviceId[normalizedDeviceId] = next;
    persistState(state, baseDir, "paired");
    return true;
  });
}

/** Summarize token metadata without exposing bearer token strings. */
export function summarizeDeviceTokens(
  tokens: Record<string, DeviceAuthToken> | undefined,
): DeviceAuthTokenSummary[] | undefined {
  if (!tokens) {
    return undefined;
  }
  const summaries = Object.values(tokens)
    .map((token) => ({
      role: token.role,
      scopes: token.scopes,
      createdAtMs: token.createdAtMs,
      rotatedAtMs: token.rotatedAtMs,
      revokedAtMs: token.revokedAtMs,
      lastUsedAtMs: token.lastUsedAtMs,
    }))
    .toSorted((a, b) => a.role.localeCompare(b.role));
  return summaries.length > 0 ? summaries : undefined;
}

/** Verify a device role token, scope it to the approval baseline, and mark last use. */
export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes: string[];
  requiredSharedGatewaySessionGeneration?: string;
  baseDir?: string;
}): Promise<{ ok: boolean; reason?: string; issuer?: DeviceAuthToken["issuer"] }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const device = getPairedDeviceFromState(state, params.deviceId);
    if (!device) {
      return { ok: false, reason: "device-not-paired" };
    }
    const role = normalizeRole(params.role);
    if (!role) {
      return { ok: false, reason: "role-missing" };
    }
    const entry = device.tokens?.[role];
    if (!entry) {
      return { ok: false, reason: "token-missing" };
    }
    if (entry.revokedAtMs) {
      return { ok: false, reason: "token-revoked" };
    }
    if (!verifyPairingToken(params.token, entry.token)) {
      return { ok: false, reason: "token-mismatch" };
    }
    if (
      entry.issuer?.kind === SHARED_GATEWAY_AUTH_ISSUER_KIND &&
      entry.issuer.generation !== params.requiredSharedGatewaySessionGeneration
    ) {
      return { ok: false, reason: "issuer-generation-stale" };
    }
    if (
      !entry.issuer &&
      params.requiredSharedGatewaySessionGeneration !== undefined &&
      isBrowserRelatedPairedDevice(device)
    ) {
      return { ok: false, reason: "legacy-browser-token" };
    }
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: entry.scopes,
        approvedScopes,
      })
    ) {
      return { ok: false, reason: "scope-mismatch" };
    }
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    if (!roleScopesAllow({ role, requestedScopes, allowedScopes: entry.scopes })) {
      return { ok: false, reason: "scope-mismatch" };
    }
    const now = Date.now();
    entry.lastUsedAtMs = now;
    device.tokens ??= {};
    device.tokens[role] = entry;
    device.lastSeenAtMs = now;
    device.lastSeenReason = "device-token-auth";
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return entry.issuer ? { ok: true, issuer: entry.issuer } : { ok: true };
  });
}

/** Return a reusable token for a role or issue one within the approved scope baseline. */
export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const requestedScopes = normalizeDeviceAuthScopes(params.scopes);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context) {
      return null;
    }
    const { device, role, tokens, existing } = context;
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return null;
    }
    if (existing && !existing.revokedAtMs) {
      const existingWithinApproved = scopesWithinApprovedDeviceBaseline({
        role,
        scopes: existing.scopes,
        approvedScopes,
      });
      const issuerAllowsReuse = deviceTokenIssuerMatches(existing, params.issuer);
      if (
        existingWithinApproved &&
        issuerAllowsReuse &&
        roleScopesAllow({ role, requestedScopes, allowedScopes: existing.scopes })
      ) {
        return existing;
      }
    }
    const now = Date.now();
    const next = buildDeviceAuthToken({
      role,
      scopes: requestedScopes,
      issuer: params.issuer,
      existing,
      now,
      rotatedAtMs: existing ? now : undefined,
    });
    tokens[role] = next;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return next;
  });
}

function resolveDeviceTokenUpdateContext(params: {
  state: DevicePairingStateFile;
  deviceId: string;
  role: string;
}): {
  device: PairedDevice;
  role: string;
  tokens: Record<string, DeviceAuthToken>;
  existing: DeviceAuthToken | undefined;
} | null {
  const device = getPairedDeviceFromState(params.state, params.deviceId);
  if (!device) {
    return null;
  }
  const role = normalizeRole(params.role);
  if (!role) {
    return null;
  }
  // Token issuance and rotation must stay inside the role set that pairing
  // approval recorded for this device.
  if (!listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }
  const tokens = cloneDeviceTokens(device);
  const existing = tokens[role];
  return { device, role, tokens, existing };
}

/** Rotate a role token inside the device's approved scope baseline. */
export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  callerScopes?: readonly string[];
  baseDir?: string;
}): Promise<RotateDeviceTokenResult> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const requestedScopes = normalizeDeviceAuthScopes(
      params.scopes ?? existing?.scopes ?? device.scopes,
    );
    const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
    if (!approvedScopes) {
      return { ok: false, reason: "missing-approved-scope-baseline" };
    }
    if (
      !scopesWithinApprovedDeviceBaseline({
        role,
        scopes: requestedScopes,
        approvedScopes,
      })
    ) {
      return { ok: false, reason: "scope-outside-approved-baseline" };
    }
    if (params.callerScopes) {
      const missingScope = resolveMissingRequestedScope({
        role,
        requestedScopes,
        allowedScopes: params.callerScopes,
      });
      if (missingScope) {
        return { ok: false, reason: "caller-missing-scope", scope: missingScope };
      }
    }
    const now = Date.now();
    const next = buildDeviceAuthToken({
      role,
      scopes: requestedScopes,
      existing,
      preserveExistingIssuer: true,
      now,
      rotatedAtMs: now,
    });
    tokens[role] = next;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return { ok: true, entry: next };
  });
}

/** Revoke one active role token after optional caller-scope authorization. */
export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  callerScopes?: readonly string[];
  baseDir?: string;
}): Promise<RevokeDeviceTokenResult> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context || !context.existing) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const targetScopes = normalizeDeviceAuthScopes(
      Array.isArray(existing.scopes) ? existing.scopes : device.scopes,
    );
    if (params.callerScopes) {
      const missingScope = resolveMissingRequestedScope({
        role,
        requestedScopes: targetScopes,
        allowedScopes: params.callerScopes,
      });
      if (missingScope) {
        return { ok: false, reason: "caller-missing-scope", scope: missingScope };
      }
    }
    const entry = { ...existing, revokedAtMs: Date.now() };
    tokens[role] = entry;
    device.tokens = tokens;
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return { ok: true, entry };
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
