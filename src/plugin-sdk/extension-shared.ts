// Extension shared helpers expose cross-plugin runtime utilities that remain SDK-safe.
import { createAmbientNodeProxyAgent, hasAmbientNodeProxyConfigured } from "@openclaw/proxyline";
import type { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import { resolveActiveManagedProxyTlsOptions } from "../infra/net/proxy/managed-proxy-undici.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { runPassiveAccountLifecycle } from "./channel-lifecycle.core.js";
import { createLoggerBackedRuntime } from "./runtime-logger.js";
export { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";
export { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";

type PassiveChannelStatusSnapshot = {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: unknown;
  lastProbeAt?: number | null;
};

type TrafficStatusSnapshot = {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

type StoppableMonitor = {
  stop: () => void;
};

type RequireOpenAllowFromFn = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => void;

/**
 * Builds the standard passive-channel status object used by plugin status surfaces.
 * Missing lifecycle fields are normalized to stable defaults so callers can merge
 * plugin-specific extras without leaking `undefined` into status responses.
 */
export function buildPassiveChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    configured: snapshot.configured ?? false,
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

/** Adds probe state to the standard passive-channel status summary. */
export function buildPassiveProbedChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    ...buildPassiveChannelStatusSummary(snapshot, extra),
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  };
}

/** Normalizes optional traffic timestamps for channel status payloads. */
export function buildTrafficStatusSummary(snapshot?: TrafficStatusSnapshot | null) {
  return {
    lastInboundAt: snapshot?.lastInboundAt ?? null,
    lastOutboundAt: snapshot?.lastOutboundAt ?? null,
  };
}

/**
 * Runs a passive monitor until the supplied abort signal fires, then calls `stop()`.
 * This adapts simple plugin monitors to the shared passive account lifecycle.
 */
export async function runStoppablePassiveMonitor<TMonitor extends StoppableMonitor>(params: {
  abortSignal: AbortSignal;
  start: () => Promise<TMonitor>;
}): Promise<void> {
  await runPassiveAccountLifecycle({
    abortSignal: params.abortSignal,
    start: params.start,
    stop: async (monitor) => {
      monitor.stop();
    },
  });
}

/**
 * Returns the provided runtime or creates a logger-backed fallback for monitor-only paths.
 * The fallback cannot exit the process, so command/runtime callers should inject a real runtime.
 */
export function resolveLoggerBackedRuntime<TRuntime>(
  runtime: TRuntime | undefined,
  logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"],
): TRuntime {
  return (
    runtime ??
    (createLoggerBackedRuntime({
      logger,
      exitError: () => new Error("Runtime exit not available"),
    }) as TRuntime)
  );
}

/** Applies the shared validation rule for open DM policies that require wildcard allowlists. */
export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  requireOpenAllowFrom: RequireOpenAllowFromFn;
}) {
  params.requireOpenAllowFrom({
    policy: params.policy,
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    path: ["allowFrom"],
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
  });
}

/** Extracts a fixed set of fields from unknown status issue payloads without trusting shape. */
export function readStatusIssueFields<TField extends string>(
  value: unknown,
  fields: readonly TField[],
): Record<TField, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<TField, unknown>;
  for (const field of fields) {
    result[field] = record[field];
  }
  return result;
}

/** Converts string or numeric account identifiers from status issue payloads to strings. */
export function coerceStatusIssueAccountId(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/** Creates a promise with externally controlled resolve/reject hooks for async handoff code. */
export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES = [
  "../package.json",
  "./package.json",
  "../../package.json",
] as const;

type PackageJsonRequire = (id: string) => unknown;

type PluginConfigIssuePathSegment = string | number;

type PluginConfigIssue = {
  path: PluginConfigIssuePathSegment[];
  message: string;
};

type PluginConfigIssueMessageOptions = {
  invalidConfigMessage?: string;
  unknownKeyMessage?: (key: string) => string;
  rootInvalidTypeMessage?: string;
};

/** Formats Zod plugin-config issues into stable user-facing status messages. */
export function formatPluginConfigIssue(
  issue: z.ZodIssue | undefined,
  options?: PluginConfigIssueMessageOptions,
): string {
  if (!issue) {
    return options?.invalidConfigMessage ?? "invalid config";
  }
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return options?.unknownKeyMessage?.(issue.keys[0]) ?? `unknown config key: ${issue.keys[0]}`;
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return options?.rootInvalidTypeMessage ?? "expected config object";
  }
  return issue.message;
}

/** Keeps only string/number path segments so config issue paths stay JSON-safe. */
export function normalizePluginConfigIssuePath(
  path: readonly unknown[],
): PluginConfigIssuePathSegment[] {
  return path.filter((segment): segment is PluginConfigIssuePathSegment => {
    const kind = typeof segment;
    return kind === "string" || kind === "number";
  });
}

/** Converts raw Zod issues into the plugin status issue shape used by bundled channels. */
export function mapPluginConfigIssues(
  issues: readonly z.ZodIssue[],
  options?: PluginConfigIssueMessageOptions,
): PluginConfigIssue[] {
  return issues.map((issue) => ({
    path: normalizePluginConfigIssuePath(issue.path),
    message: formatPluginConfigIssue(issue, options),
  }));
}

/** Checks whether a read-only plugin path may resolve a secret through an env provider. */
export function canResolveEnvSecretRefInReadOnlyPath(params: {
  cfg?: OpenClawConfig;
  provider: string;
  id: string;
}): boolean {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (!providerConfig) {
    return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
  }
  if (providerConfig.source !== "env") {
    return false;
  }
  const allowlist = providerConfig.allowlist;
  return !allowlist || allowlist.includes(params.id);
}

/** Reads plugin package versions across source, bundled, and test layouts with a fallback. */
export function readPluginPackageVersion(params: {
  require: PackageJsonRequire;
  candidates?: readonly string[];
  fallback?: string;
}): string {
  for (const candidate of params.candidates ?? DEFAULT_PACKAGE_JSON_VERSION_CANDIDATES) {
    try {
      const version = (params.require(candidate) as { version?: unknown }).version;
      if (typeof version === "string" && version.trim().length > 0) {
        return version;
      }
    } catch {
      // Ignore missing candidate paths across source and bundled layouts.
    }
  }
  return params.fallback ?? "unknown";
}

/**
 * Builds an ambient Node proxy agent when proxy env/config is active.
 * Managed proxy CA trust is attached when available; creation errors are reported
 * through `onError` and otherwise degrade to no agent.
 */
export async function resolveAmbientNodeProxyAgent<TAgent>(params?: {
  onError?: (error: unknown) => void;
  onUsingProxy?: () => void;
  protocol?: "http" | "https";
}): Promise<TAgent | undefined> {
  const protocol = params?.protocol ?? "https";
  if (!hasAmbientNodeProxyConfigured({ protocol })) {
    return undefined;
  }
  try {
    const proxyTls = resolveActiveManagedProxyTlsOptions();
    const agent = createAmbientNodeProxyAgent({
      protocol,
      ...(proxyTls ? { proxyTls } : {}),
    });
    if (agent === undefined) {
      return undefined;
    }
    params?.onUsingProxy?.();
    return agent as TAgent;
  } catch (error) {
    params?.onError?.(error);
    return undefined;
  }
}
