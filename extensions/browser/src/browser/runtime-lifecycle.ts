/**
 * Browser plugin runtime lifecycle helpers for startup and shutdown cleanup.
 */
import type { Server } from "node:http";
import { getExtensionRelayModule } from "./extension-relay.runtime.js";
import type { BrowserServerState } from "./server-context.js";
import { markBrowserRuntimeStopping } from "./server-context.lifecycle.js";
import { stopKnownBrowserProfiles } from "./server-lifecycle.js";
import { startTrackedBrowserTabCleanupTimer } from "./session-tab-cleanup.js";
import { registerBrowserUnhandledRejectionHandler } from "./unhandled-rejections.js";

type CreateBrowserRuntimeStateParams = {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
};

const trackedTabCleanupDisposers = new WeakMap<BrowserServerState, () => Promise<void>>();

/** Creates Browser server state and starts runtime-wide cleanup handlers. */
export async function createBrowserRuntimeState(
  params: CreateBrowserRuntimeStateParams,
): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  };
  const stopTrackedTabCleanup = startTrackedBrowserTabCleanupTimer({
    onWarn: params.onWarn,
  });
  trackedTabCleanupDisposers.set(state, stopTrackedTabCleanup);
  state.stopTrackedTabCleanup = () => {
    void stopTrackedTabCleanup().catch(() => {});
  };
  state.stopUnhandledRejectionHandler = registerBrowserUnhandledRejectionHandler();
  return state;
}

/** Stops Browser profiles, the optional HTTP server, and loaded Playwright state. */
type StopBrowserRuntimeParams = {
  current: BrowserServerState | null;
  /** Public API compatibility; cleanup is intentionally pinned to `current`. */
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
};

async function stopBrowserRuntimeInternal(
  params: StopBrowserRuntimeParams,
  finalizeGlobalAdapters: boolean,
): Promise<void> {
  const current = params.current;
  if (!current) {
    return;
  }
  markBrowserRuntimeStopping(current);
  let firstError: Error | undefined;

  // stopKnownBrowserProfiles invalidates every actor synchronously before its
  // first await; only then do we wait for tab cleanup and profile drains.
  const profileDrain = stopKnownBrowserProfiles({
    current,
    closeSharedAdapters: finalizeGlobalAdapters,
    onWarn: params.onWarn,
  });
  const stopTrackedTabCleanup = trackedTabCleanupDisposers.get(current);
  const tabCleanup = Promise.resolve().then(async () => {
    if (stopTrackedTabCleanup) {
      await stopTrackedTabCleanup();
    } else {
      current.stopTrackedTabCleanup?.();
    }
  });
  for (const result of await Promise.allSettled([profileDrain, tabCleanup])) {
    if (result.status === "rejected") {
      firstError ??= toRuntimeLifecycleError(result.reason, "Browser profile cleanup failed.");
    }
  }

  if (current.extensionRelays?.size) {
    try {
      const { stopExtensionRelays } = await getExtensionRelayModule();
      await stopExtensionRelays(current);
    } catch (err) {
      firstError ??= toRuntimeLifecycleError(err, "Browser relay cleanup failed.");
    }
  }

  if (finalizeGlobalAdapters) {
    try {
      const { disposeGatewayExtensionRelay } =
        await import("./extension-relay/gateway-relay-route.js");
      disposeGatewayExtensionRelay();
    } catch (err) {
      firstError ??= toRuntimeLifecycleError(err, "Gateway browser relay cleanup failed.");
    }
  }

  if (!firstError) {
    if (params.closeServer && current.server) {
      await new Promise<void>((resolve) => {
        current.server?.close(() => resolve());
      });
    }

    params.clearState();
    trackedTabCleanupDisposers.delete(current);
    current.stopUnhandledRejectionHandler?.();
  }
  if (firstError) {
    throw firstError;
  }
}

function toRuntimeLifecycleError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

/** Stops Browser profiles, the optional HTTP server, and loaded Playwright state. */
export async function stopBrowserRuntime(params: StopBrowserRuntimeParams): Promise<void> {
  await stopBrowserRuntimeInternal(params, true);
}

/** Internal bridge shutdown leaves process-global adapters owned by the main runtime intact. */
export async function stopBrowserBridgeRuntime(params: StopBrowserRuntimeParams): Promise<void> {
  await stopBrowserRuntimeInternal(params, false);
}
