import { DEFAULT_GATEWAY_PORT } from "./paths.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type GatewayNonLoopbackBindMode = "lan" | "tailnet" | "custom" | "auto";

export function isGatewayNonLoopbackBindMode(bind: unknown): bind is GatewayNonLoopbackBindMode {
  return bind === "lan" || bind === "tailnet" || bind === "custom" || bind === "auto";
}

export function hasConfiguredControlUiAllowedOrigins(params: {
  allowedOrigins: unknown;
  dangerouslyAllowHostHeaderOriginFallback: unknown;
}): boolean {
  if (params.dangerouslyAllowHostHeaderOriginFallback === true) {
    return true;
  }
  return (
    Array.isArray(params.allowedOrigins) &&
    params.allowedOrigins.some((origin) => typeof origin === "string" && origin.trim().length > 0)
  );
}

export function resolveGatewayPortWithDefault(
  port: unknown,
  fallback = DEFAULT_GATEWAY_PORT,
): number {
  return typeof port === "number" && port > 0 ? port : fallback;
}

export function buildDefaultControlUiAllowedOrigins(params: {
  port: number;
  bind: unknown;
  customBindHost?: string;
}): string[] {
  const origins = new Set<string>([
    `http://localhost:${params.port}`,
    `http://127.0.0.1:${params.port}`,
  ]);
  const customBindHost = params.customBindHost?.trim();
  if (params.bind === "custom" && customBindHost) {
    origins.add(`http://${customBindHost}:${params.port}`);
  }
  return [...origins];
}

export function ensureControlUiAllowedOriginsForNonLoopbackBind(
  config: OpenClawConfig,
  opts?: {
    defaultPort?: number;
    requireControlUiEnabled?: boolean;
    /** Optional container-detection callback.  When provided and `gateway.bind`
     *  is unset, the function is called to determine whether the runtime will
     *  default to `"auto"` (container) so that origins can be seeded
     *  proactively.  Keeping this as an injected callback avoids a hard
     *  dependency from the config layer on the gateway runtime layer. */
    isContainerEnvironment?: () => boolean;
  },
): {
  config: OpenClawConfig;
  seededOrigins: string[] | null;
  bind: GatewayNonLoopbackBindMode | null;
} {
  const bind = config.gateway?.bind;
  // When bind is unset (undefined) and we are inside a container, the runtime
  // will default to "auto" → 0.0.0.0 via defaultGatewayBindMode().  We must
  // seed origins *before* resolveGatewayRuntimeConfig runs, otherwise the
  // non-loopback Control UI origin check will hard-fail on startup.
  const effectiveBind: typeof bind =
    bind ?? (opts?.isContainerEnvironment?.() ? "auto" : undefined);
  if (!isGatewayNonLoopbackBindMode(effectiveBind)) {
    return { config, seededOrigins: null, bind: null };
  }
  if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
    return { config, seededOrigins: null, bind: effectiveBind };
  }
  if (
    hasConfiguredControlUiAllowedOrigins({
      allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
      dangerouslyAllowHostHeaderOriginFallback:
        config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })
  ) {
    return { config, seededOrigins: null, bind: effectiveBind };
  }

  const port = resolveGatewayPortWithDefault(config.gateway?.port, opts?.defaultPort);
  const seededOrigins = buildDefaultControlUiAllowedOrigins({
    port,
    bind: effectiveBind,
    customBindHost: config.gateway?.customBindHost,
  });
  return {
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: seededOrigins,
        },
      },
    },
    seededOrigins,
    bind: effectiveBind,
  };
}
