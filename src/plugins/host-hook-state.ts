import { randomUUID } from "node:crypto";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../gateway/session-store-key.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
export { clearPluginOwnedSessionState } from "./host-hook-cleanup.js";
import {
  buildPluginAgentTurnPrepareContext,
  isPluginJsonValue,
  type PluginAgentTurnPrepareResult,
  type PluginJsonValue,
  type PluginNextTurnInjection,
  type PluginNextTurnInjectionEnqueueResult,
  type PluginNextTurnInjectionRecord,
  type PluginSessionExtensionProjection,
} from "./host-hooks.js";
import { getActivePluginRegistry } from "./runtime.js";

const log = createSubsystemLogger("plugins/host-hook-state");
const PROJECTION_FAILED = Symbol("plugin-session-extension-projection-failed");
const MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH = 32 * 1024;
const MAX_PLUGIN_NEXT_TURN_INJECTION_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION = 32;

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

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

function findStoreKeysIgnoreCase(store: Record<string, unknown>, targetKey: string): string[] {
  const lowered = normalizeLowercaseStringOrEmpty(targetKey);
  const matches: string[] = [];
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lowered) {
      matches.push(key);
    }
  }
  return matches;
}

function findFreshestStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  let freshest: { entry: SessionEntry; key: string } | undefined;
  for (const candidate of candidates) {
    const trimmed = normalizeOptionalString(candidate) ?? "";
    if (!trimmed) {
      continue;
    }
    const exact = store[trimmed];
    if (exact && (!freshest || (exact.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) {
      freshest = { entry: exact, key: trimmed };
    }
    for (const legacyKey of findStoreKeysIgnoreCase(store, trimmed)) {
      const entry = store[legacyKey];
      if (entry && (!freshest || (entry.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) {
        freshest = { entry, key: legacyKey };
      }
    }
  }
  return freshest;
}

function resolveSessionStoreCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): SessionStoreTarget[] {
  const storeConfig = params.cfg.session?.store;
  const defaultTarget = {
    agentId: params.agentId,
    storePath: resolveStorePath(storeConfig, { agentId: params.agentId }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    if (target.agentId === params.agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function buildSessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function loadPluginHostHookSessionEntry(params: { cfg: OpenClawConfig; sessionKey: string }): {
  storePath: string;
  entry?: SessionEntry;
  canonicalKey: string;
  storeKey: string;
} {
  const key = normalizeOptionalString(params.sessionKey) ?? "";
  const cfg = params.cfg;
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const scanTargets = buildSessionStoreScanTargets({ cfg, key, canonicalKey, agentId });
  const candidates = resolveSessionStoreCandidates({ cfg, agentId });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveStorePath(cfg.session?.store, { agentId }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findFreshestStoreMatch(loadSessionStore(fallback.storePath), ...scanTargets);
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findFreshestStoreMatch(loadSessionStore(candidate.storePath), ...scanTargets);
    if (
      match &&
      (!selectedMatch || (match.entry.updatedAt ?? 0) >= (selectedMatch.entry.updatedAt ?? 0))
    ) {
      selectedStorePath = candidate.storePath;
      selectedMatch = match;
    }
  }
  return {
    storePath: selectedStorePath,
    entry: selectedMatch?.entry,
    canonicalKey,
    storeKey: selectedMatch?.key ?? canonicalKey,
  };
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
  const loaded = loadPluginHostHookSessionEntry({ cfg: params.cfg, sessionKey });
  if (!loaded.entry) {
    return { enqueued: false, id: "", sessionKey };
  }
  const canonicalKey = loaded.canonicalKey ?? sessionKey;
  const now = params.now ?? Date.now();
  const record = toPluginNextTurnInjectionRecord({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    injection: { ...params.injection, sessionKey, text },
    now,
  });
  let enqueued = false;
  let resultId = record.id;
  await updateSessionStore(loaded.storePath, (store) => {
    const entry = store[loaded.storeKey];
    if (!entry) {
      return;
    }
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
      return;
    }
    if (existing.length >= MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION) {
      injections[params.pluginId] = existing;
      entry.pluginNextTurnInjections = injections;
      return;
    }
    injections[params.pluginId] = [...existing, record];
    entry.pluginNextTurnInjections = injections;
    entry.updatedAt = now;
    enqueued = true;
  });
  return { enqueued, id: resultId, sessionKey: canonicalKey };
}

export async function drainPluginNextTurnInjections(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  now?: number;
}): Promise<PluginNextTurnInjectionRecord[]> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const loaded = loadPluginHostHookSessionEntry({ cfg: params.cfg, sessionKey });
  if (!loaded.entry) {
    return [];
  }
  // Avoid the locked re-save in updateSessionStore when there is nothing queued.
  // Drain runs once per prompt build; the common case is no injections, so a
  // pre-flight read keeps prompt-build off the session-store write path.
  // (Concurrently-enqueued injections during this gap land on the next turn.)
  if (
    !loaded.entry.pluginNextTurnInjections ||
    Object.keys(loaded.entry.pluginNextTurnInjections).length === 0
  ) {
    return [];
  }
  const now = params.now ?? Date.now();
  return await updateSessionStore(loaded.storePath, (store) => {
    const entry = store[loaded.storeKey];
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

export async function patchPluginSessionExtension(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  pluginId: string;
  namespace: string;
  value?: PluginJsonValue;
  unset?: boolean;
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
  const registry = getActivePluginRegistry();
  const registered = (registry?.sessionExtensions ?? []).some(
    (entry) => entry.pluginId === pluginId && entry.extension.namespace === namespace,
  );
  if (!registered) {
    return { ok: false, error: `unknown plugin session extension: ${pluginId}/${namespace}` };
  }
  const loaded = loadPluginHostHookSessionEntry({ cfg: params.cfg, sessionKey: params.sessionKey });
  if (!loaded.entry) {
    return { ok: false, error: `unknown session key: ${params.sessionKey}` };
  }
  const canonicalKey = loaded.canonicalKey ?? params.sessionKey;
  const nextValue = await updateSessionStore(loaded.storePath, (store) => {
    const entry = store[loaded.storeKey];
    if (!entry) {
      return undefined;
    }
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
    entry.updatedAt = Date.now();
    return pluginState[namespace] as PluginJsonValue | undefined;
  });
  return { ok: true, key: canonicalKey, value: nextValue };
}

export async function projectPluginSessionExtensions(params: {
  sessionKey: string;
  entry: SessionEntry;
}): Promise<PluginSessionExtensionProjection[]> {
  const registry = getActivePluginRegistry();
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
  const registry = getActivePluginRegistry();
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
    if (projected === undefined || !isPluginJsonValue(projected)) {
      // Validate the projection regardless of whether the extension has a
      // `project` function: with a projector the value can be arbitrary;
      // without one the persisted state could be hand-edited or malformed.
      // Either way the size + shape check should run before projection.
      continue;
    }
    projections.push({
      pluginId: registration.pluginId,
      namespace: registration.extension.namespace,
      value: copyJsonValue(projected),
    });
  }
  return projections;
}
