// Presentation-free by contract: confirmations and secret reveals belong to the owning
// page, because native window.confirm/window.prompt silently answer in webviews with no
// dialog bridge and would end the action with no outcome and no recorded reason.
import { getPublicKeyAsync, hashes, signAsync, utils } from "@noble/ed25519";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../../../../src/shared/device-auth.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { cloneConfigObject, removePathValue, setPathValue } from "../config-form-utils.ts";
// Shared Nodes operations used by the Control UI page and Gateway event hooks.
import { formatUiError } from "../format-error.ts";

// @noble/ed25519 defaults its SHA-512 to crypto.subtle, which browsers gate to
// secure contexts. On plain-HTTP origins the pure-JS digests load lazily so
// device identity keeps working there — the signing key is the one credential
// that never crosses the wire — while secure contexts pay no startup bytes.
const loadPureSha2 = () => import("@noble/hashes/sha2.js");
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  return Uint8Array.from((await loadPureSha2()).sha512(message));
};

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type NodesGatewaySnapshot = {
  client: GatewayRequestClient | null;
  connected: boolean;
};

export type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  createdAtMs?: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PendingDevice = {
  requestId: string;
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  /** Operator-assigned label; preferred over client displayName when rendering. */
  operatorLabel?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  approvedVia?: "owner" | "silent" | "trusted-cidr" | "ssh-verified" | "bootstrap";
  /** Server-computed: the device currently holds a live gateway connection. */
  connected?: boolean;
  createdAtMs?: number;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
};

export type DevicePairingList = {
  pending: PendingDevice[];
  paired: PairedDevice[];
};

type ExecApprovalsDefaults = {
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAllowlistEntry = {
  id?: string;
  pattern: string;
  source?: "allow-always";
  commandText?: string;
  argPattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecApprovalsAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version?: number;
  socket?: { path?: string };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

type FileExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type NativeExecApprovalRule = {
  pattern: string;
  action: "allow" | "deny" | "prompt";
  shells?: string[];
  description?: string;
  enabled?: boolean;
};

export type NativeExecApprovalsSnapshot =
  | {
      enabled: true;
      hash: string;
      baseHash?: string;
      defaultAction: "allow" | "deny" | "prompt";
      rules: NativeExecApprovalRule[];
      constraints?: Record<string, boolean>;
    }
  | { enabled: false; message?: string };

export type ExecApprovalsSnapshot = FileExecApprovalsSnapshot | NativeExecApprovalsSnapshot;

export type ExecApprovalsTarget = { kind: "gateway" } | { kind: "node"; nodeId: string };

type NodesRequestState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  // Auto-reconnect keeps the same client; the page advances this generation
  // whenever requests from the previous connection must become inert.
  requestGeneration: number;
};

type NodesState = NodesRequestState & {
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  lastError: string | null;
  chatError?: string | null;
};

type DevicesState = NodesRequestState & {
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
};

type ExecApprovalsState = NodesRequestState & {
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  lastError: string | null;
  chatError?: string | null;
};

export type DevicesPageDataState = NodesState & DevicesState & ExecApprovalsState;

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const LEGACY_DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const DEVICE_AUTH_STORAGE_KEY_PREFIX = `${LEGACY_DEVICE_AUTH_STORAGE_KEY}:`;
const DEVICE_IDENTITY_STORAGE_KEY = "openclaw-device-identity-v1";

export function createInitialDevicesState(
  snapshot: Partial<NodesGatewaySnapshot> = {},
): DevicesPageDataState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    requestGeneration: 0,
    nodesLoading: false,
    nodes: [],
    lastError: null,
    devicesLoading: false,
    devicesError: null,
    devicesList: null,
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
  };
}

function isCurrentNodesRequest(
  state: NodesRequestState,
  client: GatewayRequestClient,
  generation: number,
): boolean {
  return state.connected && state.client === client && state.requestGeneration === generation;
}

export async function loadNodes(state: NodesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected || state.nodesLoading) {
    return;
  }
  state.nodesLoading = true;
  if (!opts?.quiet) {
    state.lastError = null;
    state.chatError = null;
  }
  const generation = state.requestGeneration;
  try {
    const res = await client.request<{ nodes?: unknown }>("node.list", {});
    if (isCurrentNodesRequest(state, client, generation)) {
      state.nodes = Array.isArray(res.nodes) ? (res.nodes as Array<Record<string, unknown>>) : [];
    }
  } catch (err) {
    if (!opts?.quiet && isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.nodesLoading = false;
    }
  }
}

