import { ErrorCodes } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { copyToClipboard } from "../clipboard.ts";
import { serializeConfigForm } from "../config-form-utils.ts";
import { formatUiError } from "../format-error.ts";
import {
  adoptConfigSetAck,
  applyConfigSnapshot,
  clearConfigDraftTracking,
  formatConfigMutationError,
  reconcileHashlessWriteReload,
  serializeFormForSubmit,
} from "./config-draft-model.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  isCurrentRequest,
  nextRequestVersion,
  type ConfigGatewayClient,
  type LoadConfigOptions,
  type RuntimeConfigState,
} from "./config-state-model.ts";

function readAckHash(ack: unknown): string | null {
  const hash = (ack as { hash?: unknown } | null | undefined)?.hash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/**
 * Gateway contract: requireConfigBaseHash in
 * src/gateway/server-methods/config.ts rejects writes whose baseHash no
 * longer matches the file with exactly this message. A conflict means another
 * writer changed openclaw.json; retrying the whole-form draft would clobber
 * their edit, so callers surface a reload affordance instead.
 */
function isConfigBaseHashConflictError(err: unknown): boolean {
  const message = formatUiError(err);
  return message.includes("config changed since last load");
}

function isDefinitiveConfigMutationRejection(err: unknown): boolean {
  return (
    err instanceof GatewayRequestError &&
    (err.gatewayCode === ErrorCodes.INVALID_REQUEST || err.gatewayCode === ErrorCodes.FORBIDDEN)
  );
}

export type ConfigPatchOptions = {
  raw: string | Record<string, unknown>;
  note: string;
  /** Array paths the caller intentionally shrinks; required by the gateway's destructive-array guard. */
  replacePaths?: string[];
  /** Caller-owned lifecycle/access guard, rechecked at the final dispatch boundary. */
  canDispatch?: () => boolean;
};

export type ConfigPatchBuildResult = { options: ConfigPatchOptions } | { error: string };
export type ConfigPatchBuilder = (
  config: Readonly<Record<string, unknown>>,
) => ConfigPatchBuildResult;
type ConfigPatchAck = {
  config?: unknown;
  hash?: unknown;
  noop?: boolean;
};

export type RuntimeConfigExternalMutationResult<T> =
  | {
      ok: true;
      value: T;
      refresh: { ok: true } | { ok: false; error: string };
    }
  | {
      ok: false;
      reason: "conflict" | "error" | "rejected" | "suspended" | "unavailable";
      error: string;
    };

export type RuntimeConfigExternalMutationOptions = {
  waitForWritesResumed?: boolean;
  canDispatch?: () => boolean;
  dispatchError?: string;
};

export type RuntimeConfigDispatchOptions = {
  canDispatch?: () => boolean;
};

export type ConfigMethod =
  | "config.set"
  | "config.apply"
  | "config.patch"
  | "config.openFile"
  | "config.schema";

export type ConfigWriteCoordinator = {
  prepareDiscard: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  resetDraft: () => void;
  discardDraft: () => Promise<void>;
  setWritesSuspended: (suspended: boolean) => void;
  waitForPendingWrites: () => Promise<void>;
  save: (options?: RuntimeConfigDispatchOptions) => Promise<boolean>;
  apply: () => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  patchFromSnapshot: (build: ConfigPatchBuilder) => Promise<boolean>;
  runExternalMutation: <T>(
    task: (client: GatewayBrowserClient) => Promise<T>,
    options?: RuntimeConfigExternalMutationOptions,
  ) => Promise<RuntimeConfigExternalMutationResult<T>>;
  dispose: () => void;
};

export async function executeConfigExternalMutation<T>(
  state: RuntimeConfigState,
  client: GatewayBrowserClient,
  connectionEpoch: number,
  task: (client: GatewayBrowserClient) => Promise<T>,
  options: RuntimeConfigExternalMutationOptions,
  refresh: () => Promise<boolean>,
): Promise<RuntimeConfigExternalMutationResult<T>> {
  if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
    return {
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update started.",
    };
  }
  if (options.canDispatch && !options.canDispatch()) {
    return {
      ok: false,
      reason: "unavailable",
      error: options.dispatchError ?? "Access changed before the configuration update started.",
    };
  }
  let value: T;
  try {
    value = await task(client);
  } catch (error) {
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return {
        ok: false,
        reason: "unavailable",
        error: "Connection changed before the configuration update completed.",
      };
    }
    return {
      ok: false,
      reason: isConfigBaseHashConflictError(error)
        ? "conflict"
        : isDefinitiveConfigMutationRejection(error)
          ? "rejected"
          : "error",
      error: formatUiError(error),
    };
  }
  const refreshFailure = (error: string): RuntimeConfigExternalMutationResult<T> => ({
    ok: true,
    value,
    refresh: { ok: false, error },
  });
  if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
    return refreshFailure("Connection changed before the configuration update was refreshed.");
  }
  try {
    const refreshed = await refresh();
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return refreshFailure("Connection changed before the configuration update was refreshed.");
    }
    if (!refreshed) {
      return refreshFailure(
        state.lastError ??
          "The configuration update completed, but its authoritative refresh failed.",
      );
    }
    return { ok: true, value, refresh: { ok: true } };
  } catch (error) {
    return refreshFailure(formatUiError(error));
  }
}

