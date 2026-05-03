import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
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

export { DiscordError, RateLimitError } from "./rest-errors.js";

export type RuntimeProfile = "serverless" | "persistent";
export type RequestPriority = RestRequestPriority;
export type RequestSchedulerOptions = {
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
  timeout?: number;
  queueRequests?: boolean;
  maxQueueSize?: number;
  runtimeProfile?: RuntimeProfile;
  scheduler?: RequestSchedulerOptions;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

function escapeMultipartQuotedValue(value: string): string {
  return value.replace(/["\r\n]/g, (ch) => (ch === '"' ? "%22" : ch === "\r" ? "%0D" : "%0A"));
}

async function formDataToMultipartBody(body: FormData, headers: Headers): Promise<BodyInit> {
  const boundary = `----openclaw-discord-${randomBytes(12).toString("hex")}`;
  headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
  const chunks: Buffer[] = [];
  const push = (value: string | Buffer) => {
    chunks.push(typeof value === "string" ? Buffer.from(value) : value);
  };
  for (const [key, value] of body.entries()) {
    push(`--${boundary}\r\n`);
    const escapedKey = escapeMultipartQuotedValue(key);
    if (typeof value === "string") {
      push(`Content-Disposition: form-data; name="${escapedKey}"\r\n\r\n`);
      push(value);
      push("\r\n");
      continue;
    }
    const filename = (value as Blob & { name?: unknown }).name;
    const escapedFilename = escapeMultipartQuotedValue(
      typeof filename === "string" && filename.length > 0 ? filename : "blob",
    );
    push(`Content-Disposition: form-data; name="${escapedKey}"; filename="${escapedFilename}"\r\n`);
    if (value.type) {
      push(`Content-Type: ${value.type}\r\n`);
    }
    push("\r\n");
    push(Buffer.from(await value.arrayBuffer()));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return Buffer.concat(chunks) as unknown as BodyInit;
}

async function normalizeFetchBody(
  body: BodyInit | undefined,
  headers: Headers,
): Promise<BodyInit | undefined> {
  if (body instanceof FormData) {
    return await formDataToMultipartBody(body, headers);
  }
  return body;
}

export class RequestClient {
  readonly options: RequestClientOptions;
  protected token: string;
  protected customFetch: RequestClientOptions["fetch"];
  protected requestControllers = new Set<AbortController>();
  private scheduler: RestScheduler<RequestData>;

  constructor(token: string, options?: RequestClientOptions) {
    this.token = token.replace(/^Bot\s+/i, "");
    this.customFetch = options?.fetch;
    this.options = { ...defaultOptions, ...options };
    this.scheduler = new RestScheduler<RequestData>(
      {
        lanes: normalizeSchedulerLanes(
          this.options.maxQueueSize ?? defaultOptions.maxQueueSize,
          this.options.scheduler?.lanes,
        ),
        maxConcurrency: this.options.scheduler?.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_WORKERS,
        maxQueueSize: this.options.maxQueueSize ?? defaultOptions.maxQueueSize,
        maxRateLimitRetries: this.options.scheduler?.maxRateLimitRetries ?? 3,
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
    this.requestControllers.add(controller);
    try {
      const response = await (this.customFetch ?? fetch)(url, {
        method,
        headers,
        body: await normalizeFetchBody(body, headers),
        signal: controller.signal,
      });
      const text = await response.text();
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

function normalizeSchedulerLanes(
  maxQueueSize: number,
  lanes?: RequestSchedulerOptions["lanes"],
): Record<RestRequestPriority, { maxQueueSize: number; staleAfterMs?: number; weight: number }> {
  const fallbackMaxQueueSize = Math.max(1, Math.floor(maxQueueSize));
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
  return {
    maxQueueSize:
      options?.maxQueueSize !== undefined
        ? Math.max(1, Math.floor(options.maxQueueSize))
        : maxQueueSize,
    staleAfterMs:
      options?.staleAfterMs !== undefined
        ? Math.max(0, Math.floor(options.staleAfterMs))
        : defaults.staleAfterMs,
    weight:
      options?.weight !== undefined ? Math.max(1, Math.floor(options.weight)) : defaults.weight,
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
