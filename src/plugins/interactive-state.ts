// Stores interactive plugin state and dedupe caches.
import { resolveGlobalDedupeCache, type DedupeCache } from "../infra/dedupe.js";

type InteractiveState = {
  callbackDedupe: DedupeCache;
  inflightCallbackDedupe: Set<string>;
};

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for(
  "openclaw.pluginInteractiveCallbackDedupe",
);

function hydrateInteractiveState(value: unknown): InteractiveState {
  const state =
    typeof value === "object" && value !== null ? (value as Partial<InteractiveState>) : undefined;

  // Module copies can leave legacy partial state. Preserve its in-flight Set,
  // but rebind the callback cache to the current process-global owner.
  return {
    callbackDedupe: resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
      ttlMs: 5 * 60_000,
      maxSize: 4096,
    }),
    inflightCallbackDedupe:
      state?.inflightCallbackDedupe instanceof Set
        ? state.inflightCallbackDedupe
        : new Set<string>(),
  };
}

function getState() {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const hydrated = hydrateInteractiveState(globalStore[PLUGIN_INTERACTIVE_STATE_KEY]);
  globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
  return hydrated;
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
  const state = getState();
  state.callbackDedupe.clear();
  state.inflightCallbackDedupe.clear();
}
