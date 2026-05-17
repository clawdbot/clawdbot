import { createRequire } from "node:module";
import net from "node:net";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

export const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};

export type UndiciGlobalDispatcherDeps = Pick<UndiciRuntimeDeps, "Agent" | "EnvHttpProxyAgent"> & {
  getGlobalDispatcher: typeof import("undici").getGlobalDispatcher;
  setGlobalDispatcher: typeof import("undici").setGlobalDispatcher;
};

type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  UndiciRuntimeDeps["EnvHttpProxyAgent"]
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];
type UndiciProxyAgentOptionsRecord = Exclude<UndiciProxyAgentOptions, string | URL>;
type UndiciProxyClientFactory = NonNullable<UndiciProxyAgentOptionsRecord["clientFactory"]>;
type UnknownFunction = (...args: unknown[]) => unknown;

// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but our guarded paths rely on dispatcher overrides
// that have not been reliable on the HTTP/2 path yet.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function applyMissingConnectOptions(
  connect: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in connect)) {
      connect[key] = value;
    }
  }
}

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

function isUndiciGlobalDispatcherDeps(value: unknown): value is UndiciGlobalDispatcherDeps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UndiciGlobalDispatcherDeps).Agent === "function" &&
    typeof (value as UndiciGlobalDispatcherDeps).EnvHttpProxyAgent === "function" &&
    typeof (value as UndiciGlobalDispatcherDeps).getGlobalDispatcher === "function" &&
    typeof (value as UndiciGlobalDispatcherDeps).setGlobalDispatcher === "function"
  );
}

function loadUndiciProxyPoolCtor(): typeof import("undici").Pool {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (
    typeof override === "object" &&
    override !== null &&
    typeof (override as { Pool?: unknown }).Pool === "function"
  ) {
    return (override as { Pool: typeof import("undici").Pool }).Pool;
  }

  const require = createRequire(import.meta.url);
  return (require("undici") as typeof import("undici")).Pool;
}

function stripIpServernameFromConnectOptions(options: unknown): unknown {
  if (!isObjectRecord(options) || typeof options.servername !== "string") {
    return options;
  }
  const servername = options.servername.replace(/^\[|\]$/g, "");
  if (net.isIP(servername) === 0) {
    return options;
  }
  const next = { ...options };
  delete next.servername;
  return next;
}

function stripIpServernameFromConnect(connect: unknown): unknown {
  if (typeof connect !== "function") {
    return connect;
  }
  return (options: unknown, callback: unknown): unknown =>
    (connect as UnknownFunction)(stripIpServernameFromConnectOptions(options), callback);
}

function createIpSafeProxyClientFactory(): UndiciProxyClientFactory {
  return (origin, options) => {
    const Pool = loadUndiciProxyPoolCtor();
    const clientOptions = isObjectRecord(options)
      ? { ...options, connect: stripIpServernameFromConnect(options.connect) }
      : options;
    return new Pool(
      origin,
      clientOptions as ConstructorParameters<typeof import("undici").Pool>[1],
    );
  };
}

function addIpSafeProxyClientFactory<TOptions extends object>(options: TOptions): TOptions {
  if ("clientFactory" in options) {
    return options;
  }
  return {
    ...options,
    clientFactory: createIpSafeProxyClientFactory(),
  };
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

export function loadUndiciGlobalDispatcherDeps(): UndiciGlobalDispatcherDeps {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (isUndiciGlobalDispatcherDeps(override)) {
    return override;
  }

  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    Agent: undici.Agent,
    EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
    getGlobalDispatcher: undici.getGlobalDispatcher,
    setGlobalDispatcher: undici.setGlobalDispatcher,
  };
}

function withHttp1OnlyDispatcherOptions<T extends object | undefined>(
  options?: T,
  timeoutMs?: number,
  applyTo?: { connect?: boolean; proxyTls?: boolean },
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  const base = {} as (T extends object ? T : Record<never, never>) & { allowH2: false };
  if (options) {
    Object.assign(base, options);
  }
  // Enforce HTTP/1.1-only — must come after options to prevent accidental override
  Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
  const baseRecord = base as Record<string, unknown>;
  const targets = applyTo ?? { connect: true };
  const autoSelectConnect = resolveUndiciAutoSelectFamilyConnectOptions();
  if (autoSelectConnect && targets.connect && typeof baseRecord.connect !== "function") {
    const connect = isObjectRecord(baseRecord.connect) ? baseRecord.connect : {};
    applyMissingConnectOptions(connect, autoSelectConnect);
    baseRecord.connect = connect;
  }
  if (autoSelectConnect && targets.proxyTls) {
    const proxyTls = isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {};
    applyMissingConnectOptions(proxyTls, autoSelectConnect);
    baseRecord.proxyTls = proxyTls;
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const normalizedTimeoutMs = Math.floor(timeoutMs);
    baseRecord.bodyTimeout = normalizedTimeoutMs;
    baseRecord.headersTimeout = normalizedTimeoutMs;
    if (targets.connect && typeof baseRecord.connect !== "function") {
      baseRecord.connect = {
        ...(isObjectRecord(baseRecord.connect) ? baseRecord.connect : {}),
        timeout: normalizedTimeoutMs,
      };
    }
    if (targets.proxyTls) {
      baseRecord.proxyTls = {
        ...(isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {}),
        timeout: normalizedTimeoutMs,
      };
    }
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
  return new EnvHttpProxyAgent(
    withHttp1OnlyDispatcherOptions(
      addIpSafeProxyClientFactory(addActiveManagedProxyTlsOptions(options) ?? {}),
      timeoutMs,
      {
        connect: true,
        proxyTls: true,
      },
    ),
  );
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
    withHttp1OnlyDispatcherOptions(
      addIpSafeProxyClientFactory(addActiveManagedProxyTlsOptions(normalized as object)),
      timeoutMs,
      {
        proxyTls: true,
      },
    ) as UndiciProxyAgentOptions,
  );
}