export async function loadDevices(state: DevicesState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected || state.devicesLoading) {
    return;
  }
  state.devicesLoading = true;
  if (!opts?.quiet) {
    state.devicesError = null;
  }
  const generation = state.requestGeneration;
  try {
    const res = await client.request<{
      pending?: Array<PendingDevice>;
      paired?: Array<PairedDevice>;
    }>("device.pair.list", {});
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesList = {
        pending: Array.isArray(res?.pending) ? res.pending : [],
        paired: Array.isArray(res?.paired) ? res.paired : [],
      };
    }
  } catch (err) {
    if (!opts?.quiet && isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesLoading = false;
    }
  }
}

export async function approveDevicePairing(state: DevicesState, requestId: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const generation = state.requestGeneration;
  try {
    await client.request("device.pair.approve", { requestId });
    if (isCurrentNodesRequest(state, client, generation)) {
      await loadDevices(state);
    }
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
  }
}

export async function rejectDevicePairing(state: DevicesState, requestId: string) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const generation = state.requestGeneration;
  try {
    await client.request("device.pair.reject", { requestId });
    if (isCurrentNodesRequest(state, client, generation)) {
      await loadDevices(state);
    }
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
  }
}

/** Entry removal request resolved from the unified inventory row. */
export type InventoryRemovalRequest = {
  id: string;
  name: string;
  removeNode: boolean;
  removeDevice: boolean;
};

type InventoryState = NodesState & DevicesState;

async function removeInventoryEntryRpc(
  client: GatewayRequestClient,
  entry: InventoryRemovalRequest,
) {
  // Node removal first: it revokes the node role (deleting node-only device rows)
  // and clears any legacy node pairing under the same id. A mixed-role record
  // then loses its remaining roles via the device-level removal.
  if (entry.removeNode) {
    await client.request("node.pair.remove", { nodeId: entry.id });
  }
  if (entry.removeDevice) {
    await client.request("device.pair.remove", { deviceId: entry.id });
  }
}

// Reload quietly and assign the failure afterwards: a non-quiet loadDevices
// clears devicesError first, which would erase the message before it renders.
async function reloadInventory(state: InventoryState, opts?: { error?: string }) {
  const quiet = opts?.error !== undefined;
  await Promise.all([loadDevices(state, { quiet }), loadNodes(state, { quiet })]);
  if (opts?.error !== undefined) {
    state.devicesError = opts.error;
  }
}

export async function removeInventoryEntry(state: InventoryState, entry: InventoryRemovalRequest) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  try {
    await removeInventoryEntryRpc(client, entry);
    await reloadInventory(state);
  } catch (err) {
    await reloadInventory(state, { error: formatUiError(err) });
  }
}

export async function removeStaleInventoryEntries(
  state: InventoryState,
  entries: InventoryRemovalRequest[],
) {
  const client = state.client;
  if (!client || !state.connected || entries.length === 0) {
    return;
  }
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      await removeInventoryEntryRpc(client, entry);
    } catch (err) {
      failures.push(`${entry.name}: ${formatUiError(err)}`);
    }
  }
  await reloadInventory(
    state,
    failures.length > 0
      ? {
          error: `Failed to remove ${failures.length} entr${failures.length === 1 ? "y" : "ies"}: ${failures[0]}`,
        }
      : undefined,
  );
}

export async function approveNodePairingRequest(state: InventoryState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("node.pair.approve", { requestId });
    await reloadInventory(state);
  } catch (err) {
    await reloadInventory(state, { error: formatUiError(err) });
  }
}

export async function rejectNodePairingRequest(state: InventoryState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("node.pair.reject", { requestId });
    await reloadInventory(state);
  } catch (err) {
    await reloadInventory(state, { error: formatUiError(err) });
  }
}

/**
 * How a rotation ended, for the owning page to report. The Gateway echoes the bearer
 * token only to a device rotating its own token, so a cross-device rotation is a real
 * outcome with no secret to show rather than a failure.
 */
type RotatedDeviceTokenOutcome =
  | { delivery: "in-band"; token: string }
  | { delivery: "withheld-cross-device" };

/**
 * The Gateway echoes back the raw request `deviceId` and the stored `role`, so a returned
 * grant is compared on the same trim normalization the device-auth store applies
 * (`normalizeDeviceAuthRole`) rather than by raw equality.
 */
function matchesRequestedGrant(value: unknown, requested: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === requested.trim();
}

