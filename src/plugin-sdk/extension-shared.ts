import { HttpsProxyAgent } from "https-proxy-agent";
import { buildBaseChannelStatusSummary, buildProbeChannelStatusSummary } from "./status-helpers.js";
import { formatErrorMessage } from "./error-runtime.js";

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function safeParseWithSchema<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as T) : null;
}

export function safeParseJsonWithSchema<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  raw: string,
): T | null {
  try {
    return safeParseWithSchema(schema, JSON.parse(raw));
  } catch {
    return null;
  }
}

export function resolveAmbientNodeProxyAgent<T = unknown>(params?: {
  proxy?: string | null | undefined;
}): T | undefined {
  const proxy =
    params?.proxy?.trim() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  return proxy ? (new HttpsProxyAgent(proxy) as T) : undefined;
}

export function buildPassiveChannelStatusSummary(snapshot: {
  configured?: boolean | null;
  running?: boolean | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
}) {
  return buildBaseChannelStatusSummary(snapshot);
}

export function buildPassiveProbedChannelStatusSummary(
  snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
  },
  extra?: Record<string, unknown>,
) {
  return buildProbeChannelStatusSummary(snapshot, extra);
}

export function buildTrafficStatusSummary(runtime?: {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
}) {
  return {
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
  };
}

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: { addIssue: (issue: { code: string; message: string; path?: (string | number)[] }) => void };
}) {
  if (params.policy !== "open") {
    return;
  }
  const hasWildcard = (params.allowFrom ?? []).some((value) => String(value).trim() === "*");
  if (!hasWildcard) {
    params.ctx.addIssue({
      code: "custom",
      path: ["allowFrom"],
      message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
    });
  }
}

export async function runStoppablePassiveMonitor(params: {
  label?: string;
  abortSignal?: AbortSignal;
  start: (ctx: { abortSignal?: AbortSignal }) => Promise<(() => void | Promise<void>) | void>;
  onError?: (error: unknown) => void | Promise<void>;
}) {
  let stop: (() => void | Promise<void>) | void;
  try {
    stop = await params.start({ abortSignal: params.abortSignal });
    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        await stop?.();
        return;
      }
      await new Promise<void>((resolve) => {
        params.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
      });
      await stop?.();
      return;
    }
  } catch (error) {
    if (params.onError) {
      await params.onError(error);
      return;
    }
    throw new Error(
      `${params.label ?? "passive monitor"} failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}
