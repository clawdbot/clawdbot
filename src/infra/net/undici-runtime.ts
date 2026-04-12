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
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  if (!options) {
    return { ...HTTP1_ONLY_DISPATCHER_OPTIONS } as (T extends object ? T : Record<never, never>) & {
      allowH2: false;
    };
  }
  return {
    ...options,
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
  } as (T extends object ? T : Record<never, never>) & { allowH2: false };
}

export function createHttp1Agent(options?: UndiciAgentOptions): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return new Agent(withHttp1OnlyDispatcherOptions(options));
}

export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  return new EnvHttpProxyAgent(withHttp1OnlyDispatcherOptions(options));
}

export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
): import("undici").ProxyAgent {
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  if (typeof options === "string" || options instanceof URL) {
    return new ProxyAgent(withHttp1OnlyDispatcherOptions({ uri: options.toString() }));
  }
  return new ProxyAgent(withHttp1OnlyDispatcherOptions(options));
}
