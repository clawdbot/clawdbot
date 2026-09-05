import { createRequire } from "node:module";
import net from "node:net";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import { withUndiciErrorDiagnostics } from "./undici-error-diagnostics.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const requireUndici = createRequire(import.meta.url);

type UndiciAgentOptions = ConstructorParameters<typeof import("undici").Agent>[0];
type UndiciProxyAgentOptions = ConstructorParameters<typeof import("undici").ProxyAgent>[0];
type UndiciProxyAgentOptionsRecord = Exclude<UndiciProxyAgentOptions, string | URL>;
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

function createHttp1ProxyClient(origin: URL, poolOptions: object): import("undici").Dispatcher {
  type Connect = ReturnType<typeof import("undici").buildConnector>;
  const connect = isObjectRecord(poolOptions) ? poolOptions.connect : undefined;
  return createUndiciPool(origin, {
    ...poolOptions,
    ...(typeof connect === "function"
      ? {
          connect: (params: Parameters<Connect>[0], callback: Parameters<Connect>[1]) => {
            // IP-addressed HTTPS proxies must not send an IP literal as TLS SNI.
            const { servername, ...withoutServername } = params;
            return connect(
              servername && net.isIP(servername.replace(/^\[|\]$/g, ""))
                ? withoutServername
                : params,
              callback,
            );
          },
        }
      : {}),
  });
}

/** Prepare proxy transport without transferring direct-origin TLS or DNS policy. */
export function buildProxyConnectOptions(
  options: Omit<UndiciProxyAgentOptionsRecord, "uri">,
  timeoutMs?: number,
) {
  const connect = {
    ...resolveUndiciAutoSelectFamilyConnectOptions(),
    ...(typeof options.connect === "object" ? options.connect : {}),
  };
  const timeout = normalizedTimeout(timeoutMs);
  return {
    autoSelectFamily: connect.autoSelectFamily,
    autoSelectFamilyAttemptTimeout: connect.autoSelectFamilyAttemptTimeout,
    family: "family" in connect ? connect.family : undefined,
    keepAlive: connect.keepAlive,
    keepAliveInitialDelay: connect.keepAliveInitialDelay,
    // Match native precedence: null/undefined proxy overrides select Undici's
    // default, never the direct connector's deadline.
    timeout: options.connectTimeout,
    ...options.proxyTls,
    ...(timeout !== undefined ? { timeout } : {}),
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
  };
}

function createUndiciClient(
  origin: string | URL,
  options: import("undici").Client.Options,
): import("undici").Dispatcher {
  const { Client } = loadUndiciModule(["Client"]);
  return withUndiciErrorDiagnostics(new Client(origin, options));
}

function createUndiciPool(
  origin: string | URL,
  options: import("undici").Pool.Options,
): import("undici").Dispatcher {
  const { Pool } = loadUndiciModule(["Pool"]);
  return withUndiciErrorDiagnostics(
    new Pool(origin, {
      ...options,
      factory: createUndiciClient,
    }),
  );
}

function createUndiciOriginDispatcher(
  origin: string | URL,
  options: import("undici").Agent.Options,
): import("undici").Dispatcher {
  return options.connections === 1
    ? createUndiciClient(origin, options)
    : createUndiciPool(origin, options);
}

function normalizedTimeout(timeoutMs?: number): number | undefined {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : undefined;
}

export function buildHttp1AgentOptions(
  options: UndiciAgentOptions = {},
  timeoutMs?: number,
): NonNullable<UndiciAgentOptions> {
  const timeout = normalizedTimeout(timeoutMs);
  return {
    factory: createUndiciOriginDispatcher,
    ...options,
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
    connect:
      typeof options.connect === "function"
        ? options.connect
        : {
            ...resolveUndiciAutoSelectFamilyConnectOptions(),
            ...options.connect,
            ...(timeout !== undefined ? { timeout } : {}),
          },
    ...(timeout !== undefined ? { bodyTimeout: timeout, headersTimeout: timeout } : {}),
  };
}

export function buildHttp1ProxyAgentOptions(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
  managedTlsEnv?: NodeJS.ProcessEnv,
): Exclude<UndiciProxyAgentOptions, string> {
  const normalized =
    typeof options === "string" || options instanceof URL ? { uri: options.toString() } : options;
  // oxlint-disable-next-line typescript/unbound-method -- Undici invokes this callback without an options receiver; preserve inherited callbacks too.
  const { clientFactory = createHttp1ProxyClient } = normalized;
  const managed = addActiveManagedProxyTlsOptions(normalized, { env: managedTlsEnv });
  // Generic connector hints are not TLS opt-in: Undici interprets proxyTls
  // presence as SOCKS-over-TLS. Only explicitly supplied/managed TLS belongs there.
  return {
    proxyTunnel: true,
    ...managed,
    ...buildHttp1AgentOptions(managed, timeoutMs),
    clientFactory,
  };
}
