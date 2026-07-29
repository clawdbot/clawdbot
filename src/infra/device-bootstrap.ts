// Bootstraps device identity and trust state on first run.
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deviceBootstrapProfilesEqual,
  normalizeDeviceBootstrapHandoffProfile,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { normalizeDevicePublicKeyBase64Url } from "./device-identity.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords as persistState,
} from "./device-pairing-store.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

/** Bootstrap pairing tokens are short-lived bearer credentials for first device auth. */
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

type DeviceBootstrapStateFile = Record<string, DeviceBootstrapTokenRecord>;

const withLock = createAsyncLock();
const log = createSubsystemLogger("device-bootstrap");

function resolveIssuedBootstrapProfileInput(params: {
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): DeviceBootstrapProfileInput | undefined {
  if (params.profile) {
    return params.profile;
  }
  if (params.roles || params.scopes) {
    return {
      roles: params.roles,
      scopes: params.scopes,
    };
  }
  return undefined;
}

function resolvePersistedBootstrapProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.profile);
}

function resolvePersistedRedeemedProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.redeemedProfile);
}

function resolvePersistedPendingProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile | null {
  return record.pendingProfile ? normalizeDeviceBootstrapProfile(record.pendingProfile) : null;
}

function resolveRequestedBootstrapProfile(params: {
  role: string;
  scopes: readonly string[];
  purpose?: DeviceBootstrapProfile["purpose"];
}): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile({
    roles: [params.role],
    scopes: resolveBootstrapProfileScopesForRole(params.role, params.scopes, params.purpose),
    purpose: params.purpose,
  });
}

function resolveIssuedBootstrapProfile(params: {
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): DeviceBootstrapProfile {
  const input = resolveIssuedBootstrapProfileInput(params);
  if (input) {
    // Issued tokens can request many roles/scopes, but bootstrap handoff persists only the allowlist.
    return normalizeDeviceBootstrapHandoffProfile(input);
  }
  // Generic bootstrap callers stay least-privilege. Official mobile setup
  // passes the full profile explicitly after validating the advertised URL.
  return PAIRING_SETUP_BOOTSTRAP_PROFILE;
}

function warnIfIssuedBootstrapScopesWereStripped(params: {
  input: DeviceBootstrapProfileInput | undefined;
  profile: DeviceBootstrapProfile;
}): void {
  if (!params.input) {
    return;
  }
  const requestedProfile = normalizeDeviceBootstrapProfile(params.input);
  const requestedScopes = requestedProfile.scopes;
  if (requestedScopes.length === 0) {
    return;
  }
  const retainedScopeSet = new Set(params.profile.scopes);
  const strippedScopes = requestedScopes.filter((scope) => !retainedScopeSet.has(scope));
  if (strippedScopes.length === 0) {
    return;
  }
  log.warn("bootstrap_token_scopes_stripped", {
    roles: requestedProfile.roles,
    requestedScopes,
    retainedScopes: params.profile.scopes,
    strippedScopes,
    consoleMessage: "bootstrap token scopes stripped to bootstrap handoff allowlist",
  });
}

function bootstrapProfileAllowsRequest(params: {
  allowedProfile: DeviceBootstrapProfile;
  requestedRole: string;
  requestedScopes: readonly string[];
}): boolean {
  return (
    params.allowedProfile.roles.includes(params.requestedRole) &&
    roleScopesAllow({
      role: params.requestedRole,
      requestedScopes: params.requestedScopes,
      allowedScopes: params.allowedProfile.scopes,
    })
  );
}

function bootstrapProfileSatisfiesProfile(params: {
  actualProfile: DeviceBootstrapProfile;
  requiredProfile: DeviceBootstrapProfile;
}): boolean {
  for (const requiredRole of params.requiredProfile.roles) {
    if (!params.actualProfile.roles.includes(requiredRole)) {
      return false;
    }
    const requiredScopes = resolveBootstrapProfileScopesForRole(
      requiredRole,
      params.requiredProfile.scopes,
      params.requiredProfile.purpose,
    );
    if (
      requiredScopes.length > 0 &&
      !bootstrapProfileAllowsRequest({
        allowedProfile: params.actualProfile,
        requestedRole: requiredRole,
        requestedScopes: requiredScopes,
      })
    ) {
      return false;
    }
  }
  return true;
}

function normalizeBootstrapPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    return "";
  }
  // PEM/base64/base64url encodings for the same key must bind to one token identity.
  if (trimmed.includes("BEGIN") || /[+/=]/.test(trimmed)) {
    return normalizeDevicePublicKeyBase64Url(trimmed) ?? trimmed;
  }
  return trimmed;
}

