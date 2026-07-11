// Discord plugin module implements rest behavior.
import { inspect } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  clampTimerTimeoutMs,
  parseFiniteNumber,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { serializeRequestBody } from "./rest-body.js";
import {
  DiscordError,
  RateLimitError,
  readDiscordCode,
  readDiscordMessage,
  readRetryAfter,
} from "./rest-errors.js";
import { appendQuery, createRouteKey } from "./rest-routes.js";
import {
  RestScheduler,
  type RequestPriority as RestRequestPriority,
  type RequestQuery,
} from "./rest-scheduler.js";
import { isDiscordRateLimitBody } from "./schemas.js";

export { DiscordError, isUnknownDiscordVoiceStateError, RateLimitError } from "./rest-errors.js";

type RuntimeProfile = "serverless" | "persistent";
export type RequestPriority = RestRequestPriority;
type RequestSchedulerOptions = {
  lanes?: Partial<
    Record<RequestPriority, { maxQueueSize?: number; staleAfterMs?: number; weight?: number }>
  >;
  maxConcurrency?: number;
  maxRateLimitRetries?: number;
};

export type RequestClientOptions = {
  tokenHeader?: "Bot" | "Bearer";
  baseUrl?: string;
  apiVersion?: number;
  userAgent?: string;
  signal?: AbortSignal;
  timeout?: number;
  queueRequests?: boolean;
  maxQueueSize?: number;
  runtimeProfile?: RuntimeProfile;
  scheduler?: RequestSchedulerOptions;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type NormalizedRequestClientOptions = RequestClientOptions & {
  apiVersion: number;
  maxQueueSize: number;
  timeout: number;
};

export type RequestData = {
  body?: unknown;
  multipartStyle?: "message" | "form";
  rawBody?: boolean;
  headers?: Record<string, string>;
};

export type QueuedRequest = {
  method: string;
  path: string;
  data?: RequestData;
  query?: RequestQuery;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  routeKey: string;
};

const defaultOptions = {
  tokenHeader: "Bot" as const,
  baseUrl: "https://discord.com/api",
  apiVersion: 10,
  userAgent: "OpenClaw Discord",
  timeout: 15_000,
  queueRequests: true,
  maxQueueSize: 1000,
  runtimeProfile: "persistent" as RuntimeProfile,
};

const DEFAULT_MAX_CONCURRENT_WORKERS = 4;
const defaultLaneOptions: Record<RestRequestPriority, { staleAfterMs?: number; weight: number }> = {
  critical: { weight: 6 },
  standard: { weight: 3 },
  background: { staleAfterMs: 20_000, weight: 1 },
};

// Cap the REST response body well above any legitimate Discord JSON payload
// (bulk message/member fetches stay in the low hundreds of KB) so a controlled
// or hijacked endpoint cannot flood the body into an unbounded buffer (OOM).
const DISCORD_REST_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const GZIP_MAGIC = [0x1f, 0x8b] as const;

function createResponseBodyOverflowError(size: number | "decompressed output"): Error {
  return new Error(
    `Discord REST response body exceeds ${DISCORD_REST_RESPONSE_BODY_MAX_BYTES} bytes (received ${size})`,
  );
}

async function readResponseBodyText(response: Response, idleTimeoutMs: number): Promise<string> {
  const buffer = await readResponseWithLimit(response, DISCORD_REST_RESPONSE_BODY_MAX_BYTES, {
    chunkTimeoutMs: idleTimeoutMs,
    onOverflow: ({ size }) => createResponseBodyOverflowError(size),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Discord REST response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return decodeResponseBody(buffer);
}

function coerceResponseBody(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeResponseBody(buffer: Buffer): string {
  if (!buffer.byteLength) {
    return "";
  }
  if (buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) {
    try {
      return gunzipSync(buffer, {
        maxOutputLength: DISCORD_REST_RESPONSE_BODY_MAX_BYTES,
      }).toString("utf8");
    } catch (err: unknown) {
      if (isZlibMaxOutputLengthError(err)) {
        throw createResponseBodyOverflowError("decompressed output");
      }
      throw err;
    }
  }
  return buffer.toString("utf8");
}

function isZlibMaxOutputLengthError(err: unknown): boolean {
  return (
    err instanceof RangeError &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

export class RequestClient {
  readonly options: NormalizedRequestClientOptions;
  protected token: string;
  protected customFetch: RequestClientOptions["fetch"];
  protected requestControllers = new Set<AbortController>();
  private scheduler: RestScheduler<RequestData>;

  constructor(token: string, options?: RequestClientOptions) {
    this.token = token.replace(/^Bot\s+/i, "");
    this.customFetch = options?.fetch;
    this.options = normalizeRequestClientOptions(options);
    this.scheduler = new RestScheduler<RequestData>(
      {
        lanes: normalizeSchedulerLanes(this.options.maxQueueSize, this.options.scheduler?.lanes),
        maxConcurrency: normalizeIntegerOption(
          this.options.scheduler?.maxConcurrency,
          DEFAULT_MAX_CONCURRENT_WORKERS,
          { min: 1 },
        ),
        maxQueueSize: this.options.maxQueueSize,
        maxRateLimitRetries: normalizeIntegerOption(
          this.options.scheduler?.maxRateLimitRetries,
          3,
          {
            min: 0,
          },
        ),
      },
      async (request) =>
        await this.executeRequest(
          request.method,
          request.path,
          { data: request.data, query: request.query },
          request.routeKey,
        ),
    );
  }

  async get(path: string, query?: QueuedRequest["query"]): Promise<unknown> {
    return await this.request("GET", path, { query });
  }

  async post(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown> {
    return await this.request("POST", path, { data, query });
  }

  async patch(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown> {
    return await this.request("PATCH", path, { data, query });
  }

  async put(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown> {
    return await this.request("PUT", path, { data, query });
  }

  async delete(path: string, data?: RequestData, query?: QueuedRequest["query"]): Promise<unknown> {
    return await this.request("DELETE", path, { data, query });
  }

  protected async request(
    method: string,
    path: string,
    params: { data?: RequestData; query?: QueuedRequest["query"] },
  ): Promise<unknown> {
    const routeKey = createRouteKey(method, path);
    if (!this.options.queueRequests) {
      return await this.executeRequest(method, path, params, routeKey);
    }
    return await this.scheduler.enqueue({
      method,
      path,
      priority: getRequestPriority(method, path),
      ...params,
    });
  }

  protected async executeRequest(
    method: string,
    path: string,
    params: { data?: RequestData; query?: QueuedRequest["query"] },
    routeKey = createRouteKey(method, path),
  ): Promise<unknown> {
    const url = `${this.options.baseUrl}/v${this.options.apiVersion}${appendQuery(path, params.query)}`;
    const headers = new Headers({
      "User-Agent": this.options.userAgent ?? defaultOptions.userAgent,
    });
    if (this.token !== "webhook") {
      headers.set("Authorization", `${this.options.tokenHeader ?? "Bot"} ${this.token}`);
    }
    const body = serializeRequestBody(params.data, headers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout ?? 15_000);
    timeout.unref?.();
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, controller.signal])
      : controller.signal;
    this.requestControllers.add(controller);
    try {
      const response = await (this.customFetch ?? fetch)(url, {
        method,
        headers,
        body,
        signal,
      });
      const text = await readResponseBodyText(response, this.options.timeout ?? 15_000);
      const parsed = coerceResponseBody(text);
      this.scheduler.recordResponse(routeKey, path, response, parsed);
      if (response.status === 204) {
        return undefined;
      }
      if (response.status === 429) {
        const rateLimitBody = isDiscordRateLimitBody(parsed) ? parsed : undefined;
        throw new RateLimitError(response, {
          message: readDiscordMessage(rateLimitBody, "Rate limited"),
          retry_after: readRetryAfter(rateLimitBody, response, 1),
          code: readDiscordCode(rateLimitBody),
          global: Boolean(rateLimitBody?.global),
        });
      }
      if (!response.ok) {
        throw new DiscordError(response, parsed);
      }
      return parsed;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Discord request failed: ${inspect(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      this.requestControllers.delete(controller);
    }
  }

  clearQueue(): void {
    this.scheduler.clearQueue();
  }

  get queueSize(): number {
    return this.scheduler.queueSize;
  }

  getSchedulerMetrics() {
    return this.scheduler.getMetrics();
  }

  abortAllRequests(): void {
    this.scheduler.abortPending();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
  }
}

function normalizeIntegerOption(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  const candidate = parseFiniteNumber(value) ?? fallback;
  return Math.max(params.min, Math.floor(candidate));
}

function normalizeRequestClientOptions(
  options?: RequestClientOptions,
): NormalizedRequestClientOptions {
  const merged = { ...defaultOptions, ...options };
  return {
    ...merged,
    apiVersion: normalizeIntegerOption(merged.apiVersion, defaultOptions.apiVersion, { min: 1 }),
    timeout:
      clampTimerTimeoutMs(merged.timeout, 1) ?? resolveTimerTimeoutMs(defaultOptions.timeout, 1),
    maxQueueSize: normalizeIntegerOption(merged.maxQueueSize, defaultOptions.maxQueueSize, {
      min: 1,
    }),
  };
}

function normalizeSchedulerLanes(
  maxQueueSize: number,
  lanes?: RequestSchedulerOptions["lanes"],
): Record<RestRequestPriority, { maxQueueSize: number; staleAfterMs?: number; weight: number }> {
  const fallbackMaxQueueSize = normalizeIntegerOption(maxQueueSize, defaultOptions.maxQueueSize, {
    min: 1,
  });
  return {
    critical: normalizeSchedulerLane("critical", fallbackMaxQueueSize, lanes?.critical),
    standard: normalizeSchedulerLane("standard", fallbackMaxQueueSize, lanes?.standard),
    background: normalizeSchedulerLane("background", fallbackMaxQueueSize, lanes?.background),
  };
}

function normalizeSchedulerLane(
  lane: RestRequestPriority,
  maxQueueSize: number,
  options?: { maxQueueSize?: number; staleAfterMs?: number; weight?: number },
): { maxQueueSize: number; staleAfterMs?: number; weight: number } {
  const defaults = defaultLaneOptions[lane];
  const staleAfterMs =
    options?.staleAfterMs !== undefined
      ? normalizeIntegerOption(options.staleAfterMs, defaults.staleAfterMs ?? 0, { min: 0 })
      : defaults.staleAfterMs;
  return {
    maxQueueSize:
      options?.maxQueueSize !== undefined
        ? normalizeIntegerOption(options.maxQueueSize, maxQueueSize, { min: 1 })
        : maxQueueSize,
    ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    weight:
      options?.weight !== undefined
        ? normalizeIntegerOption(options.weight, defaults.weight, { min: 1 })
        : defaults.weight,
  };
}

function getRequestPriority(method: string, path: string): RestRequestPriority {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();
  if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(normalizedPath)) {
    return "critical";
  }
  return normalizedMethod === "GET" ? "background" : "standard";
}
