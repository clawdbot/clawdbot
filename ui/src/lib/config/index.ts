// Control UI runtime config capability and shared config-domain mutations.
import JSON5 from "json5";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot, ConfigUiHints } from "../../api/types.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../clipboard.ts";
import {
  cloneConfigObject,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  serializeConfigForm,
  setPathValue,
} from "../config-form-utils.ts";
import { createAppliedConfigRefreshController } from "./applied-refresh.ts";

export type ConfigAutoSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

/** Debounce window between the last form edit and its automatic config.set. */
const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

/** Reads the additive ack hash from a config.set/config.apply response. */
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
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("config changed since last load");
}

type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  configAutoSaveStatus: ConfigAutoSaveStatus;
  /** True when the config file revision differs from the active Gateway runtime. */
  configNeedsApply: boolean;
  configSnapshot: ConfigSnapshot | null;
  configDraftBaseHash?: string | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  lastError: string | null;
  chatError?: string | null;
};

const autoAllowlistedPluginIdsByState = new WeakMap<ConfigState, Set<string>>();
const requestVersionsByState = new WeakMap<ConfigState, { config: number; schema: number }>();
const connectionEpochsByState = new WeakMap<object, number>();

type RuntimeConfigGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
};

type RuntimeConfigGateway = {
  readonly snapshot: RuntimeConfigGatewaySnapshot;
  subscribe: (listener: (snapshot: RuntimeConfigGatewaySnapshot) => void) => () => void;
};

export type RuntimeConfigCapability = {
  readonly state: ConfigState;
  ensureLoaded: () => Promise<void>;
  ensureSchemaLoaded: () => Promise<void>;
  refresh: (options?: LoadConfigOptions) => Promise<void>;
  refreshSchema: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  resetDraft: () => void;
  /** Discards pending edits: reloads from disk when connected, else resets locally. */
  discardDraft: () => Promise<void>;
  /** Pauses/resumes all config writes (autosave + manual) while e.g. the app updater runs. */
  setWritesSuspended: (suspended: boolean) => void;
  /** Resolves once no config write is in flight (used as an updater barrier). */
  waitForPendingWrites: () => Promise<void>;
  save: () => Promise<boolean>;
  apply: () => Promise<boolean>;
  openFile: () => Promise<void>;
  ensureAgentEntry: (agentId: string) => number;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  lookupSchemaPath: (path: string) => Promise<unknown>;
  subscribe: (listener: (state: ConfigState) => void) => () => void;
  dispose: () => void;
};

type LoadConfigOptions = {
  discardPendingChanges?: boolean;
};

type ConfigPatchOptions = {
  raw: string | Record<string, unknown>;
  note: string;
  /** Array paths the caller intentionally shrinks; required by the gateway's destructive-array guard. */
  replacePaths?: string[];
};

type ConfigGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ConfigConnectionState = {
  client: ConfigGatewayClient | null;
  connected: boolean;
};

type ConfigGatewayState = Pick<
  ConfigState,
  | "connected"
  | "applySessionKey"
  | "configNeedsApply"
  | "configSnapshot"
  | "lastError"
  | "chatError"
> & {
  client: ConfigGatewayClient | null;
};

function createInitialConfigState(snapshot?: Partial<RuntimeConfigGatewaySnapshot>): ConfigState {
  return {
    client: snapshot?.client ?? null,
    connected: snapshot?.connected ?? false,
    applySessionKey: snapshot?.sessionKey ?? "main",
    configLoading: false,
    configRaw: "{\n}\n",
    configRawOriginal: "",
    configValid: null,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    configAutoSaveStatus: "idle",
    configNeedsApply: false,
    configSnapshot: null,
    configDraftBaseHash: null,
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: {},
    configForm: null,
    configFormOriginal: null,
    configFormDirty: false,
    configFormMode: "form",
    configSearchQuery: "",
    configActiveSection: null,
    configActiveSubsection: null,
    lastError: null,
  };
}

function nextRequestVersion(state: ConfigState, key: "config" | "schema"): number {
  const current = requestVersionsByState.get(state) ?? { config: 0, schema: 0 };
  const next = { ...current, [key]: current[key] + 1 };
  requestVersionsByState.set(state, next);
  return next[key];
}

function currentConfigConnectionEpoch(state: object): number {
  return connectionEpochsByState.get(state) ?? 0;
}

function invalidateConfigConnection(state: object): void {
  connectionEpochsByState.set(state, currentConfigConnectionEpoch(state) + 1);
}

function isCurrentConfigConnection(
  state: ConfigConnectionState,
  client: ConfigGatewayClient,
  connectionEpoch: number,
): boolean {
  return (
    state.connected &&
    state.client === client &&
    currentConfigConnectionEpoch(state) === connectionEpoch
  );
}

function isCurrentRequest(
  state: ConfigState,
  key: "config" | "schema",
  version: number,
  client: GatewayBrowserClient,
  connectionEpoch: number,
): boolean {
  return (
    isCurrentConfigConnection(state, client, connectionEpoch) &&
    requestVersionsByState.get(state)?.[key] === version
  );
}

/** Resolves true only when a current-epoch snapshot was actually applied. */
async function loadConfig(
  state: ConfigState,
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
      state.lastError = String(err);
    }
    return false;
  } finally {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.configLoading = false;
    }
  }
}