async function loadState(baseDir?: string): Promise<DeviceBootstrapStateFile> {
  const state = loadDeviceBootstrapTokenRecords(baseDir);
  pruneExpiredPending(state, asDateTimestampMs(Date.now()) ?? 0, DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}

/** Issue a short-lived bootstrap token with a bounded role/scope handoff profile. */
export async function issueDeviceBootstrapToken(
  params: {
    baseDir?: string;
    profile?: DeviceBootstrapProfileInput;
    roles?: readonly string[];
    scopes?: readonly string[];
  } = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const token = generatePairingToken();
    const issuedAtMs = asDateTimestampMs(Date.now());
    const expiresAtMs =
      issuedAtMs === undefined
        ? undefined
        : resolveExpiresAtMsFromDurationMs(DEVICE_BOOTSTRAP_TOKEN_TTL_MS, { nowMs: issuedAtMs });
    if (issuedAtMs === undefined || expiresAtMs === undefined) {
      throw new Error("Device bootstrap token expiry could not be resolved.");
    }
    const profileInput = resolveIssuedBootstrapProfileInput(params);
    const profile = resolveIssuedBootstrapProfile(params);
    warnIfIssuedBootstrapScopesWereStripped({ input: profileInput, profile });
    state[token] = {
      token,
      ts: issuedAtMs,
      profile,
      redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
      issuedAtMs,
    };
    persistState(state, params.baseDir);
    return { token, expiresAtMs };
  });
}

/** Remove every outstanding bootstrap token from the pairing state file. */
export async function clearDeviceBootstrapTokens(
  params: {
    baseDir?: string;
  } = {},
): Promise<{ removed: number }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const removed = Object.keys(state).length;
    persistState({}, params.baseDir);
    return { removed };
  });
}

/** Revoke one bootstrap token and return its record for best-effort restore flows. */
export async function revokeDeviceBootstrapToken(params: {
  token: string;
  baseDir?: string;
}): Promise<{ removed: boolean; record?: DeviceBootstrapTokenRecord }> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { removed: false };
    }
    const state = await loadState(params.baseDir);
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { removed: false };
    }
    const [tokenKey, record] = found;
    delete state[tokenKey];
    persistState(state, params.baseDir);
    return { removed: true, record };
  });
}

/** Revoke bootstrap tokens that are already bound to a specific device identity. */
export async function revokeDeviceBootstrapTokensForDevice(params: {
  deviceId: string;
  publicKey: string;
  baseDir?: string;
}): Promise<{ removed: number }> {
  return await withLock(async () => {
    const deviceId = params.deviceId.trim();
    const publicKey = normalizeBootstrapPublicKey(params.publicKey);
    if (!deviceId || !publicKey) {
      return { removed: 0 };
    }
    const state = await loadState(params.baseDir);
    let removed = 0;
    for (const [tokenKey, record] of Object.entries(state)) {
      const recordPublicKey =
        typeof record.publicKey === "string"
          ? normalizeBootstrapPublicKey(record.publicKey)
          : undefined;
      if (record.deviceId?.trim() === deviceId && recordPublicKey === publicKey) {
        delete state[tokenKey];
        removed += 1;
      }
    }
    if (removed > 0) {
      persistState(state, params.baseDir);
    }
    return { removed };
  });
}

/** Restore a previously revoked bootstrap token record after a downstream send failure. */
export async function restoreDeviceBootstrapToken(params: {
  record: DeviceBootstrapTokenRecord;
  baseDir?: string;
}): Promise<void> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    state[params.record.token] = params.record;
    persistState(state, params.baseDir);
  });
}

/** Read the issued profile for a valid token without binding or redeeming it. */
export async function getDeviceBootstrapTokenProfile(params: {
  token: string;
  baseDir?: string;
}): Promise<DeviceBootstrapProfile | null> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return null;
    }
    const state = await loadState(params.baseDir);
    const found = Object.values(state).find((candidate) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    return found ? resolvePersistedBootstrapProfile(found) : null;
  });
}

