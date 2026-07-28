// Tracks host hook state and scheduled turn identifiers.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import {
  resolveSessionEntryAccessTarget,
  updateResolvedSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildPluginAgentTurnPrepareContext,
  isPluginJsonValue,
  type PluginAgentTurnPrepareResult,
  type PluginJsonValue,
  type PluginNextTurnInjection,
  type PluginNextTurnInjectionEnqueueResult,
  type PluginNextTurnInjectionRecord,
  type PluginSessionExtensionProjection,
  type PluginSessionExtensionRegistration,
} from "./host-hooks.js";
import { getActivePluginRegistry, getActivePluginSessionExtensionRegistry } from "./runtime.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";

const log = createSubsystemLogger("plugins/host-hook-state");
const PROJECTION_FAILED = Symbol("plugin-session-extension-projection-failed");
const MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH = 32 * 1024;
const MAX_PLUGIN_NEXT_TURN_INJECTION_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION = 32;

function normalizeNamespace(value: string): string {
  return value.trim();
}

function copyJsonValue(value: PluginJsonValue): PluginJsonValue {
  return structuredClone(value);
}

function isPluginNextTurnInjectionPlacement(
  value: unknown,
): value is PluginNextTurnInjectionRecord["placement"] {
  return value === "prepend_context" || value === "append_context";
}

function isPluginNextTurnInjectionRecord(value: unknown): value is PluginNextTurnInjectionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PluginNextTurnInjectionRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.pluginId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    isPluginNextTurnInjectionPlacement(candidate.placement) &&
    (candidate.ttlMs === undefined ||
      (typeof candidate.ttlMs === "number" &&
        Number.isFinite(candidate.ttlMs) &&
        candidate.ttlMs >= 0)) &&
    (candidate.idempotencyKey === undefined || typeof candidate.idempotencyKey === "string")
  );
}

function isExpired(entry: unknown, now: number) {
  if (!isPluginNextTurnInjectionRecord(entry)) {
    return true;
  }
  return typeof entry.ttlMs === "number" && entry.ttlMs >= 0 && now - entry.createdAt > entry.ttlMs;
}

function isPluginPromptInjectionEnabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const entry = cfg.plugins?.entries?.[pluginId];
  return entry?.hooks?.allowPromptInjection !== false;
}

function toPluginNextTurnInjectionRecord(params: {
  pluginId: string;
  pluginName?: string;
  injection: PluginNextTurnInjection;
  now: number;
}): PluginNextTurnInjectionRecord {
  return {
    id: params.injection.idempotencyKey?.trim() || randomUUID(),
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    text: params.injection.text,
    idempotencyKey: params.injection.idempotencyKey?.trim() || undefined,
    placement: params.injection.placement ?? "prepend_context",
    ttlMs: params.injection.ttlMs,
    createdAt: params.now,
    metadata: params.injection.metadata,
  };
}

