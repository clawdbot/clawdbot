import { isProxylineDispatcher } from "@openclaw/proxyline/dispatcher-brand";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import {
  createUndiciAutoSelectFamilyConnectOptions,
  resolveUndiciAutoSelectFamily,
  withTemporaryUndiciAutoSelectFamily,
} from "./undici-family-policy.js";
import {
  loadUndiciGlobalDispatcherDeps,
  type UndiciGlobalDispatcherDeps,
} from "./undici-runtime.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs: number | undefined;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrapKey: string | null = null;

type DispatcherKind = "agent" | "env-proxy" | "proxyline-managed" | "unsupported";
type SupportedDispatcherKind = Exclude<DispatcherKind, "unsupported">;
type UndiciDispatcher = Parameters<UndiciGlobalDispatcherDeps["setGlobalDispatcher"]>[0];
type UndiciDispatchOptions = Parameters<UndiciDispatcher["dispatch"]>[0];
type UndiciDispatchHandler = Parameters<UndiciDispatcher["dispatch"]>[1];
type CurrentDispatcherInfo = {
  kind: SupportedDispatcherKind;
  dispatcher: UndiciDispatcher;
};
type TimedProxylineManagedDispatcherState = {
  autoSelectFamily: boolean | undefined;
  timeoutMs: number;
  dispatch: UndiciDispatcher["dispatch"];
};

const UNDICI_DISPATCH_HELPER_METHODS = new Set<PropertyKey>([
  "compose",
  "connect",
  "pipeline",
  "request",
  "stream",
  "upgrade",
]);
const UNDICI_DISPATCHER_LIFECYCLE_METHODS = new Set<PropertyKey>(["close", "destroy"]);

const timedProxylineManagedDispatchers = new WeakMap<
  object,
  TimedProxylineManagedDispatcherState
>();

function isTimedProxylineManagedDispatcher(dispatcher: unknown): dispatcher is UndiciDispatcher {
  return typeof dispatcher === "object" && dispatcher !== null
    ? timedProxylineManagedDispatchers.has(dispatcher)
    : false;
}

function withDefaultDispatchTimeout(
  timeout: UndiciDispatchOptions["bodyTimeout"],
  timeoutMs: number,
): UndiciDispatchOptions["bodyTimeout"] {
  return timeout == null ? timeoutMs : timeout;
}