async function loadConfigSchema(state: ConfigState) {
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
      state.lastError = String(err);
    }
  } finally {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.configSchemaLoading = false;
    }
  }
}

function applyConfigSchema(state: ConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveEditableSnapshotConfig(
  snapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  return (
    asConfigRecord(snapshot?.sourceConfig) ??
    asConfigRecord(snapshot?.resolved) ??
    asConfigRecord(snapshot?.config)
  );
}

export function currentConfigObject(
  state: Pick<ConfigState, "configForm" | "configSnapshot">,
): Record<string, unknown> | null {
  return state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
}

function applyConfigSnapshot(
  state: ConfigState,
  snapshot: ConfigSnapshot,
  options: LoadConfigOptions = {},
) {
  const preservePendingChanges = state.configFormDirty && options.discardPendingChanges !== true;
  if (options.discardPendingChanges === true) {
    // Discard resets pending edits and stale save status, but NOT the restart
    // banner: a saved-but-unapplied config still needs an apply even after
    // the local draft is thrown away.
    state.configAutoSaveStatus = "idle";
  }
  const currentRevisionHash = snapshot.configRevisionHash ?? snapshot.hash ?? null;
  if (snapshot.appliedConfigHash !== undefined) {
    state.configNeedsApply = currentRevisionHash !== snapshot.appliedConfigHash;
  }
  const draftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  state.configSnapshot = snapshot;
  const editableConfig = resolveEditableSnapshotConfig(snapshot);
  const rawAvailable =
    typeof snapshot.raw === "string" || Boolean(editableConfig) || Boolean(state.configForm);
  if (!rawAvailable && state.configFormMode === "raw") {
    state.configFormMode = "form";
  }
  const rawFromSnapshot: string =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : editableConfig
        ? serializeConfigForm(editableConfig)
        : state.configRaw;
  if (!preservePendingChanges) {
    state.configRaw = rawFromSnapshot;
  } else if (state.configFormMode !== "raw" && state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else if (state.configFormMode !== "raw") {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!preservePendingChanges) {
    state.configForm = cloneConfigObject(editableConfig ?? {});
    state.configFormOriginal = cloneConfigObject(editableConfig ?? {});
    state.configRawOriginal = rawFromSnapshot;
    state.configFormDirty = false;
    state.configFormMode = "form";
    state.configDraftBaseHash = snapshot.hash ?? null;
    autoAllowlistedPluginIdsByState.delete(state);
  } else {
    state.configDraftBaseHash = draftBaseHash;
  }
}

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

function coerceNumberString(value: string, integer: boolean): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  if (integer && !Number.isInteger(parsed)) {
    return value;
  }
  return parsed;
}

function coerceBooleanString(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return value;
}

function coerceFormValues(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (schema.allOf && schema.allOf.length > 0) {
    let next: unknown = value;
    for (const segment of schema.allOf) {
      next = coerceFormValues(next, segment);
    }
    return next;
  }

  const type = schemaType(schema);
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );

    if (variants.length === 1) {
      const variant = variants[0];
      return variant ? coerceFormValues(value, variant) : value;
    }
    if (typeof value === "string") {
      for (const variant of variants) {
        const variantType = schemaType(variant);
        if (variantType === "number" || variantType === "integer") {
          const coerced = coerceNumberString(value, variantType === "integer");
          if (coerced === undefined || typeof coerced === "number") {
            return coerced;
          }
        }
        if (variantType === "boolean") {
          const coerced = coerceBooleanString(value);
          if (typeof coerced === "boolean") {
            return coerced;
          }
        }
      }
    }
    for (const variant of variants) {
      const variantType = schemaType(variant);
      if (variantType === "object" && typeof value === "object" && !Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
      if (variantType === "array" && Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
    }
    return value;
  }

  if (type === "number" || type === "integer") {
    if (typeof value === "string") {
      const coerced = coerceNumberString(value, type === "integer");
      if (coerced === undefined || typeof coerced === "number") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "string") {
      const coerced = coerceBooleanString(value);
      if (typeof coerced === "boolean") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "string") {
    return typeof value === "string" && value.length === 0 && schema.minLength ? undefined : value;
  }
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const props = schema.properties ?? {};
    const additional =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : null;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props[key] ?? additional;
      const coerced = propSchema ? coerceFormValues(val, propSchema) : val;
      if (coerced !== undefined) {
        result[key] = coerced;
      }
    }
    return result;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return value;
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      return value.map((item, index) => {
        const itemSchema = index < items.length ? items[index] : undefined;
        return itemSchema ? coerceFormValues(item, itemSchema) : item;
      });
    }
    return items
      ? value.map((item) => coerceFormValues(item, items)).filter((item) => item !== undefined)
      : value;
  }
  return value;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
function serializeFormForSubmit(state: ConfigState): string {
  // A clean snapshot submits its raw bytes verbatim: reserializing the parsed
  // form would destroy JSON5 comments/formatting the file already has (the
  // restart banner's apply right after a raw-mode save hits exactly this).
  if (!state.configFormDirty && typeof state.configSnapshot?.raw === "string") {
    return state.configSnapshot.raw;
  }
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = asJsonSchema(state.configSchema);
  const form = schema
    ? (coerceFormValues(state.configForm, schema) as Record<string, unknown>)
    : state.configForm;
  const sanitized = sanitizeRedactedFormForSubmit(
    form,
    state.configFormOriginal,
    state.configRawOriginal,
  );
  return serializeConfigForm(sanitized);
}

