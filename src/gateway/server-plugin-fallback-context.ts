import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const FALLBACK_GATEWAY_CONTEXT_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.fallbackGatewayContextState",
);

type FallbackGatewayContextState = {
  context: GatewayRequestContext | undefined;
  resolveContext: (() => GatewayRequestContext | undefined) | undefined;
};

const getFallbackGatewayContextState = () =>
  resolveGlobalSingleton<FallbackGatewayContextState>(FALLBACK_GATEWAY_CONTEXT_STATE_KEY, () => ({
    context: undefined,
    resolveContext: undefined,
  }));

type FallbackGatewayContextReadyListener = () => void;

const fallbackGatewayContextReadyListeners = new Set<FallbackGatewayContextReadyListener>();

/**
 * Subscribes to fallback gateway context installation. Startup installs the
 * fallback context independently of deadline-driven retry loops, so consumers
 * that deferred work while the context was missing can re-admit it immediately.
 * Returns an unsubscribe function.
 */
export function onFallbackGatewayContextReady(
  listener: FallbackGatewayContextReadyListener,
): () => void {
  fallbackGatewayContextReadyListeners.add(listener);
  return () => {
    fallbackGatewayContextReadyListeners.delete(listener);
  };
}

function notifyFallbackGatewayContextReady(): void {
  // Snapshot so listeners that unsubscribe during notification cannot skip peers.
  for (const listener of Array.from(fallbackGatewayContextReadyListeners)) {
    listener();
  }
}

/** Set the process fallback gateway context for channel adapters outside WS requests. */
export function setFallbackGatewayContext(ctx: GatewayRequestContext): () => void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.context = ctx;
  fallbackGatewayContextState.resolveContext = undefined;
  notifyFallbackGatewayContextReady();
  return () => {
    const currentFallbackGatewayContextState = getFallbackGatewayContextState();
    if (
      currentFallbackGatewayContextState.context === ctx &&
      currentFallbackGatewayContextState.resolveContext === undefined
    ) {
      currentFallbackGatewayContextState.context = undefined;
    }
  };
}

export function setFallbackGatewayContextResolver(
  resolveContext: () => GatewayRequestContext | undefined,
): () => void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.context = undefined;
  fallbackGatewayContextState.resolveContext = resolveContext;
  notifyFallbackGatewayContextReady();
  return () => {
    const currentFallbackGatewayContextState = getFallbackGatewayContextState();
    if (currentFallbackGatewayContextState.resolveContext === resolveContext) {
      currentFallbackGatewayContextState.context = undefined;
      currentFallbackGatewayContextState.resolveContext = undefined;
    }
  };
}

/** Clear the fallback gateway context installed for non-WS dispatch paths. */
export function clearFallbackGatewayContext(): void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.context = undefined;
  fallbackGatewayContextState.resolveContext = undefined;
}

export function getFallbackGatewayContext(): GatewayRequestContext | undefined {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  const resolved = fallbackGatewayContextState.resolveContext?.();
  return resolved ?? fallbackGatewayContextState.context;
}