export async function enqueuePluginNextTurnInjection(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  pluginName?: string;
  injection: PluginNextTurnInjection;
  now?: number;
}): Promise<PluginNextTurnInjectionEnqueueResult> {
  if (typeof params.injection.sessionKey !== "string") {
    return { enqueued: false, id: "", sessionKey: "" };
  }
  const sessionKey = params.injection.sessionKey.trim();
  if (!sessionKey) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (typeof params.injection.text !== "string") {
    return { enqueued: false, id: "", sessionKey };
  }
  const text = params.injection.text.trim();
  if (!text) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (text.length > MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (params.injection.metadata !== undefined && !isPluginJsonValue(params.injection.metadata)) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (
    params.injection.idempotencyKey !== undefined &&
    (typeof params.injection.idempotencyKey !== "string" ||
      params.injection.idempotencyKey.trim().length === 0 ||
      params.injection.idempotencyKey.length >
        MAX_PLUGIN_NEXT_TURN_INJECTION_IDEMPOTENCY_KEY_LENGTH)
  ) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (
    params.injection.placement !== undefined &&
    !isPluginNextTurnInjectionPlacement(params.injection.placement)
  ) {
    return { enqueued: false, id: "", sessionKey };
  }
  if (
    params.injection.ttlMs !== undefined &&
    (!Number.isFinite(params.injection.ttlMs) || params.injection.ttlMs < 0)
  ) {
    return { enqueued: false, id: "", sessionKey };
  }
  const now = params.now ?? Date.now();
  const record = toPluginNextTurnInjectionRecord({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    injection: { ...params.injection, sessionKey, text },
    now,
  });
  const updated = await updateResolvedSessionEntry({ cfg: params.cfg, sessionKey }, (entry) => {
    let enqueued = false;
    let resultId = record.id;
    const injections = { ...entry.pluginNextTurnInjections };
    // Guard against malformed/hand-edited persisted state — a non-array value
    // here would crash the spread/filter and break the whole session's enqueue.
    const rawExisting = injections[params.pluginId];
    const existing = (Array.isArray(rawExisting) ? [...rawExisting] : []).filter(
      (candidate): candidate is PluginNextTurnInjectionRecord => !isExpired(candidate, now),
    );
    const duplicate = record.idempotencyKey
      ? existing.find((candidate) => candidate.idempotencyKey === record.idempotencyKey)
      : undefined;
    if (duplicate) {
      resultId = duplicate.id;
      injections[params.pluginId] = existing;
      entry.pluginNextTurnInjections = injections;
      return { enqueued, id: resultId };
    }
    if (existing.length >= MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION) {
      injections[params.pluginId] = existing;
      entry.pluginNextTurnInjections = injections;
      return { enqueued, id: resultId };
    }
    injections[params.pluginId] = [...existing, record];
    entry.pluginNextTurnInjections = injections;
    entry.updatedAt = now;
    enqueued = true;
    return { enqueued, id: resultId };
  });
  if (!updated.found) {
    return { enqueued: false, id: "", sessionKey };
  }
  return { ...updated.result, sessionKey: updated.canonicalKey };
}

async function drainPluginNextTurnInjections(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  now?: number;
}): Promise<PluginNextTurnInjectionRecord[]> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const target = resolveSessionEntryAccessTarget({ cfg: params.cfg, sessionKey });
  if (!target.entry) {
    return [];
  }
  // Avoid a locked session-entry rewrite when there is nothing queued.
  // Drain runs once per prompt build; the common case is no injections, so a
  // pre-flight read keeps prompt-build off the session-store write path.
  // (Concurrently-enqueued injections during this gap land on the next turn.)
  if (
    !target.entry.pluginNextTurnInjections ||
    Object.keys(target.entry.pluginNextTurnInjections).length === 0
  ) {
    return [];
  }
  const now = params.now ?? Date.now();
  const updated = await updateResolvedSessionEntry({ cfg: params.cfg, sessionKey }, (entry) => {
    if (!entry?.pluginNextTurnInjections) {
      return [];
    }
    const activePluginIds = new Set(
      (getActivePluginRegistry()?.plugins ?? [])
        .filter((plugin) => plugin.status === "loaded")
        .map((plugin) => plugin.id),
    );
    const drained: PluginNextTurnInjectionRecord[] = [];
    for (const [pluginId, entries] of Object.entries(entry.pluginNextTurnInjections)) {
      if (!activePluginIds.has(pluginId) || !isPluginPromptInjectionEnabled(params.cfg, pluginId)) {
        continue;
      }
      // Guard against malformed/hand-edited persisted state — a non-array value
      // here would crash .filter and break prompt-building for the session.
      if (!Array.isArray(entries)) {
        continue;
      }
      const liveEntries = entries.filter(
        (candidate): candidate is PluginNextTurnInjectionRecord => !isExpired(candidate, now),
      );
      drained.push(...liveEntries);
    }
    drained.sort((left, right) => left.createdAt - right.createdAt);
    // A drain is the consume boundary for this session queue. Inactive plugin
    // records are stale owner state and are discarded with expired records.
    delete entry.pluginNextTurnInjections;
    if (drained.length > 0) {
      entry.updatedAt = now;
    }
    return drained;
  });
  return updated.found ? updated.result : [];
}

export async function drainPluginNextTurnInjectionContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  now?: number;
}): Promise<PluginAgentTurnPrepareResult & { queuedInjections: PluginNextTurnInjectionRecord[] }> {
  const queuedInjections = await drainPluginNextTurnInjections(params);
  return {
    queuedInjections,
    ...buildPluginAgentTurnPrepareContext({ queuedInjections }),
  };
}