type ConfigSubmitMethod = "config.set" | "config.apply";
type ConfigSubmitBusyKey = "configSaving" | "configApplying";

/**
 * Adopts a successful write ack as the authoritative local snapshot BEFORE
 * any reload: the submitted bytes are on disk under the acked hash, so the
 * raw/hash/originals must never keep describing the pre-save file (a failed
 * best-effort reload would otherwise leave stale-bytes paths alive — e.g.
 * apply re-submitting the old raw, or a revert-during-reload comparing
 * clean). Server-resolved values (secret redaction) still refresh via the
 * follow-up reload, which is purely cosmetic from here on.
 */
function adoptConfigSetAck(state: ConfigState, submittedRaw: string, ackHash: string | null) {
  const parsed = parseConfigRawDraft(submittedRaw);
  state.configSnapshot = {
    ...state.configSnapshot,
    raw: submittedRaw,
    hash: ackHash ?? state.configSnapshot?.hash ?? null,
    valid: true,
    issues: [],
    ...(parsed ? { config: parsed, sourceConfig: parsed } : {}),
  };
  state.configValid = true;
  state.configIssues = [];
  state.configRawOriginal = submittedRaw;
  if (parsed) {
    state.configFormOriginal = cloneConfigObject(parsed);
  }
  state.configDraftBaseHash = ackHash;
  if (!state.configFormDirty) {
    // Clean drafts snap to the persisted bytes, mirroring what a reload's
    // non-preserving snapshot application would do.
    state.configRaw = submittedRaw;
    if (parsed) {
      state.configForm = cloneConfigObject(parsed);
    }
  }
}

// Legacy hashless ack: when the follow-up reload returns exactly the submitted
// bytes, rebase a preserved dirty draft onto that authoritative hash. Foreign
// content matches neither and stays fail-closed.
function reconcileHashlessWriteReload(state: ConfigState, submittedRaw: string) {
  if (state.configSnapshot?.raw !== submittedRaw) {
    return;
  }
  const hash = state.configSnapshot.hash ?? null;
  if (state.configFormDirty) {
    state.configDraftBaseHash = hash ?? state.configDraftBaseHash;
  }
}

async function submitConfigChange(
  state: ConfigState,
  method: ConfigSubmitMethod,
  busyKey: ConfigSubmitBusyKey,
  extraParams: Record<string, unknown> = {},
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state[busyKey] = true;
  state.lastError = null;
  state.chatError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
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
      autoAllowlistedPluginIdsByState.delete(state);
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
      state.lastError = String(err);
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
function teardownFlushConfigDraft(
  state: ConfigState,
  client: GatewayBrowserClient,
  baseHash: string,
): void {
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
async function autoSaveConfig(
  state: ConfigState,
  onAck?: (ackHash: string | null) => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || !state.configFormDirty || state.configFormMode !== "form") {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  const submittedRaw = serializeFormForSubmit(state);
  const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
  if (!baseHash) {
    state.configAutoSaveStatus = "error";
    state.lastError = "Config hash missing; reload and retry.";
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
      autoAllowlistedPluginIdsByState.delete(state);
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
      state.lastError = String(err);
      state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
    }
    return false;
  }
}

function syncConfigDraft(state: ConfigState, nextForm: Record<string, unknown>) {
  const original = cloneConfigObject(
    state.configFormOriginal ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
  );
  const nextRaw = serializeConfigForm(nextForm);
  const originalRaw = serializeConfigForm(original);
  state.configForm = nextForm;
  state.configRaw = nextRaw;
  state.configFormDirty = nextRaw !== originalRaw;
  // configFormMode tracks which draft is authoritative for submission; a form
  // edit supersedes any earlier raw-text draft.
  state.configFormMode = "form";
  resetStaleAutoSaveStatus(state);
}

/**
 * Any mutation invalidates a lingering "Saved"/"Save failed" indicator: a
 * dirty edit is about to reschedule, and a clean revert makes the old
 * failure moot (its error is cleared too). Two states persist regardless:
 * "saving" reports the in-flight request, and "conflict" marks the snapshot
 * itself stale — only a reload clears it, no local edit can.
 */
function resetStaleAutoSaveStatus(state: ConfigState) {
  if (state.configAutoSaveStatus === "saving" || state.configAutoSaveStatus === "conflict") {
    return;
  }
  if (!state.configFormDirty && state.configAutoSaveStatus === "error") {
    state.lastError = null;
  }
  state.configAutoSaveStatus = "idle";
}

async function saveConfig(
  state: ConfigState,
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
): Promise<boolean> {
  return submitConfigChange(state, "config.set", "configSaving", {}, onSubmitted);
}

async function applyConfig(state: ConfigState): Promise<boolean> {
  return submitConfigChange(state, "config.apply", "configApplying", {
    sessionKey: state.applySessionKey,
  });
}

async function patchConfig(
  state: ConfigGatewayState,
  options: ConfigPatchOptions,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.lastError = "Config hash missing; refresh and retry.";
    return false;
  }
  state.lastError = null;
  state.chatError = null;
  try {
    const ack = await client.request<{ noop?: boolean }>("config.patch", {
      baseHash,
      raw: typeof options.raw === "string" ? options.raw : JSON.stringify(options.raw),
      sessionKey: state.applySessionKey,
      note: options.note,
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    });
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return false;
    }
    if (ack.noop !== true) {
      state.configNeedsApply = true;
    }
    return true;
  } catch (err) {
    if (isCurrentConfigConnection(state, client, connectionEpoch)) {
      state.lastError = String(err);
    }
    return false;
  }
}

