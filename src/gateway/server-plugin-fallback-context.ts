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

/** Set the process fallback gateway context for channel adapters outside WS requests. */
export function setFallbackGatewayContext(ctx: GatewayRequestContext): () => void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.context = ctx;
  fallbackGatewayContextState.resolveContext = undefined;
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