export async function loadConfig(
  state: RuntimeConfigState,
  options: LoadConfigOptions = {},
  isCurrentLoad: () => boolean = () => true,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "config");
  state.configLoading = true;
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<ConfigSnapshot>("config.get", {});
    if (!isCurrentRequest(state, "config", version, client, connectionEpoch) || !isCurrentLoad()) {
      return false;
    }
    applyConfigSnapshot(state, res, options);
    return true;
  } catch (err) {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.lastError = formatUiError(err);
    }
    return false;
  } finally {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.configLoading = false;
    }
  }
}

export async function loadConfigSchema(state: RuntimeConfigState) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "schema");
  state.configSchemaLoading = true;
  try {
    const res = await client.request<ConfigSchemaResponse>("config.schema", {});
    if (!isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      return;
    }
    applyConfigSchema(state, res);
  } catch (err) {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.configSchemaLoading = false;
    }
  }
}

function applyConfigSchema(state: RuntimeConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

type ConfigSubmitMethod = "config.set" | "config.apply";
type ConfigSubmitBusyKey = "configSaving" | "configApplying";

async function submitConfigChange(
  state: RuntimeConfigState,
  method: ConfigSubmitMethod,
  busyKey: ConfigSubmitBusyKey,
  extraParams: Record<string, unknown> = {},
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  // Claim busy before any await so a second click cannot slip past the busy
  // state while a JSON5 original parse settles; finally releases it.
  state[busyKey] = true;
  state.lastError = null;
  state.chatError = null;
  let submittedFormRaw: string | null = null;
  try {
    if (state.configRawOriginalParsePending) {
      // JSON5 originals parse asynchronously on first load; sanitize needs them.
      await state.configRawOriginalParsePending;
      if (!isCurrent()) {
        return false;
      }
    }
    const raw = serializeFormForSubmit(state);
    // The serialized candidate includes schema coercion; a live draft can
    // change while the request is pending, so never infer from it afterward.
    submittedFormRaw = state.configFormMode === "form" ? raw : null;
    const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return false;
    }
    if (!isCurrent() || !canDispatch()) {
      return false;
    }
    // Dispatch-phase report (ackHash null): if the connection dies before the
    // ack arrives, reconnect reconciliation still needs the submitted bytes
    // to recognize its own committed write. The post-ack report below
    // overwrites this with the real hash.
    onSubmitted?.({ raw, ackHash: null });
    const ack = await client.request(method, { raw, baseHash, ...extraParams });
    // The gateway acks writes with the persisted snapshot hash. Adopt it as
    // the new draft base; config.get remains the source of applied revision truth.
    const ackHash = readAckHash(ack);
    // Reported before the epoch check: dispose-chained teardown flushes need
    // this flight's own submission even though state mutation may be blocked.
    onSubmitted?.({ raw, ackHash });
    if (!isCurrent()) {
      return false;
    }
    // Same bytes-vs-submission rule as autosave: an edit made while this
    // manual write was in flight must stay dirty (its autosave deferred into
    // a trailing run), or adoption would snap the draft back to the older
    // submitted bytes and silently discard the newer edit.
    if (serializeFormForSubmit(state) === raw) {
      state.configFormDirty = false;
      clearConfigDraftTracking(state);
    } else {
      state.configFormDirty = true;
    }
    adoptConfigSetAck(state, raw, ackHash);
    if (method === "config.apply") {
      // Older gateways omit appliedConfigHash, so keep the former process-local
      // behavior. New gateways replace this optimistic value on config.get.
      state.configNeedsApply = false;
      state.configAutoSaveStatus = "idle";
    } else {
      state.configNeedsApply = true;
    }
    // Best-effort UI refresh; correctness no longer depends on it.
    await loadConfig(state);
    if (!isCurrent()) {
      return false;
    }
    if (!ackHash) {
      reconcileHashlessWriteReload(state, raw);
    }
    if (method === "config.set") {
      // "Saved" would lie next to a draft the user re-dirtied during the
      // reload; the rescheduled save reports its own completion.
      state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
    }
    return true;
  } catch (err) {
    if (isCurrent()) {
      state.lastError = formatConfigMutationError(err, submittedFormRaw);
      if (isConfigBaseHashConflictError(err)) {
        // Applies conflict the same way saves do so the UI offers Reload.
        state.configAutoSaveStatus = "conflict";
      } else if (method === "config.set") {
        state.configAutoSaveStatus = "error";
      }
    }
    return false;
  } finally {
    if (isCurrent()) {
      state[busyKey] = false;
    }
  }
}