async function lookupConfigSchemaPath(
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

function parseConfigRawDraft(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON5.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mutateConfigForm(state: ConfigState, mutate: (draft: Record<string, unknown>) => void) {
  let base: Record<string, unknown>;
  if (state.configFormDirty && state.configFormMode === "raw") {
    // A dirty raw draft is authoritative. Form patches (Quick Settings shares
    // this capability) may only apply on top of its parsed content — building
    // on the stale parsed form would silently destroy the raw edits.
    // Contract: merging onto the parsed raw draft is intentional — content is
    // preserved, but the unsaved raw draft's formatting/comments are not once
    // form editing resumes.
    const parsedRawDraft = parseConfigRawDraft(state.configRaw);
    if (!parsedRawDraft) {
      // Unparseable raw draft: refuse the form edit and tell the user to
      // resolve the raw buffer first; the raw draft stays authoritative.
      state.configAutoSaveStatus = "error";
      state.lastError = t("configView.rawDraftBlocksFormEdit");
      return;
    }
    base = parsedRawDraft;
  } else {
    base = cloneConfigObject(
      state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
    );
  }
  mutate(base);
  syncConfigDraft(state, base);
}

function trackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (pluginIds) {
    pluginIds.add(pluginId);
  } else {
    autoAllowlistedPluginIdsByState.set(state, new Set([pluginId]));
  }
}

function untrackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!pluginIds) {
    return;
  }
  pluginIds.delete(pluginId);
  if (pluginIds.size === 0) {
    autoAllowlistedPluginIdsByState.delete(state);
  }
}

function syncEnabledPluginAllowlist(
  state: ConfigState,
  draft: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
) {
  if (
    path.length !== 4 ||
    path[0] !== "plugins" ||
    path[1] !== "entries" ||
    typeof path[2] !== "string" ||
    path[3] !== "enabled"
  ) {
    return;
  }
  const pluginId = path[2];
  const plugins =
    draft.plugins && typeof draft.plugins === "object" && !Array.isArray(draft.plugins)
      ? (draft.plugins as Record<string, unknown>)
      : null;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : null;
  if (!allow) {
    untrackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  if (value === true) {
    if (allow.includes(pluginId)) {
      return;
    }
    if (allow.length === 0) {
      untrackAutoAllowlistedPluginId(state, pluginId);
      return;
    }
    setPathValue(draft, ["plugins", "allow"], [...allow, pluginId]);
    trackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  const autoAllowlistedPluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!autoAllowlistedPluginIds?.has(pluginId)) {
    return;
  }
  setPathValue(
    draft,
    ["plugins", "allow"],
    allow.filter((entry) => entry !== pluginId),
  );
  untrackAutoAllowlistedPluginId(state, pluginId);
}

function updateConfigFormValue(state: ConfigState, path: Array<string | number>, value: unknown) {
  mutateConfigForm(state, (draft) => {
    setPathValue(draft, path, value);
    if (path[0] === "plugins" && path[1] === "allow") {
      autoAllowlistedPluginIdsByState.delete(state);
      return;
    }
    syncEnabledPluginAllowlist(state, draft, path, value);
  });
}

function updateConfigRawValue(state: ConfigState, value: string) {
  state.configRaw = value;
  // A raw-text edit becomes the authoritative draft; without this,
  // serializeFormForSubmit would submit the stale form and drop raw edits.
  state.configFormMode = "raw";
  state.configFormDirty = value !== state.configRawOriginal;
  resetStaleAutoSaveStatus(state);
  if (state.configFormDirty) {
    state.configDraftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  } else {
    state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  }
}

function resetConfigPendingChanges(state: ConfigState) {
  const editableConfig = resolveEditableSnapshotConfig(state.configSnapshot);
  state.configForm = cloneConfigObject(state.configFormOriginal ?? editableConfig ?? {});
  state.configRaw =
    state.configRawOriginal ??
    serializeConfigForm(state.configFormOriginal ?? editableConfig ?? {});
  state.configFormDirty = false;
  state.configFormMode = "form";
  state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  autoAllowlistedPluginIdsByState.delete(state);
}

function removeConfigFormValue(state: ConfigState, path: Array<string | number>) {
  mutateConfigForm(state, (draft) => removePathValue(draft, path));
}

export function findAgentConfigEntryIndex(
  config: Record<string, unknown> | null,
  agentId: string,
): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const list = (config as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      (entry as { id?: string }).id === normalizedAgentId,
  );
}

function ensureAgentConfigEntry(state: ConfigState, agentId: string): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const existingIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (existingIndex >= 0) {
    return existingIndex;
  }
  const list = (source as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  const nextIndex = Array.isArray(list) ? list.length : 0;
  updateConfigFormValue(state, ["agents", "list", nextIndex, "id"], normalizedAgentId);
  return nextIndex;
}