/**
 * Parses the raw `device.token.rotate` payload, which reaches this client unvalidated:
 * the browser Gateway client resolves `frame.payload` directly, so the registered result
 * schema never runs here. Only `DeviceTokenRotateResultSchema`'s shapes are accepted —
 * a complete envelope for the requested grant, a token that is absent or a non-empty string,
 * and `tokenDelivery` paired with the secret. Anything else describes a rotation whose
 * outcome is unknown, and both dialogs would lie about it: one claims a credential arrived,
 * the other that the device re-credentials on its own. The old token is dead either way, so
 * the operator gets the error and the recovery step. Gateways released before `tokenDelivery`
 * omit only that field; they still return the rest of the result they rotated.
 */
function classifyRotationOutcome(
  payload: unknown,
  requested: { deviceId: string; role: string },
): RotatedDeviceTokenOutcome {
  const result = isRecord(payload) ? payload : undefined;
  const scopes = result?.scopes;
  const rotatedAtMs = result?.rotatedAtMs;
  // `scopes` and `rotatedAtMs` are required by the result schema, and the grant has to be the
  // one this page asked to rotate: a reply naming another device or role says nothing about
  // this request, so reporting it would tell the operator a credential they still hold was
  // replaced.
  const identified =
    matchesRequestedGrant(result?.deviceId, requested.deviceId) &&
    matchesRequestedGrant(result?.role, requested.role) &&
    Array.isArray(scopes) &&
    scopes.every((scope: unknown) => typeof scope === "string" && scope.length > 0) &&
    typeof rotatedAtMs === "number" &&
    Number.isInteger(rotatedAtMs) &&
    rotatedAtMs >= 0;
  // An absent token and a present-but-invalid one are different answers: the schema bounds
  // `token` to a non-empty string, so `token: ""` is a malformed envelope rather than a
  // rotation that withheld the secret.
  const rawToken = result?.token;
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;
  const tokenAbsent = rawToken === undefined;
  const delivery = result?.tokenDelivery;
  if (identified) {
    if (delivery === undefined) {
      if (token) {
        return { delivery: "in-band", token };
      }
      if (tokenAbsent) {
        return { delivery: "withheld-cross-device" };
      }
    }
    if (delivery === "in-band" && token) {
      return { delivery: "in-band", token };
    }
    if (delivery === "withheld-cross-device" && tokenAbsent) {
      return { delivery: "withheld-cross-device" };
    }
  }
  throw new Error(
    `Rotation returned an unusable result (tokenDelivery=${JSON.stringify(delivery)}, token ${token ? "present" : tokenAbsent ? "absent" : "malformed"}). The previous token no longer works; pair the device again if it does not reconnect.`,
  );
}

/** Rotates a device token and returns what the Gateway did with the replacement. */
export async function rotateDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string; scopes?: string[] },
): Promise<RotatedDeviceTokenOutcome | null> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const generation = state.requestGeneration;
  try {
    const { gatewayUrl, ...requestParams } = params;
    const res = await client.request<{
      token?: string;
      role?: string;
      deviceId?: string;
      scopes?: Array<string>;
      tokenDelivery?: string;
    }>("device.token.rotate", requestParams);
    const outcome = classifyRotationOutcome(res, requestParams);
    // A retired epoch stops every state write below, but never the return: the previous
    // credential is already dead on the server, so discarding this response would leave
    // the operator locked out with no way to ask for the replacement again.
    if (!isCurrentNodesRequest(state, client, generation)) {
      return outcome;
    }
    if (outcome.delivery === "in-band") {
      const identity = await loadOrCreateDeviceIdentity();
      if (!isCurrentNodesRequest(state, client, generation)) {
        return outcome;
      }
      const role = res.role ?? params.role;
      if (res.deviceId === identity.deviceId || params.deviceId === identity.deviceId) {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          gatewayUrl,
          role,
          token: outcome.token,
          scopes: res.scopes ?? params.scopes ?? [],
        });
      }
    }
    await loadDevices(state);
    return outcome;
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
    return null;
  }
}

export async function revokeDeviceToken(
  state: DevicesState,
  params: { deviceId: string; gatewayUrl: string; role: string },
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const generation = state.requestGeneration;
  try {
    const { gatewayUrl, ...requestParams } = params;
    await client.request("device.token.revoke", requestParams);
    if (!isCurrentNodesRequest(state, client, generation)) {
      return;
    }
    const identity = await loadOrCreateDeviceIdentity();
    if (!isCurrentNodesRequest(state, client, generation)) {
      return;
    }
    if (params.deviceId === identity.deviceId) {
      clearDeviceAuthToken({
        deviceId: identity.deviceId,
        gatewayUrl,
        role: params.role,
      });
    }
    if (isCurrentNodesRequest(state, client, generation)) {
      await loadDevices(state);
    }
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.devicesError = formatUiError(err);
    }
  }
}