/**
 * Teardown flush after an in-flight save: submits the latest draft once,
 * based only on that flight's own in-memory ack hash. Callers skip the flush
 * entirely (fail closed) when no in-memory ack hash exists.
 */
export function teardownFlushConfigDraft(
  state: RuntimeConfigState,
  client: GatewayBrowserClient,
  baseHash: string,
  canDispatch: () => boolean,
): void {
  // Must stay synchronous: page unload destroys the context before any
  // deferred work runs. If a JSON5 original parse is still pending, sanitize
  // passes placeholders through; the gateway restores restorable sentinels
  // (restoreRedactedValues) and rejects unrestorable ones, so the worst case
  // matches not flushing at all while the common case saves the draft.
  if (!canDispatch()) {
    return;
  }
  const raw = serializeFormForSubmit(state);
  void client.request("config.set", { raw, baseHash }).catch(() => undefined);
}

/**
 * Auto-save submission for debounced form edits. Unlike the manual
 * `submitConfigChange` path it never raises `configSaving` (editors must stay
 * interactive while typing) and it only clears the dirty flag when the draft
 * still matches the submitted bytes — edits made while the request was in
 * flight stay dirty so the trailing save picks them up.
 */
export async function autoSaveConfig(
  state: RuntimeConfigState,
  onAck?: (ackHash: string | null) => void,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || !state.configFormDirty || state.configFormMode !== "form") {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  if (state.configRawOriginalParsePending) {
    // JSON5 originals parse asynchronously on first load; sanitize needs them.
    // Await only when pending: teardown flushes rely on a synchronous prefix.
    // Entry stays serialized across this await: runAutoSave's synchronous
    // in-flight check folds concurrent triggers into one trailing save.
    await state.configRawOriginalParsePending;
    if (!isCurrent() || !state.configFormDirty || state.configFormMode !== "form") {
      return false;
    }
  }
  const submittedRaw = serializeFormForSubmit(state);
  const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
  if (!baseHash) {
    state.configAutoSaveStatus = "error";
    state.lastError = "Config hash missing; reload and retry.";
    return false;
  }
  if (!isCurrent() || !canDispatch()) {
    return false;
  }
  state.configAutoSaveStatus = "saving";
  state.lastError = null;
  state.chatError = null;
  try {
    const ack = await client.request("config.set", { raw: submittedRaw, baseHash });
    // The gateway acks with the persisted snapshot hash. Applied revision
    // truth arrives on config.get.
    const ackHash = readAckHash(ack);
    // Reported before the epoch check: dispose-chained teardown flushes need
    // this flight's own ack even though state mutation below is blocked.
    onAck?.(ackHash);
    if (!isCurrent()) {
      return false;
    }
    state.configNeedsApply = true;
    // The submitted bytes are now the authoritative original: a draft that no
    // longer matches them (mid-flight edits, or a revert back to the pre-save
    // value) stays dirty so the trailing save runs. Computed before adoption
    // so the comparison sees the pre-save snapshot for reverted-clean drafts.
    const drained = serializeFormForSubmit(state) === submittedRaw;
    if (drained) {
      state.configFormDirty = false;
      clearConfigDraftTracking(state);
    } else {
      state.configFormDirty = true;
    }
    adoptConfigSetAck(state, submittedRaw, ackHash);
    if (!ackHash) {
      // Only a hashless ack needs a reload to re-derive the snapshot. With a
      // hash the adopted snapshot IS authoritative, and reloading here would
      // flash configLoading and lock the editors between keystrokes.
      await loadConfig(state);
      if (!isCurrent()) {
        return false;
      }
      reconcileHashlessWriteReload(state, submittedRaw);
    }
    // "Saved" would lie next to a still-dirty draft (edits during the
    // request or reload); the trailing save reports its own completion.
    state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
    return true;
  } catch (err) {
    if (isCurrent()) {
      state.lastError = formatConfigMutationError(err, submittedRaw);
      state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
    }
    return false;
  }
}