export function getPluginSessionExtensionStateSync(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  sessionKey?: string;
}): Record<string, PluginJsonValue> | undefined {
  const pluginId = params.pluginId.trim();
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!pluginId || !sessionKey) {
    return undefined;
  }
  const target = resolveSessionEntryAccessTarget({ cfg: params.cfg, sessionKey });
  const value = target.entry?.pluginExtensions?.[pluginId] as
    | Record<string, PluginJsonValue>
    | undefined;
  return value ? (copyJsonValue(value) as Record<string, PluginJsonValue>) : undefined;
}

export async function patchPluginSessionExtension(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  pluginId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
  assertCurrent?: () => void;
}): Promise<{ ok: true; key: string; value?: PluginJsonValue } | { ok: false; error: string }> {
  const namespace = normalizeNamespace(params.namespace);
  const pluginId = params.pluginId.trim();
  if (!pluginId || !namespace) {
    return { ok: false, error: "pluginId and namespace are required" };
  }
  if (params.unset === true && params.value !== undefined) {
    return { ok: false, error: "plugin session extension cannot specify both unset and value" };
  }
  if (params.value !== undefined && !isPluginJsonValue(params.value)) {
    return { ok: false, error: "plugin session extension value must be JSON-compatible" };
  }
  if (params.unset !== true && params.value === undefined) {
    return { ok: false, error: "plugin session extension value is required unless unset is true" };
  }
  const nextPluginValue = params.value as PluginJsonValue;
  const registry = getActivePluginSessionExtensionRegistry();
  const registration = (registry?.sessionExtensions ?? []).find(
    (entry) => entry.pluginId === pluginId && entry.extension.namespace === namespace,
  );
  if (!registration) {
    return { ok: false, error: `unknown plugin session extension: ${pluginId}/${namespace}` };
  }
  // Promote the projected value into a top-level SessionEntry slot when the
  // extension opted in via `sessionEntrySlotKey`. The slot is a read-only
  // mirror: writes still go through patchSessionExtension; the host overwrites
  // the slot value on every patch and clears it on unset.
  const rawSlotKey = normalizeOptionalString(registration.extension.sessionEntrySlotKey);
  const normalizedSlotKey = rawSlotKey ? normalizeSessionEntrySlotKey(rawSlotKey) : undefined;
  if (normalizedSlotKey?.ok === false) {
    log.warn(
      `plugin session extension slot promotion skipped for ${pluginId}/${namespace}: ${normalizedSlotKey.error}`,
    );
  }
  const slotKey = normalizedSlotKey?.ok === true ? normalizedSlotKey.key : undefined;
  const updated = await updateResolvedSessionEntry(
    { cfg: params.cfg, sessionKey: params.sessionKey },
    (entry, context) => {
      params.assertCurrent?.();
      const entryRecord = entry as Record<string, unknown>;
      const pluginExtensions = { ...entry.pluginExtensions };
      const pluginState = { ...pluginExtensions[pluginId] };
      if (params.unset === true) {
        delete pluginState[namespace];
      } else {
        pluginState[namespace] = copyJsonValue(nextPluginValue);
      }
      if (Object.keys(pluginState).length > 0) {
        pluginExtensions[pluginId] = pluginState;
      } else {
        delete pluginExtensions[pluginId];
      }
      if (Object.keys(pluginExtensions).length > 0) {
        entry.pluginExtensions = pluginExtensions;
      } else {
        delete entry.pluginExtensions;
      }
      const storedSlotKeys = { ...entry.pluginExtensionSlotKeys };
      const pluginSlotKeys = { ...storedSlotKeys[pluginId] };
      const previousSlotKey = normalizeSessionEntrySlotKey(pluginSlotKeys[namespace]);
      if (previousSlotKey.ok && previousSlotKey.key !== slotKey) {
        delete entryRecord[previousSlotKey.key];
      }
      if (slotKey && params.unset !== true) {
        pluginSlotKeys[namespace] = slotKey;
      } else {
        delete pluginSlotKeys[namespace];
      }
      if (Object.keys(pluginSlotKeys).length > 0) {
        storedSlotKeys[pluginId] = pluginSlotKeys;
      } else {
        delete storedSlotKeys[pluginId];
      }
      if (Object.keys(storedSlotKeys).length > 0) {
        entry.pluginExtensionSlotKeys = storedSlotKeys;
      } else {
        delete entry.pluginExtensionSlotKeys;
      }
      if (slotKey) {
        const projected = projectSessionExtensionValueForSlot({
          registration,
          sessionKey: context.canonicalKey,
          sessionId: entry.sessionId,
          nextValue: params.unset === true ? undefined : nextPluginValue,
        });
        if (projected === undefined) {
          delete entryRecord[slotKey];
        } else {
          entryRecord[slotKey] = projected;
        }
      }
      entry.updatedAt = Date.now();
      return pluginState[namespace] as PluginJsonValue | undefined;
    },
  );
  if (!updated.found) {
    return { ok: false, error: `unknown session key: ${params.sessionKey}` };
  }
  return { ok: true, key: updated.canonicalKey, value: updated.result };
}

