// Bootstraps device identity and trust state on first run.
import { randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
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
  confirmDevicePairSetupCompletionDeliveryInTransaction,
  consumeDeviceBootstrapTokenWithSetupCompletionInTransaction,
  loadDeviceBootstrapTokenRecords,
  loadDevicePairSetupCompletionRecord,
  persistDeviceBootstrapTokenRecords as persistState,
  pruneExpiredDevicePairSetupCompletionRecords,
} from "./device-pairing-store.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
} from "./device-pairing.types.js";
import { createAsyncLock, pruneExpiredPending } from "./pairing-files.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

/** Bootstrap pairing tokens are short-lived bearer credentials for first device auth. */
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

// Outlive the credential itself: a client that waits for the full TTL still has
// to find its completion after the code it was showing has expired.
const DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS = 2 * DEVICE_BOOTSTRAP_TOKEN_TTL_MS;

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

type DeviceBootstrapTokenIssueParams = {
  baseDir?: string;
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
};

async function issueDeviceBootstrapTokenRecord(
  params: DeviceBootstrapTokenIssueParams & { setupId?: string },
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
      ...(params.setupId ? { setupId: params.setupId } : {}),
      ts: issuedAtMs,
      profile,
      redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
      issuedAtMs,
    };
    persistState(state, params.baseDir);
    return { token, expiresAtMs };
  });
}

/** Issue a short-lived generic bootstrap token with a bounded role/scope handoff profile. */
export async function issueDeviceBootstrapToken(
  params: DeviceBootstrapTokenIssueParams = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await issueDeviceBootstrapTokenRecord(params);
}

/**
 * Issue a setup bootstrap token plus an opaque correlation id. `setupId` is
 * minted here, beside the credential, so the presenting client can follow one
 * exact credential without ever handling the bearer token. Generic bootstrap
 * handoffs stay uncorrelated: only setup codes have a presenting client.
 */
export async function issueDevicePairSetupBootstrapToken(params: {
  baseDir?: string;
  profile: DeviceBootstrapProfileInput;
}): Promise<{ token: string; expiresAtMs: number; setupId: string }> {
  const setupId = randomUUID();
  const issued = await issueDeviceBootstrapTokenRecord({ ...params, setupId });
  return { ...issued, setupId };
}

type EnsuredDevicePairSetupBootstrap =
  | { status: "pending"; token: string; expiresAtMs: number; setupId: string }
  | { status: "completed"; setupId: string; deviceId: string };

/** Reuse one environment-owned setup credential across provider replay. */
export async function ensureDevicePairSetupBootstrapToken(params: {
  setupId: string;
  baseDir?: string;
  profile: DeviceBootstrapProfileInput;
}): Promise<EnsuredDevicePairSetupBootstrap> {
  const setupId = params.setupId.trim();
  if (!setupId) {
    throw new Error("Device setup id must be non-empty.");
  }
  return await withLock(async () => {
    const completion = loadDevicePairSetupCompletionRecord(setupId, Date.now(), params.baseDir);
    if (completion) {
      return { status: "completed", setupId, deviceId: completion.deviceId };
    }
    const state = await loadState(params.baseDir);
    const existing = Object.values(state).find((record) => record.setupId === setupId);
    const profile = normalizeDeviceBootstrapHandoffProfile(params.profile);
    if (existing) {
      if (!deviceBootstrapProfilesEqual(existing.profile, profile)) {
        throw new Error("Device setup profile changed during replay.");
      }
      return {
        status: "pending",
        token: existing.token,
        expiresAtMs: existing.issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
        setupId,
      };
    }
    const issuedAtMs = asDateTimestampMs(Date.now());
    const expiresAtMs =
      issuedAtMs === undefined
        ? undefined
        : resolveExpiresAtMsFromDurationMs(DEVICE_BOOTSTRAP_TOKEN_TTL_MS, { nowMs: issuedAtMs });
    if (issuedAtMs === undefined || expiresAtMs === undefined) {
      throw new Error("Device bootstrap token expiry could not be resolved.");
    }
    const token = generatePairingToken();
    state[token] = {
      token,
      setupId,
      ts: issuedAtMs,
      profile,
      redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
      issuedAtMs,
    };
    persistState(state, params.baseDir);
    return { status: "pending", token, expiresAtMs, setupId };
  });
}

