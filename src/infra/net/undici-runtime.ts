import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { matchesNoProxy } from "./proxy-env.js";
import {
  buildHttp1AgentOptions,
  buildHttp1ProxyAgentOptions,
  buildProxyConnectOptions,
  loadUndiciModule,
} from "./undici-dispatcher-options.js";
import { withUndiciErrorDiagnostics } from "./undici-error-diagnostics.js";

/** Runtime-loaded undici constructors/functions used where static imports would affect globals. */
export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};

/** Minimal undici surface needed by global-dispatcher installation code. */
export type UndiciGlobalDispatcherDeps = Pick<
  typeof import("undici"),
  "getGlobalDispatcher" | "setGlobalDispatcher"
>;

type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  UndiciRuntimeDeps["EnvHttpProxyAgent"]
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];

/** Loads undici lazily, allowing tests to inject constructors without global side effects. */
export function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  return loadUndiciModule(["Agent", "EnvHttpProxyAgent", "ProxyAgent", "fetch"]);
}

/** Loads only the undici global-dispatcher API used by startup proxy setup. */
export function loadUndiciGlobalDispatcherDeps(): UndiciGlobalDispatcherDeps {
  return loadUndiciModule(["getGlobalDispatcher", "setGlobalDispatcher"]);
}

/** Creates a direct undici Agent with OpenClaw's HTTP/1-only dispatcher policy. */
export function createHttp1Agent(
  options?: UndiciAgentOptions,
  timeoutMs?: number,
): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(new Agent(buildHttp1AgentOptions(options, timeoutMs)));
}

function isSocksProxy(uri: string | undefined): boolean {
  return uri !== undefined && ["socks:", "socks5:"].includes(URL.parse(uri)?.protocol ?? "");
}

function createSocksProxyAgent(
  options: Exclude<UndiciProxyAgentOptions, string | URL>,
  timeoutMs?: number,
): import("undici").Dispatcher {
  const { Agent, Socks5ProxyAgent, buildConnector, errors } = loadUndiciModule([
    "Agent",
    "Socks5ProxyAgent",
    "buildConnector",
  ]);
  // Preserve the exported ProxyAgent constructor's refusals before substituting SOCKS transport.
  if (typeof options.clientFactory !== "function") {
    throw new errors.InvalidArgumentError("Proxy opts.clientFactory must be a function.");
  }
  if (options.auth && options.token) {
    throw new errors.InvalidArgumentError(
      "opts.auth cannot be used in combination with opts.token",
    );
  }
  const connect = buildConnector(buildProxyConnectOptions(options, timeoutMs));
  // Preserve explicit-proxy classification while native Agent owns origin admission/retirement.
  class SocksProxyAgent extends Agent {}
  const agent = withUndiciErrorDiagnostics(
    new SocksProxyAgent({
      ...options,
      factory: () =>
        withUndiciErrorDiagnostics(new Socks5ProxyAgent(options.uri, { ...options, connect })),
    }),
  );
  // Undici's SOCKS pools take these defaults from dispatch, not the constructor.
  const defaults = {
    connections: options.connections,
    pipelining: options.pipelining,
    bodyTimeout: options.bodyTimeout,
    headersTimeout: options.headersTimeout,
  };
  return agent.compose((dispatch) => (request, handler) => {
    // ProxyAgent rejects these headers before dispatch. Its SOCKS delegate does
    // not, so preserve that boundary rather than leak proxy credentials to the origin.
    const headers = request.headers;
    const names = Array.isArray(headers) ? headers.filter((_, index) => index % 2 === 0) : [];
    if (!Array.isArray(headers)) {
      for (const name in headers) {
        names.push(name);
      }
    }
    if (
      names.some((name) => typeof name === "string" && name.toLowerCase() === "proxy-authorization")
    ) {
      throw new errors.InvalidArgumentError(
        "Proxy-Authorization should be sent in ProxyAgent constructor",
      );
    }
    return dispatch({ ...defaults, ...request }, handler);
  });
}