/**
 * Resolve the value that should be mirrored to `SessionEntry[slotKey]` for a
 * promoted session-extension namespace. Failures are swallowed so a
 * misbehaving projector cannot block the primary patch from being persisted.
 */
function projectSessionExtensionValueForSlot(params: {
  registration: { pluginId: string; extension: PluginSessionExtensionRegistration };
  sessionKey: string;
  sessionId?: string;
  nextValue: PluginJsonValue | undefined;
}): PluginJsonValue | undefined {
  if (params.nextValue === undefined) {
    return undefined;
  }
  const projected = projectSessionExtensionValue({
    pluginId: params.registration.pluginId,
    namespace: params.registration.extension.namespace,
    project: params.registration.extension.project,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    state: params.nextValue,
  });
  if (projected === PROJECTION_FAILED) {
    return undefined;
  }
  if (isPromiseLike(projected)) {
    discardUnexpectedPromiseProjection(projected);
    return undefined;
  }
  if (projected === undefined || !isPluginJsonValue(projected)) {
    return undefined;
  }
  return copyJsonValue(projected);
}

function collectPluginSessionExtensionProjections(params: {
  sessionKey: string;
  entry: SessionEntry;
}): PluginSessionExtensionProjection[] {
  const registry = getActivePluginSessionExtensionRegistry();
  const extensions = registry?.sessionExtensions ?? [];
  if (extensions.length === 0) {
    return [];
  }
  const projections: PluginSessionExtensionProjection[] = [];
  for (const registration of extensions) {
    const state = params.entry.pluginExtensions?.[registration.pluginId]?.[
      registration.extension.namespace
    ] as PluginJsonValue | undefined;
    if (state === undefined) {
      continue;
    }
    const projected = projectSessionExtensionValue({
      pluginId: registration.pluginId,
      namespace: registration.extension.namespace,
      project: registration.extension.project,
      sessionKey: params.sessionKey,
      sessionId: params.entry.sessionId,
      state,
    });
    if (projected === PROJECTION_FAILED) {
      continue;
    }
    if (isPromiseLike(projected)) {
      discardUnexpectedPromiseProjection(projected);
      continue;
    }
    if (projected !== undefined && isPluginJsonValue(projected)) {
      // Validate the projection in both branches: with a projector the
      // projector might return arbitrary values; without one the persisted
      // state could be hand-edited or malformed. Always run the size + shape
      // check before pushing into pluginExtensions.
      projections.push({
        pluginId: registration.pluginId,
        namespace: registration.extension.namespace,
        value: copyJsonValue(projected),
      });
    }
  }
  return projections;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function discardUnexpectedPromiseProjection(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}

function projectSessionExtensionValue(params: {
  pluginId: string;
  namespace: string;
  project?: (ctx: {
    sessionKey: string;
    sessionId?: string;
    state: PluginJsonValue | undefined;
  }) => PluginJsonValue | undefined;
  sessionKey: string;
  sessionId?: string;
  state: PluginJsonValue;
}): PluginJsonValue | undefined | PromiseLike<unknown> | typeof PROJECTION_FAILED {
  try {
    return params.project
      ? (params.project({
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          state: params.state,
        }) as PluginJsonValue | undefined | PromiseLike<unknown>)
      : params.state;
  } catch (error) {
    log.warn(
      `plugin session extension projection failed: plugin=${params.pluginId} namespace=${params.namespace} error=${String(error)}`,
    );
    return PROJECTION_FAILED;
  }
}

export function projectPluginSessionExtensionsSync(params: {
  sessionKey: string;
  entry: SessionEntry;
}): PluginSessionExtensionProjection[] {
  return collectPluginSessionExtensionProjections(params);
}
