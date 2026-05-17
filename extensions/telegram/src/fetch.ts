import { randomUUID } from "node:crypto";
import * as dns from "node:dns";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  createPinnedLookup,
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveFetch,
  type PinnedDispatcherPolicy,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureHttpExchange,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Agent, fetch as undiciFetch } from "undici";
import { normalizeTelegramApiRoot } from "./api-root.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";
import { getProxyUrlFromFetch, makeProxyFetch } from "./proxy.js";

const log = createSubsystemLogger("telegram/network");

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const TELEGRAM_FALLBACK_IPS: readonly string[] = ["149.154.167.220"];

// Dispatcher defaults that bound the per-origin connection pool. Telegram long
// polling keeps a handful of connections hot for hours, so the defaults must be
// strict enough that (a) idle sockets are closed even when the pool is still
// actively used and (b) the pool itself cannot grow unbounded under transient
// concurrency spikes. These values are a defence-in-depth layer; the primary
// fix for the leak observed in openclaw#68128 is the transport lifecycle that
// calls `close()` on abandoned dispatchers.
const TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN = 10;
const TELEGRAM_DISPATCHER_PIPELINING = 1;
const TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS = 10_000;
const TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS = 60_000;

type TelegramAgentPoolOptions = {
  allowH2: false;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  connections: number;
  pipelining: number;
};

function telegramAgentPoolOptions(): TelegramAgentPoolOptions {
  return {
    allowH2: false,
    keepAliveTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN,
    pipelining: TELEGRAM_DISPATCHER_PIPELINING,
  };
}

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type TelegramDispatcher =
  | Agent
  | ReturnType<typeof createHttp1EnvHttpProxyAgent>
  | ReturnType<typeof createHttp1ProxyAgent>;

type TelegramDispatcherMode = "direct" | "env-proxy" | "explicit-proxy";

type TelegramDispatcherAttempt = {
  dispatcherPolicy?: PinnedDispatcherPolicy;
};

type TelegramTransportAttempt = {
  createDispatcher: () => TelegramDispatcher;
  exportAttempt: TelegramDispatcherAttempt;
  logLevel?: "debug" | "warn";
  logMessage?: string;
};

type TelegramTransportAttemptHealth = {
  consecutiveFailures: number;
  cooldownMs: number;
  unhealthyUntilMs: number;
};

type TelegramDnsResultOrder = "ipv4first" | "verbatim";

type LookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void);

type LookupOptions = (dns.LookupOneOptions | dns.LookupAllOptions) & {
  order?: TelegramDnsResultOrder;
  verbatim?: boolean;
};

type LookupFunction = (
  hostname: string,
  options: number | dns.LookupOneOptions | dns.LookupAllOptions | undefined,
  callback: LookupCallback,
) => void;

const FALLBACK_RETRY_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

type TelegramTransportFallbackContext = {
  message: string;
  codes: Set<string>;
};

function normalizeDnsResultOrder(value: string | null): TelegramDnsResultOrder | null {
  if (value === "ipv4first" || value === "verbatim") {
    return value;
  }
  return null;
}

function createDnsResultOrderLookup(
  order: TelegramDnsResultOrder | null,
): LookupFunction | undefined {
  if (!order) {
    return undefined;
  }
  const lookup = dns.lookup as unknown as (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => void;
  return (hostname, options, callback) => {
    const baseOptions: LookupOptions =
      typeof options === "number"
        ? { family: options }
        : options
          ? { ...(options as LookupOptions) }
          : {};
    const lookupOptions: LookupOptions = {
      ...baseOptions,
      order,
      verbatim: order === "verbatim",
    };
    lookup(hostname, lookupOptions, callback);
  };
}

function buildTelegramConnectOptions(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  forceIpv4: boolean;
}): {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  family?: number;
  lookup?: LookupFunction;
} | null {
  const connect: {
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
    family?: number;
    lookup?: LookupFunction;
  } = {};

  if (params.forceIpv4) {
    connect.family = 4;
    connect.autoSelectFamily = false;
  } else if (typeof params.autoSelectFamily === "boolean") {
    connect.autoSelectFamily = params.autoSelectFamily;
    connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
  }

  const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
  if (lookup) {
    connect.lookup = lookup;
  }

  return Object.keys(connect).length > 0 ? connect : null;
}

function shouldBypassEnvProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }
  const targetHostname = normalizeLowercaseStringOrEmpty(TELEGRAM_API_HOSTNAME);
  const targetPort = 443;
  const noProxyEntries = noProxyValue.split(/[,\s]/);
  for (let i = 0; i < noProxyEntries.length; i++) {
    const entry = noProxyEntries[i];
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = normalizeLowercaseStringOrEmpty(
      (parsed ? parsed[1] : entry).replace(/^\*?\./, ""),
    );
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== targetPort) {
      continue;
    }
    if (
      targetHostname === entryHostname ||
      targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`
    ) {
      return true;
    }
  }
  return false;
}

function hasEnvHttpProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnvHttpProxyAgentConfigured(env);
}

function resolveOpenClawProxyUrlForTelegram(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const proxyUrl = env.OPENCLAW_PROXY_URL?.trim();
  return proxyUrl ? proxyUrl : undefined;
}

function resolveTelegramDispatcherPolicy(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  forceIpv4: boolean;
  proxyUrl?: string;
}): { policy: PinnedDispatcherPolicy; mode: TelegramDispatcherMode } {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4,
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      policy: connect
        ? {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
            allowPrivateProxy: true,
            proxyTls: { ...connect },
          }
        : {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
            allowPrivateProxy: true,
          },
      mode: "explicit-proxy",
    };
  }
  if (params.useEnvProxy) {
    return {
      policy: {
        mode: "env-proxy",
        ...(connect ? { connect: { ...connect }, proxyTls: { ...connect } } : {}),
      },
      mode: "env-proxy",
    };
  }
  return {
    policy: {
      mode: "direct",
      ...(connect ? { connect: { ...connect } } : {}),
    },
    mode: "direct",
  };
}

function withPinnedLookup(
  options: Record<string, unknown> | undefined,
  pinnedHostname: PinnedDispatcherPolicy["pinnedHostname"],
): Record<string, unknown> | undefined {
  if (!pinnedHostname) {
    return options ? { ...options } : undefined;
  }
  const lookup = createPinnedLookup({
    hostname: pinnedHostname.hostname,
    addresses: [...pinnedHostname.addresses],
    fallback: dns.lookup,
  });
  return options ? { ...options, lookup } : { lookup };
}

function createTelegramDispatcher(policy: PinnedDispatcherPolicy): {
  dispatcher: TelegramDispatcher;
  mode: TelegramDispatcherMode;
  effectivePolicy: PinnedDispatcherPolicy;
} {
  // Telegram polling uses long-lived connections. Undici 8 enables HTTP/2 ALPN
  // by default, which can stall Telegram long-polling on Windows/IPv6 networks.
  // Force HTTP/1.1 for every dispatcher while keeping bounded pool defaults.
  const poolOptions = telegramAgentPoolOptions();

  if (policy.mode === "explicit-proxy") {
    const requestTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
    const proxyOptions = {
      uri: policy.proxyUrl,
      ...poolOptions,
      ...(requestTlsOptions ? { requestTls: requestTlsOptions } : {}),
    } satisfies Parameters<typeof createHttp1ProxyAgent>[0];
    try {
      return {
        dispatcher: createHttp1ProxyAgent(proxyOptions),
        mode: "explicit-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      const reason = formatErrorMessage(err);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
    }
  }

  if (policy.mode === "env-proxy") {
    const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
    const proxyTlsOptions = withPinnedLookup(policy.proxyTls, policy.pinnedHostname);
    const proxyOptions = {
      ...poolOptions,
      ...resolveEnvHttpProxyAgentOptions(),
      ...(connectOptions ? { connect: connectOptions } : {}),
      ...(proxyTlsOptions ? { proxyTls: proxyTlsOptions } : {}),
    } satisfies Parameters<typeof createHttp1EnvHttpProxyAgent>[0];
    try {
      return {
        dispatcher: createHttp1EnvHttpProxyAgent(proxyOptions),
        mode: "env-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${formatErrorMessage(err)}`,
      );
      const directPolicy: PinnedDispatcherPolicy = {
        mode: "direct",
        ...(connectOptions ? { connect: connectOptions } : {}),
      };
      return {
        dispatcher: new Agent({
          ...poolOptions,
          ...(directPolicy.connect ? { connect: directPolicy.connect } : {}),
        } satisfies ConstructorParameters<typeof Agent>[0]),
        mode: "direct",
        effectivePolicy: directPolicy,
      };
    }
  }

  const connectOptions = withPinnedLookup(policy.connect, policy.pinnedHostname);
  return {
    dispatcher: new Agent({
      ...poolOptions,
      ...(connectOptions ? { connect: connectOptions } : {}),
    } satisfies ConstructorParameters<typeof Agent>[0]),
    mode: "direct",
    effectivePolicy: policy,
  };
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: TelegramDispatcher,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}

function resolveWrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}

function logResolverNetworkDecisions(params: {
  autoSelectDecision: ReturnType<typeof resolveTelegramAutoSelectFamilyDecision>;
  dnsDecision: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
}): void {
  if (params.autoSelectDecision.value !== null) {
    const sourceLabel = params.autoSelectDecision.source
      ? ` (${params.autoSelectDecision.source})`
      : "";
    log.debug(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
  }
  if (params.dnsDecision.value !== null) {
    const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
    log.debug(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
  }
}

function collectErrorCodes(err: unknown): Set<string> {
  const codes = new Set<string>();
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return codes;
}

function formatErrorCodes(err: unknown): string {
  const codes = [...collectErrorCodes(err)];
  return codes.length > 0 ? codes.join(",") : "none";
}

class TelegramTransportAttemptUnhealthyError extends Error {
  constructor(unhealthyUntilMs: number) {
    const remainingMs = Math.max(0, unhealthyUntilMs - Date.now());
    super(`telegram transport attempt temporarily unhealthy; retry after ${remainingMs}ms`);
    this.name = "TelegramTransportAttemptUnhealthyError";
  }
}

function shouldUseTelegramTransportFallback(err: unknown): boolean {
  if (err instanceof TelegramTransportAttemptUnhealthyError) {
    return true;
  }
  const ctx: TelegramTransportFallbackContext = {
    message:
      err && typeof err === "object" && "message" in err
        ? normalizeLowercaseStringOrEmpty(String(err.message))
        : "",
    codes: collectErrorCodes(err),
  };
  const hasFetchFailedEnvelope = ctx.message.includes("fetch failed");
  const hasKnownNetworkCode = FALLBACK_RETRY_ERROR_CODES.some((code) => ctx.codes.has(code));
  return hasKnownNetworkCode || (hasFetchFailedEnvelope && ctx.codes.size === 0);
}

export function shouldRetryTelegramTransportFallback(err: unknown): boolean {
  return shouldUseTelegramTransportFallback(err);
}

export type TelegramTransport = {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  dispatcherAttempts?: TelegramDispatcherAttempt[];
  /**
   * Promote this transport to its next fallback dispatcher before the next
   * request. Returns false when no fallback path exists.
   */
  forceFallback?: (reason: string) => boolean;
  /**
   * Release all dispatchers owned by this transport and the TCP sockets they
   * hold. Safe to call multiple times; subsequent calls resolve immediately.
   *
   * Callers that pass their own `proxyFetch` own the underlying dispatcher
   * lifecycle themselves and this is effectively a no-op. Callers that let
   * this module construct the transport MUST invoke `close()` when the
   * transport is no longer needed (e.g. on polling session dispose or when
   * swapping transports after a network stall); otherwise undici keeps the
   * keep-alive sockets open indefinitely, leaking hundreds of connections
   * to api.telegram.org over long-running sessions.
   */
  close(): Promise<void>;
};

function createTelegramTransportAttempts(params: {
  defaultDispatcher: ReturnType<typeof createTelegramDispatcher>;
  allowFallback: boolean;
  fallbackPolicy?: PinnedDispatcherPolicy;
  ownedDispatchers: Set<TelegramDispatcher>;
}): TelegramTransportAttempt[] {
  params.ownedDispatchers.add(params.defaultDispatcher.dispatcher);

  const attempts: TelegramTransportAttempt[] = [
    {
      createDispatcher: () => params.defaultDispatcher.dispatcher,
      exportAttempt: { dispatcherPolicy: params.defaultDispatcher.effectivePolicy },
    },
  ];

  if (!params.allowFallback || !params.fallbackPolicy) {
    return attempts;
  }
  const fallbackPolicy = params.fallbackPolicy;
  const ownedDispatchers = params.ownedDispatchers;

  let ipv4Dispatcher: TelegramDispatcher | null = null;
  attempts.push({
    createDispatcher: () => {
      if (!ipv4Dispatcher) {
        ipv4Dispatcher = createTelegramDispatcher(fallbackPolicy).dispatcher;
        ownedDispatchers.add(ipv4Dispatcher);
      }
      return ipv4Dispatcher;
    },
    exportAttempt: { dispatcherPolicy: fallbackPolicy },
    logLevel: "debug",
    logMessage: "fetch fallback: enabling sticky IPv4-only dispatcher",
  });

  if (TELEGRAM_FALLBACK_IPS.length === 0) {
    return attempts;
  }

  const fallbackIpPolicy: PinnedDispatcherPolicy = {
    ...fallbackPolicy,
    pinnedHostname: {
      hostname: TELEGRAM_API_HOSTNAME,
      addresses: [...TELEGRAM_FALLBACK_IPS],
    },
  };
  let fallbackIpDispatcher: TelegramDispatcher | null = null;
  attempts.push({
    createDispatcher: () => {
      if (!fallbackIpDispatcher) {
        fallbackIpDispatcher = createTelegramDispatcher(fallbackIpPolicy).dispatcher;
        ownedDispatchers.add(fallbackIpDispatcher);
      }
      return fallbackIpDispatcher;
    },
    exportAttempt: { dispatcherPolicy: fallbackIpPolicy },
    logLevel: "warn",
    logMessage: "fetch fallback: DNS-resolved IP unreachable; trying alternative Telegram API IP",
  });

  return attempts;
}

async function destroyOwnedDispatchers(dispatchers: Iterable<TelegramDispatcher>): Promise<void> {
  // Use destroy() rather than close() so abandoned sockets are released
  // immediately without waiting for in-flight requests that the caller has
  // already decided to abandon (session aborted, or stale transport being
  // replaced after a stall). The per-dispatcher try/catch isolates failures
  // (already-destroyed dispatchers throw) so Promise.all never rejects.
  await Promise.all(
    [...dispatchers].map(async (dispatcher) => {
      try {
        await dispatcher.destroy();
      } catch {
        // Intentionally ignored: dispatcher may already be destroyed.
      }
    }),
  );
}

export function resolveTelegramTransport(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): TelegramTransport {
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({
    network: options?.network,
  });
  const dnsDecision = resolveTelegramDnsResultOrderDecision({
    network: options?.network,
  });
  logResolverNetworkDecisions({
    autoSelectDecision,
    dnsDecision,
  });

  const effectiveProxyFetch =
    proxyFetch ??
    (() => {
      const debugProxyUrl = resolveEffectiveDebugProxyUrl(undefined);
      return debugProxyUrl ? makeProxyFetch(debugProxyUrl) : undefined;
    })();
  const explicitProxyUrl = effectiveProxyFetch
    ? getProxyUrlFromFetch(effectiveProxyFetch)
    : undefined;
  const hasEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
  const managedProxyUrl =
    !effectiveProxyFetch && !hasEnvProxy ? resolveOpenClawProxyUrlForTelegram() : undefined;
  const resolvedExplicitProxyUrl = explicitProxyUrl ?? managedProxyUrl;
  const undiciSourceFetch = resolveWrappedFetch(undiciFetch as unknown as typeof fetch);
  const sourceFetch = resolvedExplicitProxyUrl
    ? undiciSourceFetch
    : effectiveProxyFetch
      ? resolveWrappedFetch(effectiveProxyFetch)
      : undiciSourceFetch;
  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  if (effectiveProxyFetch && !explicitProxyUrl) {
    // The caller owns the underlying dispatcher lifecycle; nothing to close here.
    return { fetch: sourceFetch, sourceFetch, close: async () => {} };
  }

  const useEnvProxy = !resolvedExplicitProxyUrl && hasEnvProxy;
  const defaultDispatcherResolution = resolveTelegramDispatcherPolicy({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    forceIpv4: false,
    proxyUrl: resolvedExplicitProxyUrl,
  });
  const defaultDispatcher = createTelegramDispatcher(defaultDispatcherResolution.policy);
  const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
  const allowStickyFallback =
    defaultDispatcher.mode === "direct" ||
    (defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy);
  const fallbackDispatcherPolicy = allowStickyFallback
    ? resolveTelegramDispatcherPolicy({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
        useEnvProxy: defaultDispatcher.mode === "env-proxy",
        forceIpv4: true,
        proxyUrl: resolvedExplicitProxyUrl,
      }).policy
    : undefined;
  const ownedDispatchers = new Set<TelegramDispatcher>();
  const transportAttempts = createTelegramTransportAttempts({
    defaultDispatcher,
    allowFallback: allowStickyFallback,
    fallbackPolicy: fallbackDispatcherPolicy,
    ownedDispatchers,
  });

  let stickyAttemptIndex = 0;
  let stickySuccessCount = 0;
  let primaryProbeDue = false;
  const attemptHealth = transportAttempts.map<TelegramTransportAttemptHealth>(() => ({
    consecutiveFailures: 0,
    cooldownMs: TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS,
    unhealthyUntilMs: 0,
  }));

  const resetStickyRecoveryProbe = (): void => {
    stickySuccessCount = 0;
    primaryProbeDue = false;
  };

  const getAttemptCooldownError = (attemptIndex: number): Error | null => {
    const health = attemptHealth[attemptIndex];
    if (health.unhealthyUntilMs <= Date.now()) {
      return null;
    }
    return new TelegramTransportAttemptUnhealthyError(health.unhealthyUntilMs);
  };

  const recordAttemptFailure = (attemptIndex: number, err: unknown): void => {
    if (!shouldUseTelegramTransportFallback(err)) {
      return;
    }
    const health = attemptHealth[attemptIndex];
    health.consecutiveFailures += 1;
    if (health.consecutiveFailures < TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD) {
      return;
    }
    const cooldownMs = Math.min(
      TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS,
      Math.max(TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS, health.cooldownMs),
    );
    health.consecutiveFailures = 0;
    health.cooldownMs = Math.min(TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS, cooldownMs * 2);
    health.unhealthyUntilMs = Date.now() + cooldownMs;
    log.warn(
      `telegram transport attempt marked temporarily unhealthy for ${cooldownMs}ms (codes=${formatErrorCodes(err)})`,
    );
  };

  const promoteStickyAttempt = (nextIndex: number, err: unknown, reason?: string): boolean => {
    if (nextIndex <= stickyAttemptIndex || nextIndex >= transportAttempts.length) {
      return false;
    }
    const nextAttempt = transportAttempts[nextIndex];
    if (nextAttempt.logMessage) {
      const reasonText = reason ? `, reason=${reason}` : "";
      const logLine = `${nextAttempt.logMessage} (codes=${formatErrorCodes(err)}${reasonText})`;
      if (nextAttempt.logLevel === "debug") {
        log.debug(logLine);
      } else {
        log.warn(logLine);
      }
    }
    stickyAttemptIndex = nextIndex;
    resetStickyRecoveryProbe();
    return true;
  };

  const recordSuccessfulAttempt = (attemptIndex: number): void => {
    const health = attemptHealth[attemptIndex];
    health.consecutiveFailures = 0;
    health.cooldownMs = TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS;
    health.unhealthyUntilMs = 0;

    if (stickyAttemptIndex === 0) {
      resetStickyRecoveryProbe();
      return;
    }

    if (attemptIndex < stickyAttemptIndex) {
      log.debug(
        `fetch fallback: recovered from attempt ${stickyAttemptIndex} to attempt ${attemptIndex}`,
      );
      stickyAttemptIndex = attemptIndex;
      resetStickyRecoveryProbe();
      return;
    }

    if (attemptIndex !== stickyAttemptIndex) {
      return;
    }

    stickySuccessCount += 1;
    if (stickySuccessCount >= TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD) {
      stickySuccessCount = 0;
      primaryProbeDue = true;
      log.debug("fetch fallback: scheduling primary dispatcher recovery probe");
    }
  };

  const resolvedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerProvidedDispatcher = Boolean(
      (init as RequestInitWithDispatcher | undefined)?.dispatcher,
    );
    const stickyStartIndex = Math.min(stickyAttemptIndex, transportAttempts.length - 1);
    const stickyCooldownError = callerProvidedDispatcher
      ? null
      : getAttemptCooldownError(stickyStartIndex);
    const primaryProbe =
      !callerProvidedDispatcher &&
      stickyStartIndex > 0 &&
      (primaryProbeDue || stickyCooldownError !== null);
    const startIndex = primaryProbe ? 0 : stickyStartIndex;
    if (primaryProbe) {
      primaryProbeDue = false;
      log.debug(
        stickyCooldownError
          ? "fetch fallback: re-probing primary dispatcher while sticky fallback is cooling down"
          : "fetch fallback: re-probing primary dispatcher after sticky fallback successes",
      );
    }
    let err: unknown;

    if (callerProvidedDispatcher) {
      try {
        const response = await sourceFetch(input, init);
        captureHttpExchange({
          url: resolveRequestUrl(input),
          method: init?.method ?? "GET",
          requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
          requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
          response,
          flowId: randomUUID(),
          meta: { subsystem: "telegram-fetch" },
        });
        return response;
      } catch (caught) {
        if (!shouldUseTelegramTransportFallback(caught)) {
          throw caught;
        }
        return sourceFetch(input, init ?? {});
      }
    }

    for (
      let attemptIndex = startIndex;
      attemptIndex < transportAttempts.length;
      attemptIndex += 1
    ) {
      const attempt = transportAttempts[attemptIndex];
      if (attemptIndex > startIndex) {
        promoteStickyAttempt(attemptIndex, err);
      }
      const cooldownError = getAttemptCooldownError(attemptIndex);
      if (cooldownError) {
        err = cooldownError;
        continue;
      }
      try {
        const response = await sourceFetch(
          input,
          withDispatcherIfMissing(init, attempt.createDispatcher()),
        );
        captureHttpExchange({
          url: resolveRequestUrl(input),
          method: init?.method ?? "GET",
          requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
          requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
          response,
          flowId: randomUUID(),
          meta:
            attemptIndex === startIndex
              ? { subsystem: "telegram-fetch" }
              : { subsystem: "telegram-fetch", fallbackAttempt: attemptIndex },
        });
        recordSuccessfulAttempt(attemptIndex);
        return response;
      } catch (caught) {
        err = caught;
        if (!shouldUseTelegramTransportFallback(err)) {
          throw err;
        }
        recordAttemptFailure(attemptIndex, err);
      }
    }

    throw err;
  }) as typeof fetch;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    const toDestroy = [...ownedDispatchers];
    ownedDispatchers.clear();
    await destroyOwnedDispatchers(toDestroy);
  };

  return {
    fetch: resolvedFetch,
    sourceFetch,
    dispatcherAttempts: transportAttempts.map((attempt) => attempt.exportAttempt),
    forceFallback: (reason: string) =>
      promoteStickyAttempt(stickyAttemptIndex + 1, new Error("forced fallback"), reason),
    close,
  };
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}

/**
 * Resolve the Telegram Bot API base URL from an optional `apiRoot` config value.
 * Returns a trimmed URL without trailing slash, or the standard default.
 */
export function resolveTelegramApiBase(apiRoot?: string): string {
  return normalizeTelegramApiRoot(apiRoot);
}
