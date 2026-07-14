/**
 * Internal hook dispatch loop and shared handler registry.
 *
 * This module owns the globalThis-backed handler registry plus the actual
 * firing loop. It is deliberately kept OUT of the plugin SDK barrels
 * (`src/plugin-sdk/hook-runtime.ts` only re-exports `internal-hooks.ts`), so the
 * scheduling/timing options below stay an internal runtime contract: the public
 * `triggerInternalHook(event)` surface must not grow a second parameter that
 * plugins could rely on.
 */

import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listLegacyPluginInternalHooks } from "../plugins/legacy-internal-hook-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { InternalHookEvent, InternalHookHandler } from "./internal-hook-types.js";

/**
 * Registry of hook handlers by event key.
 *
 * Uses a globalThis singleton so that registerInternalHook and
 * triggerInternalHook always share the same Map even when the bundler
 * emits multiple copies of this module into separate chunks (bundle
 * splitting). Without the singleton, handlers registered in one chunk
 * are invisible to triggerInternalHook in another chunk, causing hooks
 * to silently fire with zero handlers.
 */
const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
export const internalHookHandlers = resolveGlobalSingleton<Map<string, InternalHookHandler[]>>(
  INTERNAL_HOOK_HANDLERS_KEY,
  () => new Map<string, InternalHookHandler[]>(),
);
const INTERNAL_HOOKS_ENABLED_KEY = Symbol.for("openclaw.internalHooksEnabled");
export const internalHooksEnabledState = resolveGlobalSingleton<{ enabled: boolean }>(
  INTERNAL_HOOKS_ENABLED_KEY,
  () => ({ enabled: true }),
);

const log = createSubsystemLogger("internal-hooks");
const INTERNAL_HOOK_SLOW_HANDLER_WARN_MS = 500;

/**
 * Internal-only scheduling/timing controls for the bootstrap dispatch path.
 * Not exported from the plugin SDK; only `triggerInternalHookWithScheduling`
 * callers (currently agent bootstrap) pass these.
 */
type InternalHookTriggerOptions = {
  yieldBetweenHandlers?: boolean;
  onHandlerTiming?: (info: { index: number; durationMs: number }) => void;
};

/**
 * Trigger a hook event, optionally yielding to the event loop between handlers
 * and reporting per-handler timing.
 *
 * Calls all handlers registered for:
 * 1. The general event type (e.g., 'command')
 * 2. The specific event:action combination (e.g., 'command:new')
 *
 * Handlers are called in registration order. Errors are caught and logged
 * but don't prevent other handlers from running.
 *
 * The public `triggerInternalHook(event)` delegates here with no options so its
 * SDK-facing signature stays single-parameter; the bootstrap path passes
 * `yieldBetweenHandlers` to keep long handler chains from stalling the loop.
 */
export async function triggerInternalHookWithScheduling(
  event: InternalHookEvent,
  options?: InternalHookTriggerOptions,
): Promise<void> {
  if (!internalHooksEnabledState.enabled) {
    return;
  }

  // Plugin-registered legacy internal hooks dispatch alongside the core registry;
  // merge both so the bootstrap path (which calls this directly) and the public
  // triggerInternalHook delegator fire every registered handler.
  // An admitted event finishes its snapshot even if a handler awaits across a reload or disable.
  const typeHandlers = [
    ...(internalHookHandlers.get(event.type) ?? []),
    ...listLegacyPluginInternalHooks(event.type),
  ];
  const specificKey = `${event.type}:${event.action}`;
  const specificHandlers = [
    ...(internalHookHandlers.get(specificKey) ?? []),
    ...listLegacyPluginInternalHooks(specificKey),
  ];
  if (typeHandlers.length === 0 && specificHandlers.length === 0) {
    return;
  }
  const allHandlers = [...typeHandlers, ...specificHandlers];

  for (const [index, handler] of allHandlers.entries()) {
    const handlerStartedAt = performance.now();
    try {
      await handler(event);
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error(`Hook error [${event.type}:${event.action}]: ${message}`);
    }
    const durationMs = performance.now() - handlerStartedAt;
    options?.onHandlerTiming?.({ index, durationMs });
    // The warning targets event-loop-stall diagnostics on the bootstrap dispatch
    // path (the only caller passing yieldBetweenHandlers). Outside it, awaited
    // wall time mostly reflects non-blocking network/file work, so a global
    // duration warning is just false positives — timing data still flows via
    // onHandlerTiming for callers that want it.
    if (options?.yieldBetweenHandlers === true && durationMs > INTERNAL_HOOK_SLOW_HANDLER_WARN_MS) {
      log.warn(
        `Slow hook handler [${event.type}:${event.action}] index=${index} durationMs=${durationMs.toFixed(1)}`,
      );
    }
    if (options?.yieldBetweenHandlers === true && index < allHandlers.length - 1) {
      await yieldImmediate();
    }
  }
}
