import { createRequire } from "node:module";
import net from "node:net";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import { withUndiciErrorDiagnostics } from "./undici-error-diagnostics.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const requireUndici = createRequire(import.meta.url);

type UndiciAgentOptions = ConstructorParameters<typeof import("undici").Agent>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  typeof import("undici").EnvHttpProxyAgent
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<typeof import("undici").ProxyAgent>[0];
type UndiciProxyAgentOptionsRecord = Exclude<UndiciProxyAgentOptions, string | URL>;
type UndiciProxyClientFactory = NonNullable<UndiciProxyAgentOptionsRecord["clientFactory"]>;
type UnknownFunction = (...args: unknown[]) => unknown;

// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but dispatcher overrides are unreliable on that path.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

export function loadUndiciModule(
  requiredExports: ReadonlyArray<keyof typeof import("undici")>,
): typeof import("undici") {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (
    isObjectRecord(override) &&
    requiredExports.every((key) => typeof override[key] === "function")
  ) {
    return override as typeof import("undici");
  }
  return requireUndici("undici") as typeof import("undici");
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
    // HTTPS proxies addressed by IP must not pass the IP literal as TLS SNI.
    const clientOptions = isObjectRecord(options)
      ? { ...options, connect: stripIpServernameFromConnect(options.connect) }
      : options;
    return createUndiciPool(origin, clientOptions);
  };
}

function createUndiciClient(origin: string | URL, options: object): import("undici").Dispatcher {
  const { Client } = loadUndiciModule(["Client"]);
  return withUndiciErrorDiagnostics(
    new Client(origin, options as ConstructorParameters<typeof Client>[1]),
  );
}

function createUndiciPool(origin: string | URL, options: unknown): import("undici").Dispatcher {
  const { Pool } = loadUndiciModule(["Pool"]);
  const poolOptions = isObjectRecord(options) ? options : {};
  return withUndiciErrorDiagnostics(
    new Pool(origin, {
      ...poolOptions,
      factory: createUndiciClient,
    }),
  );
}

function createUndiciOriginDispatcher(
  origin: string | URL,
  options: object,
): import("undici").Dispatcher {
  return isObjectRecord(options) && options.connections === 1
    ? createUndiciClient(origin, options)
    : createUndiciPool(origin, options);
}

function addUndiciAgentFactory<TOptions extends object>(options: TOptions): TOptions {
  if ("factory" in options) {
    return options;
  }
  return {
    ...options,
    factory: createUndiciOriginDispatcher,
  };
}

function addIpSafeProxyClientFactory<TOptions extends object>(options: TOptions): TOptions {
  if ("clientFactory" in options) {
    return options;
  }
  // Caller factories own their connection policy and must not be replaced.
  return {
    ...options,
    clientFactory: createIpSafeProxyClientFactory(),
  };
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

function withHttp1OnlyDispatcherOptions<T extends object | undefined>(
  options?: T,
  timeoutMs?: number,
  applyTo?: { connect?: boolean; proxyTls?: boolean },
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  const base = {} as (T extends object ? T : Record<never, never>) & { allowH2: false };
  if (options) {
    Object.assign(base, options);
  }
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

export function buildHttp1AgentOptions(
  options?: UndiciAgentOptions,
  timeoutMs?: number,
): NonNullable<UndiciAgentOptions> {
  return addUndiciAgentFactory(withHttp1OnlyDispatcherOptions(options, timeoutMs));
}

export function buildHttp1EnvHttpProxyAgentOptions(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeoutMs?: number,
): NonNullable<UndiciEnvHttpProxyAgentOptions> {
  return withHttp1OnlyDispatcherOptions(
    addIpSafeProxyClientFactory(
      addUndiciAgentFactory(addActiveManagedProxyTlsOptions(options) ?? {}),
    ),
    timeoutMs,
    { connect: true, proxyTls: true },
  );
}

export function buildHttp1ProxyAgentOptions(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
): Exclude<UndiciProxyAgentOptions, string> {
  const normalized =
    typeof options === "string" || options instanceof URL
      ? { uri: options.toString() }
      : { ...options };
  return withHttp1OnlyDispatcherOptions(
    addIpSafeProxyClientFactory(
      addUndiciAgentFactory(addActiveManagedProxyTlsOptions(normalized as object)),
    ),
    timeoutMs,
    { proxyTls: true },
  ) as Exclude<UndiciProxyAgentOptions, string>;
}
