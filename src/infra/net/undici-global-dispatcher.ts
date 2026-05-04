import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { hasEnvHttpProxyAgentConfigured, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import {
  createUndiciAutoSelectFamilyConnectOptions,
  resolveUndiciAutoSelectFamily,
} from "./undici-family-policy.js";

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

function resolveCurrentDispatcherKind(): DispatcherKind | null {
  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
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
  if (lastAppliedProxyBootstrap) {
    if (resolveCurrentDispatcherKind() === "env-proxy") {
      return;
    }
    lastAppliedProxyBootstrap = false;
  }
  const currentKind = resolveCurrentDispatcherKind();
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

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }
  const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
  _globalUndiciStreamTimeoutMs = timeoutMs;
  const kind = resolveCurrentDispatcherKind();
  if (kind === null) {
    return;
  }

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
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
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
  lastAppliedProxyBootstrap = false;
  try {
    const proxyOptions = resolveEnvHttpProxyAgentOptions();
    if (hasEnvHttpProxyAgentConfigured()) {
      setGlobalDispatcher(
        new EnvHttpProxyAgent(proxyOptions as ConstructorParameters<typeof EnvHttpProxyAgent>[0]),
      );
      lastAppliedProxyBootstrap = true;
    } else {
      setGlobalDispatcher(new Agent());
    }
  } catch {
    // Best-effort reset only.
  }
}