function stageDefaultAgentConfigEntry(state: ConfigState, agentId: string): boolean {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return false;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const targetIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (targetIndex < 0) {
    return false;
  }
  mutateConfigForm(state, (draft) => {
    const list = (draft as { agents?: { list?: unknown[] } } | null)?.agents?.list;
    if (!Array.isArray(list)) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (i === targetIndex) {
        record.default = true;
      } else {
        delete record.default;
      }
    }
  });
  return true;
}

async function openConfigFile(state: ConfigState): Promise<void> {
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
    const errorMessage = String(err);
    const path = state.configSnapshot?.path;
    if (path) {
      await copyToClipboard(path);
    }
    if (isCurrent()) {
      state.lastError = errorMessage;
    }
  }
}

export function createRuntimeConfigCapability(
  gateway: RuntimeConfigGateway,
): RuntimeConfigCapability {
  const state = createInitialConfigState(gateway.snapshot);
  const listeners = new Set<(state: ConfigState) => void>();
  let configLoad: Promise<void> | null = null;
  let schemaLoad: Promise<void> | null = null;
  let disposed = false;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let autoSaveInFlight: Promise<unknown> | null = null;
  let autoSaveTrailing = false;
  let lastFlightSubmittedRaw: string | null = null;
  let lastFlightAckHash: string | null = null;
  let manualSubmitInFlight: Promise<unknown> | null = null;
  // A write interrupted by a connection change may or may not have committed;
  // remembered across the disconnect so the reconnect can reconcile against a
  // fresh snapshot before autosave resumes.
  let hasInterruptedWrite = false;
  let interruptedWriteRaw: string | null = null;
  // Blocks trailing autosaves while a discard drains pending writes; the
  // drained draft is about to be thrown away, not re-written.
  let suppressAutoSave = false;
  // Wakes drains awaiting a request a connection change just orphaned — that
  // request may never settle, and a drain stuck on it would wedge the app
  // updater barrier, applies, and discards until then.
  let connectionWake: (() => void) | null = null;
  let connectionWakePromise: Promise<void> = Promise.resolve();
  const armConnectionWake = () => {
    connectionWakePromise = new Promise((resolve) => {
      connectionWake = resolve;
    });
  };
  armConnectionWake();
  // App-updater interlock: config writes or gateway restarts mid-update can
  // corrupt the install, so all writes pause until the updater settles.
  let writesSuspended = false;
  // Submission info of the pending manual SAVE (applies never register:
  // a post-apply write is meaningless while the gateway restarts, so the
  // teardown flush fail-closes on them).
  let manualFlightInfo: { raw: string; ackHash: string | null } | null = null;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      const result = task();
      // Async config owners mutate their busy flag before the first await.
      // Publish that transition so editors can lock before accepting more input.
      publish();
      return await result;
    } finally {
      publish();
    }
  };
  const mutate = (task: () => void) => {
    task();
    publish();
  };
  const trackLoad = (key: "config" | "schema", promise: Promise<unknown>): Promise<void> => {
    const next = promise
      .then(() => undefined)
      .finally(() => {
        if (key === "config" && configLoad === next) {
          configLoad = null;
        } else if (key === "schema" && schemaLoad === next) {
          schemaLoad = null;
        }
      });
    if (key === "config") {
      configLoad = next;
    } else {
      schemaLoad = next;
    }
    return next;
  };
  const loadOnce = (key: "config" | "schema", task: () => Promise<unknown>): Promise<void> => {
    const current = key === "config" ? configLoad : schemaLoad;
    return current ?? trackLoad(key, run(task));
  };
  const cancelScheduledAutoSave = () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    autoSaveTrailing = false;
  };
  const appliedRefresh = createAppliedConfigRefreshController({
    shouldRefresh: () =>
      !disposed &&
      state.connected &&
      state.configNeedsApply &&
      state.configSnapshot?.appliedConfigHash !== undefined,
    refresh: (isCurrent) => loadOnce("config", () => loadConfig(state, {}, isCurrent)),
  });
  const cancelAppliedRefresh = appliedRefresh.cancel;
  const reconcileAppliedRefresh = appliedRefresh.reconcile;
  const runAutoSave = () => {
    if (disposed || suppressAutoSave || writesSuspended) {
      return;
    }
    if (autoSaveInFlight ?? manualSubmitInFlight) {
      // Exactly one trailing save catches edits made while a write (auto or
      // manual — a concurrent config.set would race the same base hash) is
      // in flight; further edits fold into that same trailing run.
      autoSaveTrailing = true;
      return;
    }
    cancelAppliedRefresh();
    // Captured for teardown: dispose compares the latest draft against the
    // in-flight submission to decide whether a final flush is needed, and the
    // flush may only CAS against this flight's own ack hash.
    lastFlightSubmittedRaw = serializeFormForSubmit(state);
    lastFlightAckHash = null;
    const flight = run(() =>
      autoSaveConfig(state, (ackHash) => {
        lastFlightAckHash = ackHash;
      }),
    )
      .catch(() => false)
      .then((saved) => {
        // A connection change deregisters flights; a stale completion must
        // not clear a NEW flight's registration or steal its trailing state.
        if (autoSaveInFlight !== flight) {
          return;
        }
        autoSaveInFlight = null;
        // One trailing save catches edits (or reverts back to the pre-save
        // value) made while the request was in flight. A still-armed debounce
        // timer owns its own save, and failed flights never self-retry.
        const wantsTrailing =
          autoSaveTrailing ||
          (saved &&
            state.configFormDirty &&
            state.configFormMode === "form" &&
            autoSaveTimer === null);
        autoSaveTrailing = false;
        if (wantsTrailing && !disposed) {
          runAutoSave();
        } else {
          reconcileAppliedRefresh();
        }
      });
    autoSaveInFlight = flight;
  };
  const scheduleAutoSave = () => {
    // Only form-draft edits auto-save; raw-text drafts stay manual so a
    // half-typed JSON5 buffer never gets written to disk. Suspended writes
    // (app updater running) stay dirty and reschedule when suspension lifts.
    if (disposed || writesSuspended || !state.configFormDirty || state.configFormMode !== "form") {
      return;
    }
    // A conflict proves the snapshot is stale; retrying against the same base
    // hash would fail again and mask the reload warning with "Saving…". Only
    // a discard/reload (which installs a fresh snapshot) re-enables autosave.
    if (state.configAutoSaveStatus === "conflict") {
      return;
    }
    cancelAppliedRefresh();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      runAutoSave();
    }, CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  };
  // Manual save/apply serialize the current draft themselves; cancel any
  // dangling debounce and settle an in-flight autosave first so the explicit
  // write does not race it on the baseHash guard. The submit starts
  // synchronously when nothing is in flight so it binds to the current
  // connection epoch.
  // Drains ALL pending config writes: the autosave chain (a settling flight
  // can spawn a trailing save) AND any manual Save still in flight.
  const drainPendingWrites = async (): Promise<void> => {
    let flight = autoSaveInFlight ?? manualSubmitInFlight;
    while (flight) {
      // Race the connection wake: a disconnect deregisters in-flight writes,
      // and a drain already awaiting one resumes from that deregistration
      // instead of depending on the transport's close-time rejection order.
      await Promise.race([flight, connectionWakePromise]);
      if (disposed) {
        return;
      }
      cancelScheduledAutoSave();
      flight = autoSaveInFlight ?? manualSubmitInFlight;
    }
  };
  // Discard barrier shared by discardDraft and refresh({discardPendingChanges}):
  // settle pending writes with trailing saves suppressed so a late completion
  // cannot trail the just-discarded bytes back to disk.
  const drainWritesForDiscard = async (): Promise<void> => {
    cancelScheduledAutoSave();
    if (autoSaveInFlight ?? manualSubmitInFlight) {
      suppressAutoSave = true;
      try {
        await drainPendingWrites();
      } finally {
        suppressAutoSave = false;
      }
    }
  };
  // Explicit ops (save/apply/patch) also serialize among THEMSELVES: two
  // callers queued behind the same in-flight write would otherwise both
  // finish draining and dispatch against the same base hash.
  let explicitOpQueue: Promise<unknown> | null = null;
  const afterPendingWritesSettled = (task: () => Promise<boolean>): Promise<boolean> => {
    if (writesSuspended) {
      return Promise.resolve(false);
    }
    cancelScheduledAutoSave();
    // Start synchronously when no explicit op is queued so the submit binds
    // to the CURRENT connection epoch; only genuine queuing pays the hop.
    const start = () =>
      run(async () => {
        // Drain before the explicit op — otherwise an apply could race a
        // pending config.set on the same base hash into a CAS failure.
        if (autoSaveInFlight ?? manualSubmitInFlight) {
          await drainPendingWrites();
        }
        // The updater may have started while we drained; suspension must be a
        // real barrier or an apply could restart the gateway mid-update.
        if (writesSuspended || disposed) {
          return false;
        }
        manualFlightInfo = null;
        const submit = task();
        const settled = submit
          .catch(() => false)
          .then(() => {
            if (manualSubmitInFlight !== settled) {
              return;
            }
            manualSubmitInFlight = null;
            // Edits made during the manual flight deferred their autosave
            // (runAutoSave treats manual flights as active writes); give them
            // their one trailing run. runAutoSave self-guards suspension.
            const wantsTrailing = autoSaveTrailing;
            autoSaveTrailing = false;
            if (wantsTrailing) {
              runAutoSave();
            }
          });
        manualSubmitInFlight = settled;
        return await submit;
      });
    const queued = explicitOpQueue ? explicitOpQueue.then(start) : start();
    const tail: Promise<unknown> = queued
      .catch(() => false)
      .then(() => {
        if (explicitOpQueue === tail) {
          explicitOpQueue = null;
        }
      });
    explicitOpQueue = tail;
    return queued;
  };
  const ensureLoaded = async () => {
    if (!state.configSnapshot) {
      await loadOnce("config", () => loadConfig(state));
    }
    reconcileAppliedRefresh();
  };
  const ensureSchemaLoaded = () =>
    state.configSchema ? Promise.resolve() : loadOnce("schema", () => loadConfigSchema(state));
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connectionChanged = state.connected !== snapshot.connected;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.applySessionKey = snapshot.sessionKey;
    if (clientChanged || connectionChanged) {
      configLoad = null;
      schemaLoad = null;
      // A reconnect may reuse the client object. Keep generations monotonic so work
      // from the previous connection cannot commit into the new connection epoch.
      invalidateConfigConnection(state);
      cancelScheduledAutoSave();
      cancelAppliedRefresh();
      if (autoSaveInFlight !== null || manualSubmitInFlight !== null) {
        // The epoch guard already blocks these flights from mutating state;
        // deregistering releases drain barriers and the trailing-save chain
        // promptly instead of waiting on the transport's close-time
        // rejection (protocol-client flushRequests rejects all pending
        // requests on socket close, so nothing here can hang forever).
        // Remember the uncertain submission for reconnect reconciliation.
        hasInterruptedWrite = true;
        interruptedWriteRaw =
          autoSaveInFlight !== null ? lastFlightSubmittedRaw : (manualFlightInfo?.raw ?? null);
        autoSaveInFlight = null;
        manualSubmitInFlight = null;
        autoSaveTrailing = false;
      }
      // Re-arm before waking so a resumed drain that loops again races the
      // fresh (still-pending) signal, not the one just resolved.
      const wake = connectionWake;
      armConnectionWake();
      wake?.();
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      if (state.configAutoSaveStatus === "saving") {
        state.configAutoSaveStatus = "idle";
      }
      // A reconnect must not strand a dirty draft whose debounce was just
      // cancelled; reschedule against the new connection. If the file moved
      // while offline, the save reports a baseHash conflict instead of
      // clobbering the other writer.
      if (state.connected && state.client) {
        if (hasInterruptedWrite) {
          // The interrupted write may or may not have committed. Fetch the
          // authoritative snapshot before autosave resumes so an uncertain
          // flight can't strand a clean-looking draft or retry a stale base.
          const interruptedRaw = interruptedWriteRaw;
          // A revert made while the write was in flight reads clean (the ack
          // never rebased the originals), so the reload below would replace
          // it with the committed bytes. Capture it for restoration.
          const draftFormBefore =
            state.configFormMode === "form" && !state.configFormDirty && state.configForm
              ? cloneConfigObject(state.configForm)
              : null;
          const draftRawBefore = draftFormBefore ? serializeConfigForm(draftFormBefore) : null;
          const reconcile = run(() => loadConfig(state));
          void trackLoad("config", reconcile);
          void reconcile.then((loaded) => {
            if (disposed) {
              return;
            }
            if (!loaded || !state.connected) {
              // Reload failed or the connection flipped again: keep the
              // interruption metadata so the NEXT reconnect retries
              // reconciliation instead of silently taking the plain path.
              // A dirty draft may still reschedule; a stale base surfaces
              // as a conflict with its Reload recovery, never a clobber.
              scheduleAutoSave();
              reconcileAppliedRefresh();
              return;
            }
            hasInterruptedWrite = false;
            interruptedWriteRaw = null;
            // If the interrupted write DID commit, the fresh snapshot is
            // exactly its bytes. Rebase a surviving draft onto the fresh hash
            // so the retry doesn't false-conflict against our own write. Any
            // other server content keeps the old base and conflicts instead
            // of clobbering a foreign writer.
            if (interruptedRaw !== null && state.configSnapshot?.raw === interruptedRaw) {
              const freshHash = state.configSnapshot.hash ?? null;
              if (state.configSnapshot.appliedConfigHash === undefined) {
                state.configNeedsApply = true;
              }
              if (state.configFormDirty) {
                state.configDraftBaseHash = freshHash ?? state.configDraftBaseHash;
              } else if (
                draftFormBefore &&
                draftRawBefore !== null &&
                draftRawBefore !== interruptedRaw
              ) {
                // Reverted-while-in-flight: the clean-looking pre-reload
                // draft differs from the committed bytes, so it was a real
                // revert. Restore it as a dirty draft on the fresh base so
                // the rescheduled autosave writes it back.
                state.configForm = draftFormBefore;
                state.configRaw = draftRawBefore;
                state.configFormMode = "form";
                state.configFormDirty = true;
                state.configDraftBaseHash = freshHash ?? state.configDraftBaseHash;
              }
            }
            publish();
            scheduleAutoSave();
            reconcileAppliedRefresh();
          });
        } else {
          scheduleAutoSave();
          reconcileAppliedRefresh();
        }
      }
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    ensureLoaded,
    ensureSchemaLoaded,
    refresh: async (options) => {
      if (options?.discardPendingChanges) {
        await drainWritesForDiscard();
      }
      cancelAppliedRefresh();
      try {
        await trackLoad(
          "config",
          run(() => loadConfig(state, options)),
        );
      } finally {
        reconcileAppliedRefresh();
      }
    },
    refreshSchema: () =>
      trackLoad(
        "schema",
        run(() => loadConfigSchema(state)),
      ),
    patchForm: (path, value) => {
      mutate(() => updateConfigFormValue(state, path, value));
      scheduleAutoSave();
    },
    removeFormValue: (path) => {
      mutate(() => removeConfigFormValue(state, path));
      scheduleAutoSave();
    },
    setRaw: (value) => mutate(() => updateConfigRawValue(state, value)),
    resetDraft: () => {
      cancelScheduledAutoSave();
      mutate(() => resetConfigPendingChanges(state));
      reconcileAppliedRefresh();
    },
    discardDraft: async () => {
      // Settle pending writes first (with trailing saves suppressed — the
      // draft is being thrown away, not re-written) so a late ack cannot
      // re-dirty or trail-write over the discard.
      await drainWritesForDiscard();
      if (state.connected && state.client) {
        cancelAppliedRefresh();
        try {
          await trackLoad(
            "config",
            run(() => loadConfig(state, { discardPendingChanges: true })),
          );
        } finally {
          reconcileAppliedRefresh();
        }
        return;
      }
      // Offline: a network refresh would silently no-op and strand the
      // draft; fall back to a pure local reset onto the snapshot originals.
      mutate(() => {
        resetConfigPendingChanges(state);
        // Conflict marks the snapshot itself stale; an offline reset onto
        // those stale originals must NOT pretend to have reconciled — only a
        // connected reload clears conflict (same invariant as elsewhere).
        if (state.configAutoSaveStatus !== "conflict") {
          state.configAutoSaveStatus = "idle";
          state.lastError = null;
        }
      });
    },
    setWritesSuspended: (suspended) => {
      if (writesSuspended === suspended) {
        return;
      }
      writesSuspended = suspended;
      if (suspended) {
        cancelScheduledAutoSave();
      } else {
        // Edits made during the update save once it ends.
        scheduleAutoSave();
      }
    },
    waitForPendingWrites: () => drainPendingWrites(),
    save: () =>
      afterPendingWritesSettled(async () => {
        cancelAppliedRefresh();
        try {
          return await saveConfig(state, (info) => {
            manualFlightInfo = info;
          });
        } finally {
          reconcileAppliedRefresh();
        }
      }),
    apply: () =>
      afterPendingWritesSettled(async () => {
        cancelAppliedRefresh();
        // Checked after the drain: a raw draft whose explicit Save is in
        // flight resolves clean and may apply. A raw draft that is STILL
        // dirty here was never reviewed-saved — applying would implicitly
        // write unreviewed raw text, so refuse and point at the Raw editor.
        if (state.configFormDirty && state.configFormMode === "raw") {
          state.configAutoSaveStatus = "error";
          state.lastError = t("configView.rawDraftBlocksApply");
          reconcileAppliedRefresh();
          return false;
        }
        try {
          return await applyConfig(state);
        } finally {
          reconcileAppliedRefresh();
        }
      }),
    openFile: () => run(() => openConfigFile(state)),
    ensureAgentEntry: (agentId) => {
      const index = ensureAgentConfigEntry(state, agentId);
      publish();
      scheduleAutoSave();
      return index;
    },
    stageDefaultAgent: (agentId) => {
      const changed = stageDefaultAgentConfigEntry(state, agentId);
      publish();
      scheduleAutoSave();
      return changed;
    },
    // Patches are config writes too: they must honor updater suspension and
    // register as a drainable flight, or a patch could overlap update.run.
    // Unlike save/apply, a patch does not submit the form draft — flush a
    // scheduled autosave into a flight first (the settle below drains it) and
    // re-arm the debounce after so a dirty form is never left timer-less.
    patch: (options) => {
      cancelAppliedRefresh();
      if (autoSaveTimer) {
        cancelScheduledAutoSave();
        runAutoSave();
      }
      return afterPendingWritesSettled(async () => {
        // A drained autosave can start its own refresh while this patch waits.
        cancelAppliedRefresh();
        try {
          return await patchConfig(state, options);
        } finally {
          reconcileAppliedRefresh();
        }
      }).finally(() => {
        scheduleAutoSave();
      });
    },
    lookupSchemaPath: (path) => run(() => lookupConfigSchemaPath(state, path)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      // Free any drain awaiting a flight that will never be reconciled now;
      // the disposed guard exits its loop.
      connectionWake?.();
      // SPA teardown right after an edit must not silently drop it: fire one
      // last save before timers die. Fire-and-forget — the request leaves
      // synchronously (or chains once behind an in-flight save) and the
      // stale-epoch guards skip all state mutation once the connection is
      // invalidated below.
      const client = state.client;
      const canFlush =
        state.connected && client !== null && state.configFormMode === "form" && !writesSuspended;
      const autoFlight = autoSaveInFlight;
      const pendingFlight = autoFlight ?? manualSubmitInFlight;
      cancelScheduledAutoSave();
      appliedRefresh.dispose();
      if (canFlush && pendingFlight) {
        void pendingFlight.then(() => {
          // The settled flight could not update dirty/base state past the
          // epoch guard; a draft whose bytes differ from that submission is a
          // newer edit and gets exactly one chained final save — never a
          // parallel one. Auto flights report via lastFlight*, manual saves
          // via manualFlightInfo; applies never register info (a post-apply
          // write is meaningless while the gateway restarts), and without the
          // flight's own ack hash there is no CAS base we can trust — both
          // fail closed rather than risk clobbering a foreign write.
          const submitted = autoFlight
            ? { raw: lastFlightSubmittedRaw, ackHash: lastFlightAckHash }
            : manualFlightInfo;
          const ackHash = submitted?.ackHash ?? null;
          const submittedRaw = submitted?.raw ?? null;
          // Bytes-vs-submission is the only trustworthy signal here: the
          // epoch guard blocked the ack's rebase, so a revert back to the
          // pre-save value reads configFormDirty=false while the persisted
          // bytes are still the unreverted submission.
          if (ackHash && submittedRaw !== null && serializeFormForSubmit(state) !== submittedRaw) {
            teardownFlushConfigDraft(state, client, ackHash);
          }
        });
      } else if (canFlush && state.configFormDirty) {
        void autoSaveConfig(state);
      }
      invalidateConfigConnection(state);
      state.connected = false;
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      stopGateway();
      listeners.clear();
      requestVersionsByState.delete(state);
      autoAllowlistedPluginIdsByState.delete(state);
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
