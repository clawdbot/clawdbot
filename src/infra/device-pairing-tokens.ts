// Device token issuance, verification, rotation, and revocation for paired devices.
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveMissingRequestedScope, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  cloneDevicePairingTokens,
  loadDevicePairingState,
  normalizeDevicePairingId,
  normalizeDevicePairingRole,
  withDevicePairingLock,
} from "./device-pairing-state.js";
import {
  persistDevicePairingStoreState as persistState,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import {
  clearNodePairingGenerationBins,
  listApprovedPairedDeviceRoles,
  resolveNodePairingGeneration,
} from "./device-pairing.js";
import type { DeviceAuthToken, PairedDevice } from "./device-pairing.types.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

const OPERATOR_SCOPE_PREFIX = "operator.";
const SHARED_GATEWAY_AUTH_ISSUER_KIND = "shared-gateway-auth";
const BROWSER_DEVICE_CLIENT_IDS = new Set(["openclaw-control-ui", "webchat-ui"]);
const BROWSER_DEVICE_CLIENT_MODE = "webchat";

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

function getPairedDeviceFromState(
  state: DevicePairingStoreState,
  deviceId: string,
): PairedDevice | null {
  return state.pairedByDeviceId[normalizeDevicePairingId(deviceId)] ?? null;
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

/** Build one freshly generated role token while preserving requested lifecycle fields. */
export function createDeviceAuthToken(params: {
  role: string;
  scopes: string[];
  issuer?: DeviceAuthToken["issuer"];
  existing?: DeviceAuthToken;
  preserveExistingIssuer?: boolean;
  now: number;
  rotatedAtMs?: number;
}): DeviceAuthToken {
  return {
    token: generatePairingToken(),
    role: params.role,
    scopes: params.scopes,
    issuer: params.issuer ?? (params.preserveExistingIssuer ? params.existing?.issuer : undefined),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    rotatedAtMs: params.rotatedAtMs,
    revokedAtMs: undefined,
    lastUsedAtMs: params.existing?.lastUsedAtMs,
  };
}

/** Select scopes owned by one device-token role. */
export function resolveRoleTokenScopes(role: string, scopes: string[] | undefined): string[] {
  const normalized = normalizeDeviceAuthScopes(scopes);
  if (role === "operator") {
    return normalized.filter((scope) => scope.startsWith(OPERATOR_SCOPE_PREFIX));
  }
  return normalized.filter((scope) => !scope.startsWith(OPERATOR_SCOPE_PREFIX));
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
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(params.baseDir);
    const device = getPairedDeviceFromState(state, params.deviceId);
    if (!device) {
      return { ok: false, reason: "device-not-paired" };
    }
    const role = normalizeDevicePairingRole(params.role);
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
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(params.baseDir);
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
    const previousNodeGeneration = resolveNodePairingGeneration(device);
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
    const next = createDeviceAuthToken({
      role,
      scopes: requestedScopes,
      issuer: params.issuer,
      existing,
      now,
      rotatedAtMs: existing ? now : undefined,
    });
    tokens[role] = next;
    device.tokens = tokens;
    clearNodePairingGenerationBins(device, previousNodeGeneration);
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return next;
  });
}

function resolveDeviceTokenUpdateContext(params: {
  state: DevicePairingStoreState;
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
  const role = normalizeDevicePairingRole(params.role);
  if (!role) {
    return null;
  }
  // Token issuance and rotation must stay inside the role set that pairing
  // approval recorded for this device.
  if (!listApprovedPairedDeviceRoles(device).includes(role)) {
    return null;
  }
  const tokens = cloneDevicePairingTokens(device);
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
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const previousNodeGeneration = resolveNodePairingGeneration(device);
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
    const next = createDeviceAuthToken({
      role,
      scopes: requestedScopes,
      existing,
      preserveExistingIssuer: true,
      now,
      rotatedAtMs: now,
    });
    tokens[role] = next;
    device.tokens = tokens;
    clearNodePairingGenerationBins(device, previousNodeGeneration);
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
  return await withDevicePairingLock(async () => {
    const state = await loadDevicePairingState(params.baseDir);
    const context = resolveDeviceTokenUpdateContext({
      state,
      deviceId: params.deviceId,
      role: params.role,
    });
    if (!context || !context.existing) {
      return { ok: false, reason: "unknown-device-or-role" };
    }
    const { device, role, tokens, existing } = context;
    const previousNodeGeneration = resolveNodePairingGeneration(device);
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
    clearNodePairingGenerationBins(device, previousNodeGeneration);
    state.pairedByDeviceId[device.deviceId] = device;
    persistState(state, params.baseDir, "paired");
    return { ok: true, entry };
  });
}
