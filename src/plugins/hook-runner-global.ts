/**
 * Global Plugin Hook Runner
 *
 * Singleton hook runner that's initialized when plugins are loaded
 * and can be called from anywhere in the codebase.
 *
 * The runner is created once and resolves hooks live on every dispatch from the
 * current request-scoped registry or process root. This also preserves the
 * contract that hooks pushed after initialization dispatch immediately.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import {
  createLiveHookRegistryFacade,
  getHookRunnerGlobalState,
} from "./hook-runner-global-state.js";
import type {
  PluginHookGatewayContext,
  PluginHookGatewayStopEvent,
  PluginHookHandlerMap,
  PluginHookName,
} from "./hook-types.js";
import { createHookRunner, type HookRunner } from "./hooks.js";

const getLog = () => createSubsystemLogger("plugins");

/**
 * Initialize the global hook runner with a plugin registry.
 * Called on every plugin registry activation and by SDK consumers. The runner
 * instance stays stable so references captured mid-run keep seeing current hooks.
 */
export function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void {
  const state = getHookRunnerGlobalState();
  const log = getLog();
  state.registry = registry;
  if (!state.hookRunner) {
    state.hookRunner = createHookRunner(createLiveHookRegistryFacade(state), {
      logger: {
        debug: (msg) => log.debug(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
      },
      catchErrors: true,
      failurePolicyByHook: {
        before_agent_run: "fail-closed",
        before_install: "fail-closed",
        before_tool_call: "fail-closed",
      },
    });
  }

  const hookCount = registry.hooks.length;
  if (hookCount > 0) {
    log.debug(`hook runner initialized with ${hookCount} registered hooks`);
  }
}

/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalHookRunner(): HookRunner | null {
  return getHookRunnerGlobalState().hookRunner;
}

/**
 * Get the registry from the most recent activation or explicit initialization.
 * Returns null if plugins haven't been loaded yet.
 */
export function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null {
  return getHookRunnerGlobalState().registry;
}

/**
 * Check if any hooks are registered for a given hook name.
 */
export function hasGlobalHooks<K extends PluginHookName>(
  hookName: K,
  ctx?: Parameters<PluginHookHandlerMap[K]>[1],
): boolean {
  return getHookRunnerGlobalState().hookRunner?.hasHooks(hookName, ctx) ?? false;
}

export async function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const log = getLog();
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("gateway_stop")) {
    return;
  }
  try {
    await hookRunner.runGatewayStop(params.event, params.ctx);
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    log.warn(`gateway_stop hook failed: ${String(err)}`);
  }
}

/**
 * Reset the global hook runner (for testing).
 */
export function resetGlobalHookRunner(): void {
  const state = getHookRunnerGlobalState();
  state.hookRunner = null;
  state.registry = null;
}