/** Record that one role/scope leg of a multi-role bootstrap handoff was redeemed. */
export async function redeemDeviceBootstrapTokenProfile(params: {
  token: string;
  role: string;
  scopes: readonly string[];
  baseDir?: string;
}): Promise<{ recorded: boolean; fullyRedeemed: boolean }> {
  return await withLock(async () => {
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { recorded: false, fullyRedeemed: false };
    }
    const state = await loadState(params.baseDir);
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { recorded: false, fullyRedeemed: false };
    }
    const [tokenKey, record] = found;
    const issuedProfile = resolvePersistedBootstrapProfile(record);
    const pendingProfile = resolvePersistedPendingProfile(record);
    // Keep a pending profile until all requested roles/scopes from that handshake are redeemed.
    const redeemedProfile = normalizeDeviceBootstrapProfile({
      roles: [...resolvePersistedRedeemedProfile(record).roles, params.role],
      scopes: [
        ...resolvePersistedRedeemedProfile(record).scopes,
        ...resolveBootstrapProfileScopesForRole(params.role, params.scopes, issuedProfile.purpose),
      ],
      purpose: issuedProfile.purpose,
    });
    const nextPendingProfile =
      pendingProfile &&
      !bootstrapProfileSatisfiesProfile({
        actualProfile: redeemedProfile,
        requiredProfile: pendingProfile,
      })
        ? pendingProfile
        : undefined;
    const nextRecord: DeviceBootstrapTokenRecord = {
      ...record,
      profile: issuedProfile,
      redeemedProfile,
    };
    if (nextPendingProfile) {
      nextRecord.pendingProfile = nextPendingProfile;
    } else {
      delete nextRecord.pendingProfile;
    }
    state[tokenKey] = nextRecord;
    persistState(state, params.baseDir);
    return {
      recorded: true,
      fullyRedeemed: bootstrapProfileSatisfiesProfile({
        actualProfile: redeemedProfile,
        requiredProfile: issuedProfile,
      }),
    };
  });
}

/** Verify a bootstrap token, bind it to the first device identity, and stage requested scopes. */
export async function verifyDeviceBootstrapToken(params: {
  token: string;
  deviceId: string;
  publicKey: string;
  role: string;
  scopes: readonly string[];
  baseDir?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const providedToken = params.token.trim();
    if (!providedToken) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const [tokenKey, record] = found;

    const deviceId = params.deviceId.trim();
    const publicKey = normalizeBootstrapPublicKey(params.publicKey);
    const role = params.role.trim();
    if (!deviceId || !publicKey || !role) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const allowedProfile = resolvePersistedBootstrapProfile(record);
    // Fail closed for any attempt to redeem the token outside the issued
    // role/scope allowlist before binding it to a concrete device identity.
    if (
      allowedProfile.roles.length === 0 ||
      !bootstrapProfileAllowsRequest({
        allowedProfile,
        requestedRole: role,
        requestedScopes: params.scopes,
      })
    ) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const requestedProfile = resolveRequestedBootstrapProfile({
      role,
      scopes: params.scopes,
      purpose: allowedProfile.purpose,
    });

    const boundDeviceId = record.deviceId?.trim();
    const boundPublicKey =
      typeof record.publicKey === "string"
        ? normalizeBootstrapPublicKey(record.publicKey)
        : undefined;
    if (boundDeviceId || boundPublicKey) {
      if (boundDeviceId !== deviceId || boundPublicKey !== publicKey) {
        return { ok: false, reason: "bootstrap_token_invalid" };
      }
      const pendingProfile = resolvePersistedPendingProfile(record);
      if (pendingProfile && !deviceBootstrapProfilesEqual(pendingProfile, requestedProfile)) {
        return { ok: false, reason: "bootstrap_token_invalid" };
      }
      state[tokenKey] = {
        ...record,
        profile: allowedProfile,
        pendingProfile: pendingProfile ?? requestedProfile,
        deviceId,
        publicKey,
        lastUsedAtMs: Date.now(),
      };
      persistState(state, params.baseDir);
      return { ok: true };
    }

    state[tokenKey] = {
      ...record,
      profile: allowedProfile,
      pendingProfile: requestedProfile,
      deviceId,
      publicKey,
      lastUsedAtMs: Date.now(),
    };
    persistState(state, params.baseDir);
    return { ok: true };
  });
}

/**
 * Reads the already-bound bootstrap profile for a verified device identity.
 *
 * Call this only after `verifyDeviceBootstrapToken()` has returned `{ ok: true }`
 * for the same `token` / `deviceId` / `publicKey` tuple in the current handshake.
 */
export async function getBoundDeviceBootstrapProfile(params: {
  token: string;
  deviceId: string;
  publicKey: string;
  baseDir?: string;
}): Promise<DeviceBootstrapProfile | null> {
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    const providedToken = params.token.trim();
    if (!providedToken) {
      return null;
    }
    const found = Object.entries(state).find(([, candidate]) =>
      verifyPairingToken(providedToken, candidate.token),
    );
    if (!found) {
      return null;
    }
    const [, record] = found;
    const deviceId = params.deviceId.trim();
    const publicKey = normalizeBootstrapPublicKey(params.publicKey);
    if (!deviceId || !publicKey) {
      return null;
    }
    const recordPublicKey =
      typeof record.publicKey === "string"
        ? normalizeBootstrapPublicKey(record.publicKey)
        : undefined;
    if (record.deviceId?.trim() !== deviceId || recordPublicKey !== publicKey) {
      return null;
    }
    return resolvePersistedBootstrapProfile(record);
  });
}