/**
 * Retire one setup bearer and record that credential delivery is not yet known.
 * The transport confirms delivery only after its response finishes; a crash or
 * disconnect therefore cannot turn replay safety into a false operator success.
 */
export async function consumeDeviceBootstrapTokenWithSetupCompletion(params: {
  token: string;
  deviceId: string;
  completedAtMs: number;
  pairedDeviceMatches?: (device: PairedDevice | null) => boolean;
  baseDir?: string;
}) {
  return await withLock(async () => {
    const nowMs = Date.now();
    return consumeDeviceBootstrapTokenWithSetupCompletionInTransaction({
      token: params.token,
      deviceId: params.deviceId,
      completedAtMs: params.completedAtMs,
      oldestValidIssuedAtMs: nowMs - DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
      // Retention follows the store clock rather than an injected event time.
      retentionNowMs: nowMs,
      retainUntilMs: nowMs + DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS,
      ...(params.pairedDeviceMatches ? { pairedDeviceMatches: params.pairedDeviceMatches } : {}),
      ...(params.baseDir ? { baseDir: params.baseDir } : {}),
    });
  });
}

/** Confirm that the pairing client received the credential-bearing handoff response. */
export async function confirmDevicePairSetupCompletionDelivery(params: {
  setupId: string;
  deviceId: string;
  baseDir?: string;
}): Promise<DevicePairSetupCompletionRecord | null> {
  return await withLock(async () =>
    confirmDevicePairSetupCompletionDeliveryInTransaction({
      setupId: params.setupId,
      deviceId: params.deviceId,
      nowMs: Date.now(),
      ...(params.baseDir ? { baseDir: params.baseDir } : {}),
    }),
  );
}

/**
 * Read the terminal outcome for one setup credential, or null while none is
 * recorded. Shares this module's lock with issuance and revocation so a status
 * query never observes a setup mid-settlement.
 */
export async function readDevicePairSetupCompletion(params: {
  setupId: string;
  baseDir?: string;
}): Promise<DevicePairSetupCompletionRecord | null> {
  return await withLock(async () =>
    loadDevicePairSetupCompletionRecord(params.setupId, Date.now(), params.baseDir),
  );
}

/** Remove retained setup outcomes independently of status requests or later pairings. */
export async function pruneExpiredDevicePairSetupCompletions(
  params: {
    nowMs?: number;
    baseDir?: string;
  } = {},
): Promise<number> {
  return await withLock(async () =>
    pruneExpiredDevicePairSetupCompletionRecords(params.nowMs ?? Date.now(), params.baseDir),
  );
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

/** Restore an uncorrelated bootstrap bearer when its credential response was not delivered. */
export async function restoreGenericDeviceBootstrapToken(params: {
  record: DeviceBootstrapTokenRecord;
  baseDir?: string;
}): Promise<boolean> {
  if (params.record.setupId) {
    // Correlated setup credentials stay retired: their durable uncertain outcome owns recovery.
    return false;
  }
  return await withLock(async () => {
    const state = await loadState(params.baseDir);
    state[params.record.token] = params.record;
    persistState(state, params.baseDir);
    return true;
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
    const requestedProfile = resolveRequestedBootstrapProfile({
      role,
      scopes: params.scopes,
      purpose: allowedProfile.purpose,
    });
    // Fail closed for any attempt to redeem the token outside the issued
    // role/scope allowlist before binding it to a concrete device identity.
    if (
      allowedProfile.roles.length === 0 ||
      (deviceBootstrapProfilesEqual(allowedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE) &&
        !deviceBootstrapProfilesEqual(requestedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE)) ||
      !bootstrapProfileAllowsRequest({
        allowedProfile,
        requestedRole: role,
        requestedScopes: params.scopes,
      })
    ) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }

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
