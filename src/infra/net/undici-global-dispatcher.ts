import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import {
  createUndiciAutoSelectFamilyConnectOptions,
  resolveUndiciAutoSelectFamily,
} from "./undici-family-policy.js";
import {
  loadUndiciGlobalDispatcherDeps,
  type UndiciGlobalDispatcherDeps,
} from "./undici-runtime.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let _globalUndiciStreamTimeoutMs: number | undefined;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrap = false;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
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

function resolveStreamTimeoutMs(opts?: { timeoutMs?: number }): number | null {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return null;
  }
  return Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
}

function resolveCurrentDispatcherKind(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): Exclude<DispatcherKind, "unsupported"> | null {
  let dispatcher: unknown;
  try {
    dispatcher = runtime.getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  return currentKind === "unsupported" ? null : currentKind;
}

export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const { EnvHttpProxyAgent, setGlobalDispatcher } = runtime;
  if (lastAppliedProxyBootstrap) {
    if (resolveCurrentDispatcherKind(runtime) === "env-proxy") {
      return;
    }
    lastAppliedProxyBootstrap = false;
  }
  const currentKind = resolveCurrentDispatcherKind(runtime);
  if (currentKind === null) {
    return;
  }
  if (currentKind === "env-proxy") {
    lastAppliedProxyBootstrap = true;
    return;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent(resolveEnvHttpProxyAgentOptions()));
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort bootstrap only.
  }
}

function applyGlobalDispatcherStreamTimeouts(params: {
  runtime: UndiciGlobalDispatcherDeps;
  kind: Exclude<DispatcherKind, "unsupported">;
  timeoutMs: number;
}): void {
  const { runtime, kind, timeoutMs } = params;
  const autoSelectFamily = resolveUndiciAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedTimeoutKey === nextKey) {
    return;
  }

  const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        ...resolveEnvHttpProxyAgentOptions(),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
      runtime.setGlobalDispatcher(new runtime.EnvHttpProxyAgent(proxyOptions));
    } else {
      runtime.setGlobalDispatcher(
        new runtime.Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
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
  const kind = resolveCurrentDispatcherKind(runtime);
  if (kind === null) {
    return;
  }
  if (kind !== "env-proxy") {
    return;
  }

  applyGlobalDispatcherStreamTimeouts({ runtime, kind, timeoutMs });
}

export function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const runtime = loadUndiciGlobalDispatcherDeps();
  const kind = resolveCurrentDispatcherKind(runtime);
  if (kind === null) {
    return;
  }
  applyGlobalDispatcherStreamTimeouts({ runtime, kind, timeoutMs });
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
  _globalUndiciStreamTimeoutMs = undefined;
}

/**
 * Re-evaluate proxy env changes for undici. Installs EnvHttpProxyAgent when
 * proxy env is present, and restores a direct Agent after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(): void {
  lastAppliedTimeoutKey = null;
  if (!hasEnvHttpProxyAgentConfigured()) {
    if (!lastAppliedProxyBootstrap) {
      return;
    }
    lastAppliedProxyBootstrap = false;
    try {
      const { Agent, setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
      setGlobalDispatcher(new Agent());
    } catch {
      // Best-effort reset only.
    }
    return;
  }
  lastAppliedProxyBootstrap = false;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
    const proxyOptions = resolveEnvHttpProxyAgentOptions();
    setGlobalDispatcher(
      new EnvHttpProxyAgent(
        proxyOptions as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0],
      ),
    );
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort reset only.
  }
}
