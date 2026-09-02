// Undici runtime helpers lazily load dispatcher constructors and enforce
// OpenClaw HTTP/1, timeout, proxy TLS, and IP-safe proxy policies.
import {
  buildHttp1AgentOptions,
  buildHttp1EnvHttpProxyAgentOptions,
  buildHttp1ProxyAgentOptions,
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
export type UndiciGlobalDispatcherDeps = Pick<UndiciRuntimeDeps, "Agent" | "EnvHttpProxyAgent"> & {
  getGlobalDispatcher: typeof import("undici").getGlobalDispatcher;
  setGlobalDispatcher: typeof import("undici").setGlobalDispatcher;
};

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
  return loadUndiciModule([
    "Agent",
    "EnvHttpProxyAgent",
    "getGlobalDispatcher",
    "setGlobalDispatcher",
  ]);
}

/** Creates a direct undici Agent with OpenClaw's HTTP/1-only dispatcher policy. */
export function createHttp1Agent(
  options?: UndiciAgentOptions,
  timeoutMs?: number,
): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(new Agent(buildHttp1AgentOptions(options, timeoutMs)));
}

/**
 * Creates an EnvHttpProxyAgent with OpenClaw proxy TLS, IP-safe proxy pools,
 * timeout propagation, and HTTP/1-only dispatch.
 */
export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeoutMs?: number,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(
    new EnvHttpProxyAgent(buildHttp1EnvHttpProxyAgentOptions(options, timeoutMs)),
  );
}

/**
 * Creates a fixed ProxyAgent with the same HTTP/1, managed TLS, timeout, and
 * IP-safe proxy connection policy used by env proxy dispatchers.
 */
export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
): import("undici").ProxyAgent {
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(
    new ProxyAgent(buildHttp1ProxyAgentOptions(options, timeoutMs)),
  );
}