export async function saveConfig(
  state: RuntimeConfigState,
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
  canDispatch?: () => boolean,
): Promise<boolean> {
  return submitConfigChange(state, "config.set", "configSaving", {}, onSubmitted, canDispatch);
}

export async function applyConfig(
  state: RuntimeConfigState,
  canDispatch?: () => boolean,
): Promise<boolean> {
  return submitConfigChange(
    state,
    "config.apply",
    "configApplying",
    {
      sessionKey: state.applySessionKey,
    },
    undefined,
    canDispatch,
  );
}

export async function patchConfig(
  state: RuntimeConfigState,
  options: ConfigPatchOptions,
  onAck?: (ack: ConfigPatchAck, snapshotAtDispatch: ConfigSnapshot) => Promise<void> | void,
): Promise<boolean> {
  const client = state.client;
  const currentSnapshot = state.configSnapshot;
  if (!client || !state.connected || !currentSnapshot) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const baseHash = currentSnapshot.hash;
  if (!baseHash) {
    state.lastError = "Config hash missing; refresh and retry.";
    return false;
  }
  if (options.canDispatch && !options.canDispatch()) {
    return false;
  }
  state.lastError = null;
  state.chatError = null;
  try {
    const ack = await client.request<ConfigPatchAck>("config.patch", {
      baseHash,
      raw: typeof options.raw === "string" ? options.raw : JSON.stringify(options.raw),
      sessionKey: state.applySessionKey,
      note: options.note,
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    });
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return false;
    }
    const committed = ack.noop !== true;
    if (committed) {
      // The patch is committed once the gateway acknowledges it. Preserve
      // that fact even if a legacy hash-only ack requires a fallible refresh.
      state.configNeedsApply = true;
    }
    await onAck?.(ack, currentSnapshot);
    if (committed) {
      // A successful acknowledgement refresh may publish the previous
      // applied revision. Keep the existing immediate apply-needed signal;
      // reconcileAppliedRefresh replaces it with authoritative process truth.
      state.configNeedsApply = true;
    }
    return true;
  } catch (err) {
    if (isCurrentConfigConnection(state, client, connectionEpoch)) {
      state.lastError = formatUiError(err);
    }
    return false;
  }
}

export function adoptConfigPatchAck(
  state: RuntimeConfigState,
  ack: ConfigPatchAck,
  snapshotAtDispatch: ConfigSnapshot,
) {
  const ackConfig = asConfigRecord(ack.config);
  const ackHash = readAckHash(ack);
  if (!ackConfig) {
    return;
  }
  const currentSnapshot = state.configSnapshot ?? snapshotAtDispatch;
  const raw =
    ack.noop === true ? (currentSnapshot.raw ?? state.configRaw) : serializeConfigForm(ackConfig);
  applyConfigSnapshot(state, {
    ...currentSnapshot,
    config: ackConfig,
    sourceConfig: ackConfig,
    hash: ackHash ?? currentSnapshot.hash ?? null,
    raw,
    valid: true,
    issues: [],
  });
}

export async function lookupConfigSchemaPath(
  state: { client: ConfigGatewayClient | null; connected: boolean },
  path: string,
): Promise<unknown> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  try {
    const result = await client.request("config.schema.lookup", { path });
    return isCurrentConfigConnection(state, client, connectionEpoch) ? result : null;
  } catch (error) {
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return null;
    }
    throw error;
  }
}

export async function openConfigFile(state: RuntimeConfigState): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<{ ok: boolean; path?: string; error?: string }>(
      "config.openFile",
      {},
    );
    if (!isCurrent()) {
      return;
    }
    if (!res.ok) {
      let errorMessage = res.error || "Failed to open config file";
      const path = res.path || state.configSnapshot?.path;
      if (path) {
        if (await copyToClipboard(path)) {
          errorMessage += `\n\nFile path copied to clipboard: ${path}`;
        } else {
          errorMessage += `\n\nFile path: ${path}`;
        }
      }
      if (isCurrent()) {
        state.lastError = errorMessage;
      }
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    const errorMessage = formatUiError(err);
    const path = state.configSnapshot?.path;
    if (path) {
      await copyToClipboard(path);
    }
    if (isCurrent()) {
      state.lastError = errorMessage;
    }
  }
}