function createTimedProxylineManagedDispatcher(
  dispatcher: UndiciDispatcher,
  timeoutMs: number,
  autoSelectFamily: boolean | undefined,
): UndiciDispatcher {
  const existingState = timedProxylineManagedDispatchers.get(dispatcher);
  if (existingState) {
    existingState.autoSelectFamily = autoSelectFamily;
    existingState.timeoutMs = timeoutMs;
    return dispatcher;
  }

  const state: TimedProxylineManagedDispatcherState = {
    autoSelectFamily,
    timeoutMs,
    dispatch(options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean {
      return withTemporaryUndiciAutoSelectFamily(state.autoSelectFamily, () =>
        dispatcher.dispatch(
          {
            ...options,
            bodyTimeout: withDefaultDispatchTimeout(options.bodyTimeout, state.timeoutMs),
            headersTimeout: withDefaultDispatchTimeout(options.headersTimeout, state.timeoutMs),
            ...HTTP1_ONLY_DISPATCHER_OPTIONS,
          },
          handler,
        ),
      );
    },
  };
  const proxy = new Proxy(dispatcher, {
    get(target, property, receiver) {
      if (property === "dispatch") {
        return state.dispatch;
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (UNDICI_DISPATCHER_LIFECYCLE_METHODS.has(property)) {
        return value.bind(target);
      }
      if (UNDICI_DISPATCH_HELPER_METHODS.has(property)) {
        return (...args: unknown[]) => Reflect.apply(value, receiver, args);
      }
      return value;
    },
  });
  timedProxylineManagedDispatchers.set(proxy, state);
  return proxy;
}

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (isTimedProxylineManagedDispatcher(dispatcher) || isProxylineDispatcher(dispatcher)) {
    return "proxyline-managed";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

function resolveEnvProxyDispatcherOptions(): ConstructorParameters<
  UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]
>[0] {
  return {
    ...resolveEnvHttpProxyAgentOptions(),
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
  } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
}

function resolveEnvProxyBootstrapKey(
  options: ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0],
): string {
  const entries = Object.entries((options ?? {}) as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function resolveStreamTimeoutMs(opts?: { timeoutMs?: number }): number | null {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return null;
  }
  return Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
}

function resolveCurrentDispatcherKind(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): SupportedDispatcherKind | null {
  return resolveCurrentDispatcherInfo(runtime)?.kind ?? null;
}

function resolveCurrentDispatcherInfo(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): CurrentDispatcherInfo | null {
  let dispatcher: unknown;
  try {
    dispatcher = runtime.getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  if (currentKind === "unsupported") {
    return null;
  }
  return {
    kind: currentKind,
    dispatcher: dispatcher as UndiciDispatcher,
  };
}

export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const { EnvHttpProxyAgent, setGlobalDispatcher } = runtime;
  const proxyOptions = resolveEnvProxyDispatcherOptions();
  const nextBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  const currentKind = resolveCurrentDispatcherKind(runtime);
  if (currentKind === null) {
    return;
  }
  if (currentKind === "proxyline-managed") {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === null) {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === nextBootstrapKey) {
    return;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
  } catch {
    // Best-effort bootstrap only.
  }
}

function applyGlobalDispatcherStreamTimeouts(params: {
  runtime: UndiciGlobalDispatcherDeps;
  dispatcher: UndiciDispatcher;
  kind: SupportedDispatcherKind;
  timeoutMs: number;
}): void {
  const { runtime, dispatcher, kind, timeoutMs } = params;
  const autoSelectFamily = resolveUndiciAutoSelectFamily();
  const nextKey = resolveDispatcherKey({
    kind,
    timeoutMs,
    autoSelectFamily,
  });
  const needsProxylineWrapper =
    kind === "proxyline-managed" && !isTimedProxylineManagedDispatcher(dispatcher);
  if (lastAppliedTimeoutKey === nextKey && !needsProxylineWrapper) {
    return;
  }

  const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
  try {
    if (kind === "proxyline-managed") {
      runtime.setGlobalDispatcher(
        createTimedProxylineManagedDispatcher(dispatcher, timeoutMs, autoSelectFamily),
      );
    } else if (kind === "env-proxy") {
      const proxyOptions = {
        ...resolveEnvHttpProxyAgentOptions(),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
        ...HTTP1_ONLY_DISPATCHER_OPTIONS,
      } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
      runtime.setGlobalDispatcher(new runtime.EnvHttpProxyAgent(proxyOptions));
    } else {
      runtime.setGlobalDispatcher(
        new runtime.Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
          ...HTTP1_ONLY_DISPATCHER_OPTIONS,
        }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  _globalUndiciStreamTimeoutMs = timeoutMs;
  if (!hasEnvHttpProxyAgentConfigured()) {
    lastAppliedTimeoutKey = null;
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  if (current.kind !== "env-proxy" && current.kind !== "proxyline-managed") {
    return;
  }

  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

export function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrapKey = null;
  _globalUndiciStreamTimeoutMs = undefined;
}

/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(opts?: { preserveProxylineManaged?: boolean }): void {
  lastAppliedTimeoutKey = null;
  if (!hasEnvHttpProxyAgentConfigured()) {
    if (lastAppliedProxyBootstrapKey === null) {
      return;
    }
    lastAppliedProxyBootstrapKey = null;
    try {
      const { Agent, setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
      setGlobalDispatcher(new Agent(HTTP1_ONLY_DISPATCHER_OPTIONS));
    } catch {
      // Best-effort reset only.
    }
    return;
  }
  try {
    const runtime = loadUndiciGlobalDispatcherDeps();
    const { EnvHttpProxyAgent, setGlobalDispatcher } = runtime;
    const proxyOptions = resolveEnvProxyDispatcherOptions();
    if (opts?.preserveProxylineManaged) {
      const current = resolveCurrentDispatcherInfo(runtime);
      if (current?.kind === "proxyline-managed") {
        lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
        return;
      }
    }
    setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  } catch {
    // Best-effort reset only.
  }
}
