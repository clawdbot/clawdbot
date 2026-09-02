// Slack canvas-to-channel binding, persisted in the shared plugin state KV.
//
// `canvases.edit`/`canvases.delete`/`canvases.sections.lookup` send only
// `canvas_id` (Slack rejects a `channel_id` argument on these methods), so
// Slack authorizes the call purely by the app's canvas scope — it cannot bind
// the canvas to the OpenClaw channel allowlist. bookmarks.edit/remove do not
// have this gap because they send `channel_id` + `bookmark_id` and Slack
// validates the bookmark belongs to the named channel.
//
// To close that gap for canvases OpenClaw creates, `createSlackCanvas` records
// a `canvas_id -> { channelId, teamId, accountId }` binding here, and
// edit/delete/lookup re-check the bound channel against the read-target
// allowlist before any HTTP call. A canvas whose binding channel has since been
// removed from the allowlist (or disabled) is rejected before the request
// reaches Slack. A canvas with no binding (created outside OpenClaw, or before
// this binding existed) is rejected outright: OpenClaw has no authoritative way
// to bind an external canvas_id to an allowed channel, and falling back to the
// caller-named channel would let an agent proxy a denied channel's canvas
// through an allowed target.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getOptionalSlackRuntime } from "./runtime.js";

const CANVAS_BINDING_NAMESPACE = "slack-canvas-binding";
const CANVAS_BINDING_MAX_ENTRIES = 4096;

export type SlackCanvasBinding = {
  channelId: string;
  teamId?: string;
  accountId?: string;
  recordedAt: number;
};

let bindingStore: PluginStateKeyedStore<SlackCanvasBinding> | undefined;
// The store handle is process-stable for a given runtime, but the plugin
// runtime can be swapped (tests, re-init). Track the runtime the handle was
// opened against so a swapped runtime re-opens instead of reusing a handle
// bound to a stale runtime.
let bindingStoreRuntime: unknown;

function tryOpenCanvasBindingStore(): PluginStateKeyedStore<SlackCanvasBinding> | undefined {
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    bindingStore = undefined;
    bindingStoreRuntime = undefined;
    return undefined;
  }
  if (bindingStore && bindingStoreRuntime === runtime) {
    return bindingStore;
  }
  try {
    bindingStore = runtime.state.openKeyedStore<SlackCanvasBinding>({
      namespace: CANVAS_BINDING_NAMESPACE,
      maxEntries: CANVAS_BINDING_MAX_ENTRIES,
    });
    bindingStoreRuntime = runtime;
    return bindingStore;
  } catch {
    // The shared state DB is unavailable (e.g. a minimal runtime without the
    // plugin state store). Callers decide: the create path must fail (the
    // binding is mandatory for later operations), while resolve/forget stay
    // fail-closed (no provable binding -> reject access / no-op cleanup).
    bindingStore = undefined;
    bindingStoreRuntime = undefined;
    return undefined;
  }
}

/**
 * Record a canvas->channel binding after a successful `canvases.create`.
 *
 * Throws when the binding cannot be persisted: the binding is the only
 * authority a later edit/delete/lookup has that the canvas belongs to an
 * allowed channel (canvases.* sends only `canvas_id`, so Slack cannot bind it
 * to the channel allowlist). A canvas whose binding failed to record would be
 * created at Slack yet rejected as unbound by every follow-up operation, so the
 * create path must not report success — it propagates this error and cleans up
 * the orphan canvas (see action-runtime.ts createCanvas).
 */
export async function recordSlackCanvasBinding(
  canvasId: string,
  binding: SlackCanvasBinding,
): Promise<void> {
  const store = tryOpenCanvasBindingStore();
  if (!store) {
    throw new Error(
      "Slack canvas binding store is unavailable: cannot persist the canvas->channel binding required for later edit/delete/lookup operations.",
    );
  }
  await store.register(canvasId, binding);
}

/**
 * Resolve the bound channel for a canvas id. Returns `undefined` when no
 * binding is recorded (external canvas, or created before bindings existed),
 * or when the store cannot be read. A store failure is fail-closed: without a
 * provable binding the dispatch layer rejects the canvas before any Slack I/O
 * rather than trusting a canvas_id the caller named.
 */
export async function resolveSlackCanvasBindingChannel(
  canvasId: string,
): Promise<SlackCanvasBinding | undefined> {
  const store = tryOpenCanvasBindingStore();
  if (!store) {
    return undefined;
  }
  try {
    return await store.lookup(canvasId);
  } catch {
    return undefined;
  }
}

/**
 * Remove a binding after a successful `canvases.delete`. Best-effort: a stale
 * binding left after a delete is harmless because the canvas no longer exists,
 * and a later lookup just misses at Slack.
 */
export async function forgetSlackCanvasBinding(canvasId: string): Promise<void> {
  const store = tryOpenCanvasBindingStore();
  if (!store) {
    return;
  }
  try {
    await store.delete(canvasId);
  } catch {
    // A stale binding after a delete is harmless; the canvas no longer exists.
  }
}
