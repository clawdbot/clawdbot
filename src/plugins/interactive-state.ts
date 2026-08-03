// Stores interactive plugin state and dedupe caches.
import { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
import type { DedupeCache } from "../infra/dedupe.js";
type InteractiveState = {
  callbackDedupe: ReturnType<typeof createDedupeCache>;
  inflightCallbackDedupe: Set<string>;
};

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for(
  "openclaw.pluginInteractiveCallbackDedupe",
);

function createInteractiveCallbackDedupe(): DedupeCache {
  return resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
    ttlMs: 5 * 60_000,
    maxSize: 4096,
  });
}

function createInteractiveState(): InteractiveState {
  return {
    callbackDedupe: createInteractiveCallbackDedupe(),
    inflightCallbackDedupe: new Set<string>(),
  };
}

function hydrateInteractiveState(value: unknown): InteractiveState {
  const state =
    typeof value === "object" && value !== null
      ? (value as Partial<InteractiveState>)
      : ({} as Partial<InteractiveState>);

  return {
    callbackDedupe: createInteractiveCallbackDedupe(),
    inflightCallbackDedupe:
      state.inflightCallbackDedupe instanceof Set
        ? state.inflightCallbackDedupe
        : new Set<string>(),
  };
}

function getState() {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
  if (existing !== undefined) {
    const hydrated = hydrateInteractiveState(existing);
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
    return hydrated;
  }

  const created = createInteractiveState();
  globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = created;
  return created;
}

function getPluginInteractiveCallbackDedupeState() {
  return getState().callbackDedupe;
}

/** Claims an interactive callback dedupe key while the callback is in flight. */
export function claimPluginInteractiveCallbackDedupe(
  dedupeKey: string | undefined,
  now = Date.now(),
): boolean {
  if (!dedupeKey) {
    return true;
  }
  const state = getState();
  if (state.inflightCallbackDedupe.has(dedupeKey) || state.callbackDedupe.peek(dedupeKey, now)) {
    return false;
  }
  state.inflightCallbackDedupe.add(dedupeKey);
  return true;
}

/** Commits an interactive callback dedupe key after successful handling. */
export function commitPluginInteractiveCallbackDedupe(
  dedupeKey: string | undefined,
  now = Date.now(),
): void {
  if (!dedupeKey) {
    return;
  }
  const state = getState();
  state.inflightCallbackDedupe.delete(dedupeKey);
  state.callbackDedupe.check(dedupeKey, now);
}

/** Releases an in-flight interactive callback dedupe claim without committing it. */
export function releasePluginInteractiveCallbackDedupe(dedupeKey: string | undefined): void {
  if (!dedupeKey) {
    return;
  }
  getState().inflightCallbackDedupe.delete(dedupeKey);
}

/** Clears plugin interactive handlers and callback dedupe state. */
export function clearPluginInteractiveHandlersState(): void {
  getPluginInteractiveCallbackDedupeState().clear();
  getState().inflightCallbackDedupe.clear();
}
