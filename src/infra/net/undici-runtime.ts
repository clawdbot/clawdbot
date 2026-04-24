import { createRequire } from "node:module";

export const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};

type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  UndiciRuntimeDeps["EnvHttpProxyAgent"]
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];

// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but our guarded paths rely on dispatcher overrides
// that have not been reliable on the HTTP/2 path yet.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

function isUndiciRuntimeDeps(value: unknown): value is UndiciRuntimeDeps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UndiciRuntimeDeps).Agent === "function" &&
    typeof (value as UndiciRuntimeDeps).EnvHttpProxyAgent === "function" &&
    typeof (value as UndiciRuntimeDeps).ProxyAgent === "function" &&
    typeof (value as UndiciRuntimeDeps).fetch === "function"
  );
}

export function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (isUndiciRuntimeDeps(override)) {
    return override;
  }

  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    Agent: undici.Agent,
    EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
    FormData: undici.FormData,
    ProxyAgent: undici.ProxyAgent,
    fetch: undici.fetch,
  };
}

function withHttp1OnlyDispatcherOptions<T extends object | undefined>(
  options?: T,
  timeoutMs?: number,
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  const base = {} as (T extends object ? T : Record<never, never>) & { allowH2: false };
  if (options) {
    Object.assign(base, options);
  }
  // Enforce HTTP/1.1-only — must come after options to prevent accidental override
  Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    (base as Record<string, unknown>).bodyTimeout = timeoutMs;
    (base as Record<string, unknown>).headersTimeout = timeoutMs;
  }
  return base;
}

export function createHttp1Agent(
  options?: UndiciAgentOptions,
  timeoutMs?: number,
): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return new Agent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}

export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeoutMs?: number,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  return new EnvHttpProxyAgent(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}

export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
): import("undici").ProxyAgent {
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  const normalized =
    typeof options === "string" || options instanceof URL
      ? { uri: options.toString() }
      : { ...options };
  return new ProxyAgent(
    withHttp1OnlyDispatcherOptions(normalized as object, timeoutMs) as UndiciProxyAgentOptions,
  );
}