function resolveExecApprovalsRpc(target?: ExecApprovalsTarget | null): {
  method: string;
  params: Record<string, unknown>;
} | null {
  if (!target || target.kind === "gateway") {
    return { method: "exec.approvals.get", params: {} };
  }
  const nodeId = target.nodeId.trim();
  return nodeId ? { method: "exec.approvals.node.get", params: { nodeId } } : null;
}

function resolveExecApprovalsSaveRpc(
  target: ExecApprovalsTarget | null | undefined,
  params: { file: ExecApprovalsFile; baseHash: string },
): { method: string; params: Record<string, unknown> } | null {
  if (!target || target.kind === "gateway") {
    return { method: "exec.approvals.set", params };
  }
  const nodeId = target.nodeId.trim();
  return nodeId ? { method: "exec.approvals.node.set", params: { ...params, nodeId } } : null;
}

export async function loadExecApprovals(
  state: ExecApprovalsState,
  target?: ExecApprovalsTarget | null,
) {
  const client = state.client;
  if (!client || !state.connected || state.execApprovalsLoading) {
    return;
  }
  state.execApprovalsLoading = true;
  state.lastError = null;
  state.chatError = null;
  const generation = state.requestGeneration;
  try {
    const rpc = resolveExecApprovalsRpc(target);
    if (!rpc) {
      state.lastError = "Select a node before loading exec approvals.";
      return;
    }
    const res = await client.request<ExecApprovalsSnapshot>(rpc.method, rpc.params);
    if (isCurrentNodesRequest(state, client, generation)) {
      applyExecApprovalsSnapshot(state, res);
    }
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.execApprovalsLoading = false;
    }
  }
}

function applyExecApprovalsSnapshot(state: ExecApprovalsState, snapshot: ExecApprovalsSnapshot) {
  state.execApprovalsSnapshot = snapshot;
  if (isNativeExecApprovalsSnapshot(snapshot)) {
    state.execApprovalsForm = null;
    state.execApprovalsDirty = false;
    return;
  }
  if (!state.execApprovalsDirty) {
    state.execApprovalsForm = cloneConfigObject(snapshot.file);
  }
}

export function isNativeExecApprovalsSnapshot(
  snapshot: ExecApprovalsSnapshot | null | undefined,
): snapshot is NativeExecApprovalsSnapshot {
  return Boolean(snapshot && "enabled" in snapshot);
}

export async function saveExecApprovals(
  state: ExecApprovalsState,
  target?: ExecApprovalsTarget | null,
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  state.execApprovalsSaving = true;
  state.lastError = null;
  state.chatError = null;
  const generation = state.requestGeneration;
  try {
    if (isNativeExecApprovalsSnapshot(state.execApprovalsSnapshot)) {
      state.lastError =
        "Host-native node approvals are read-only here; use the companion app or approvals set --node.";
      return;
    }
    const baseHash = state.execApprovalsSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Exec approvals hash missing; reload and retry.";
      return;
    }
    const file = state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {};
    const rpc = resolveExecApprovalsSaveRpc(target, { file, baseHash });
    if (!rpc) {
      state.lastError = "Select a node before saving exec approvals.";
      return;
    }
    await client.request(rpc.method, rpc.params);
    if (!isCurrentNodesRequest(state, client, generation)) {
      return;
    }
    state.execApprovalsDirty = false;
    await loadExecApprovals(state, target);
  } catch (err) {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentNodesRequest(state, client, generation)) {
      state.execApprovalsSaving = false;
    }
  }
}

