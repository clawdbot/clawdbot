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
import { RestScheduler, type RequestQuery } from "./rest-scheduler.js";
import { isDiscordRateLimitBody } from "./schemas.js";

export { DiscordError, RateLimitError } from "./rest-errors.js";

export type RuntimeProfile = "serverless" | "persistent";
export type RequestPriority = "critical" | "standard" | "background";
export type RequestSchedulerOptions = {
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
        maxConcurrency: this.options.scheduler?.maxConcurrency ?? DEFAULT_MAX_CONCURRENT_WORKERS,
        maxRateLimitRetries: this.options.scheduler?.maxRateLimitRetries ?? 3,
        maxQueueSize: this.options.maxQueueSize ?? defaultOptions.maxQueueSize,
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
    return await this.scheduler.enqueue({ method, path, ...params });
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
        body,
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