type LifecycleCallback = (error: Error | null, data: null) => void;
function completeProxyLifecycle(
  start: () => Promise<unknown>,
  callback?: LifecycleCallback,
): Promise<void> | void {
  if (callback !== undefined && typeof callback !== "function") {
    const { errors } = loadUndiciModule([]);
    throw new errors.InvalidArgumentError("invalid callback");
  }
  const completion = start().then(() => undefined);
  if (callback) {
    void completion.then(
      () => callback(null, null),
      (error: unknown) => callback(toErrorObject(error, "Proxy shutdown failed"), null),
    );
  } else {
    return completion;
  }
}

/** Creates an env dispatcher with per-hop connectors and the existing dynamic bypass policy. */
export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeoutMs?: number,
  managedTlsEnv?: NodeJS.ProcessEnv,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  const httpProxy = options?.httpProxy ?? process.env.http_proxy ?? process.env.HTTP_PROXY;
  const httpsProxy =
    (options?.httpsProxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY) || httpProxy;
  const proxies = new Map<string, import("undici").Dispatcher>();
  for (const uri of [httpProxy, httpsProxy]) {
    if (uri && !proxies.has(uri)) {
      proxies.set(uri, createHttp1ProxyAgent({ ...options, uri }, timeoutMs, managedTlsEnv));
    }
  }
  const dispatcher = withUndiciErrorDiagnostics(
    new EnvHttpProxyAgent({
      ...buildHttp1AgentOptions(options, timeoutMs),
      // Global dispatcher replacement recognizes EnvHttpProxyAgent. Keep its direct
      // transport, but disable native routing so one NO_PROXY decision owns dispatch.
      httpProxy: "",
      httpsProxy: "",
      noProxy: "*",
    }),
  );
  if (proxies.size === 0) {
    return dispatcher;
  }
  const owned = [dispatcher, ...proxies.values()];
  // Empty native children can close before proxied responses drain. Join and report
  // the whole owner set, while retaining the native close-after-destroy refusal.
  const isDestroyed = () => owned.every((agent) => Reflect.get(agent, "destroyed") === true);
  let closing: Promise<void[]> | undefined;
  return new Proxy(dispatcher, {
    get(target, property, receiver) {
      if (property === "destroyed") {
        return isDestroyed();
      }
      if (property === "dispatch") {
        return (
          request: Parameters<typeof target.dispatch>[0],
          handler: Parameters<typeof target.dispatch>[1],
        ) => {
          const origin = request?.origin ? URL.parse(String(request.origin)) : null;
          const uri = origin?.protocol === "https:" ? httpsProxy : httpProxy;
          const proxy = uri && proxies.get(uri);
          const bypassEnv =
            options?.noProxy === undefined ? process.env : { no_proxy: options.noProxy };
          return proxy && origin && !matchesNoProxy(origin, bypassEnv)
            ? proxy.dispatch(request, handler)
            : target.dispatch(request, handler);
        };
      }
      if (property === "close") {
        return (callback?: LifecycleCallback) =>
          completeProxyLifecycle(
            () =>
              isDestroyed()
                ? target.close()
                : (closing ??= Promise.all(owned.map((agent) => agent.close())).finally(() => {
                    closing = undefined;
                  })),
            callback,
          );
      }
      if (property === "destroy") {
        return (error?: Error | null | LifecycleCallback, callback?: LifecycleCallback) =>
          completeProxyLifecycle(
            () =>
              Promise.all(
                owned.map((agent) =>
                  agent.destroy(typeof error === "function" ? null : (error ?? null)),
                ),
              ),
            typeof error === "function" ? error : callback,
          );
      }
      // Helper methods keep the wrapper as their receiver so request/stream/compose
      // also use its dispatch; lifecycle above always addresses the actual owners.
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Creates a fixed proxy dispatcher without using TLS options for plain TCP policy. */
export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
  managedTlsEnv?: NodeJS.ProcessEnv,
): import("undici").Dispatcher {
  const prepared = buildHttp1ProxyAgentOptions(options, timeoutMs, managedTlsEnv);
  if (isSocksProxy(prepared.uri)) {
    return createSocksProxyAgent(prepared, timeoutMs);
  }
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(
    new ProxyAgent({ ...prepared, proxyTls: buildProxyConnectOptions(prepared, timeoutMs) }),
  );
}