export function updateExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
  value: unknown,
) {
  if (isNativeExecApprovalsSnapshot(state.execApprovalsSnapshot)) {
    state.lastError = "Host-native node approvals are read-only here.";
    return;
  }
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  setPathValue(base, path, value);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

export function removeExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
) {
  if (isNativeExecApprovalsSnapshot(state.execApprovalsSnapshot)) {
    state.lastError = "Host-native node approvals are read-only here.";
    return;
  }
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  removePathValue(base, path);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

function deviceAuthStorageKey(gatewayUrl: string): string {
  return `${DEVICE_AUTH_STORAGE_KEY_PREFIX}${gatewayCredentialScope(gatewayUrl)}`;
}

function removeLegacyDeviceAuthStore(storage: Storage | null) {
  try {
    storage?.removeItem(LEGACY_DEVICE_AUTH_STORAGE_KEY);
  } catch {
    // Legacy cleanup must not make an otherwise usable device token unreadable.
  }
}

function parseDeviceAuthStore(raw: string | null): DeviceAuthStore | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (!parsed || parsed.version !== 1) {
      return null;
    }
    if (!parsed.deviceId || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStore(gatewayUrl: string): DeviceAuthStore | null {
  try {
    const storage = getSafeLocalStorage();
    const scopedKey = deviceAuthStorageKey(gatewayUrl);
    const scopedStore = parseDeviceAuthStore(storage?.getItem(scopedKey) ?? null);
    if (scopedStore) {
      removeLegacyDeviceAuthStore(storage);
      return scopedStore;
    }

    const legacyStore = parseDeviceAuthStore(
      storage?.getItem(LEGACY_DEVICE_AUTH_STORAGE_KEY) ?? null,
    );
    if (!legacyStore) {
      return null;
    }

    // Older releases stored one origin-wide token. Claim it for the first gateway
    // opened after upgrade, then remove the ambiguous key before sibling routes use it.
    try {
      storage?.setItem(scopedKey, JSON.stringify(legacyStore));
      removeLegacyDeviceAuthStore(storage);
    } catch {
      // Keep the usable in-memory result when browser storage rejects the migration.
    }
    return legacyStore;
  } catch {
    return null;
  }
}

function writeStore(gatewayUrl: string, store: DeviceAuthStore) {
  try {
    const storage = getSafeLocalStorage();
    storage?.setItem(deviceAuthStorageKey(gatewayUrl), JSON.stringify(store));
    removeLegacyDeviceAuthStore(storage);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function canonicalDeviceAuthTokens(tokens: DeviceAuthStore["tokens"]) {
  const canonical: DeviceAuthStore["tokens"] = {};
  for (const [rawRole, entry] of Object.entries(tokens)) {
    const role = normalizeDeviceAuthRole(rawRole);
    if (!role || !entry || typeof entry.token !== "string") {
      continue;
    }
    canonical[role] = {
      token: entry.token,
      role,
      scopes: normalizeDeviceAuthScopes(Array.isArray(entry.scopes) ? entry.scopes : undefined),
      updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : 0,
    };
  }
  return canonical;
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = readStore(params.gatewayUrl);
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  return canonicalDeviceAuthTokens(store.tokens)[role] ?? null;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const existing = readStore(params.gatewayUrl);
  const role = normalizeDeviceAuthRole(params.role);
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  writeStore(params.gatewayUrl, {
    version: 1,
    deviceId: params.deviceId,
    tokens: {
      ...(existing?.deviceId === params.deviceId ? canonicalDeviceAuthTokens(existing.tokens) : {}),
      [role]: entry,
    },
  });
  return entry;
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}) {
  const store = readStore(params.gatewayUrl);
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeDeviceAuthRole(params.role);
  // Canonicalize before the presence check: loadDeviceAuthToken reads
  // alias-keyed entries (e.g. " operator "), so an alias-only credential must
  // also be clearable — a raw-key check here would leave it readable forever.
  const tokens = canonicalDeviceAuthTokens(store.tokens);
  if (!tokens[role]) {
    return;
  }
  delete tokens[role];
  writeStore(params.gatewayUrl, { ...store, tokens });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  // Prefer the platform digest where the context provides it; the pure-JS
  // fallback keeps identity working on plain-HTTP origins without subtle.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest("SHA-256", publicKey.slice().buffer);
    return bytesToHex(new Uint8Array(hash));
  }
  return bytesToHex((await loadPureSha2()).sha256(publicKey));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

// Storage-blocked pages (for example private browsing) must still present one
// stable device per page lifetime; minting a fresh key on every reconnect
// would raise a new unpaired request each time and never retain approval.
let sessionDeviceIdentity: DeviceIdentity | null = null;

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
        if (derivedId !== parsed.deviceId) {
          const updated: StoredIdentity = {
            ...parsed,
            deviceId: derivedId,
          };
          storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(updated));
          return {
            deviceId: derivedId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
    }
  } catch {
    // Invalid local identity is replaced below.
  }

  if (sessionDeviceIdentity) {
    return sessionDeviceIdentity;
  }
  const identity = await generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  try {
    storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A write-rejecting store still gets the in-memory identity below.
  }
  sessionDeviceIdentity = identity;
  return identity;
}

export async function signDevicePayload(privateKeyBase64Url: string, payload: string) {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
