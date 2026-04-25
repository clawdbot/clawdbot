import {
  DiscordError,
  RateLimitError,
  RequestClient,
  type DiscordRawError,
  type RequestData,
  type RequestClientOptions,
} from "@buape/carbon";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import { FormData as UndiciFormData } from "undici";

export type ProxyRequestClientOptions = RequestClientOptions & {
  fetch?: typeof fetch;
};

type QueuedRequest = {
  method: string;
  path: string;
  data?: RequestData;
  query?: Record<string, string | number | boolean>;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  routeKey: string;
};

type MultipartFile = {
  data: unknown;
  name: string;
  description?: string;
};

type Attachment = {
  id: number;
  filename: string;
  description?: string;
};

const defaultOptions = {
  tokenHeader: "Bot",
  baseUrl: "https://discord.com/api",
  apiVersion: 10,
  userAgent: "DiscordBot (https://github.com/buape/carbon, v0.0.0)",
  timeout: 15_000,
  queueRequests: true,
  maxQueueSize: 1000,
  runtimeProfile: "persistent",
  scheduler: {},
} satisfies Omit<ProxyRequestClientOptions, "fetch"> & {
  runtimeProfile: string;
  scheduler: object;
};

function getMultipartFiles(payload: unknown): MultipartFile[] {
  if (!isRecord(payload)) {
    return [];
  }
  const directFiles = payload.files;
  if (Array.isArray(directFiles)) {
    return directFiles as MultipartFile[];
  }
  const nestedData = payload.data;
  if (!isRecord(nestedData)) {
    return [];
  }
  const nestedFiles = nestedData.files;
  return Array.isArray(nestedFiles) ? (nestedFiles as MultipartFile[]) : [];
}

function isMultipartPayload(payload: unknown): payload is Record<string, unknown> {
  return getMultipartFiles(payload).length > 0;
}

function toRateLimitBody(parsedBody: unknown, rawBody: string, headers: Headers) {
  if (isRecord(parsedBody)) {
    const message = typeof parsedBody.message === "string" ? parsedBody.message : undefined;
    const retryAfter =
      typeof parsedBody.retry_after === "number" ? parsedBody.retry_after : undefined;
    const global = typeof parsedBody.global === "boolean" ? parsedBody.global : undefined;
    if (message !== undefined && retryAfter !== undefined && global !== undefined) {
      return {
        message,
        retry_after: retryAfter,
        global,
      };
    }
  }
  const retryAfterHeader = headers.get("Retry-After");
  return {
    message: typeof parsedBody === "string" ? parsedBody : rawBody || "You are being rate limited.",
    retry_after:
      retryAfterHeader && !Number.isNaN(Number(retryAfterHeader)) ? Number(retryAfterHeader) : 1,
    global: headers.get("X-RateLimit-Scope") === "global",
  };
}

type RateLimitBody = ReturnType<typeof toRateLimitBody>;

function createRateLimitErrorCompat(
  response: Response,
  body: RateLimitBody,
  request: Request,
): RateLimitError {
  const RateLimitErrorCtor = RateLimitError as unknown as {
    new (response: Response, body: RateLimitBody, request?: Request): RateLimitError;
  };
  return new RateLimitErrorCtor(response, body, request);
}

function toDiscordErrorBody(parsedBody: unknown, rawBody: string): DiscordRawError {
  if (isRecord(parsedBody) && typeof parsedBody.message === "string") {
    return parsedBody as DiscordRawError;
  }
  return {
    message: typeof parsedBody === "string" ? parsedBody : rawBody || "Discord request failed",
  };
}

function toBlobPart(value: unknown): BlobPart {
  if (value instanceof ArrayBuffer || typeof value === "string") {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const copied = new Uint8Array(value.byteLength);
    copied.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copied;
  }
  if (value instanceof Blob) {
    return value;
  }
  return String(value);
}

// Carbon 0.14 removed the custom fetch seam from RequestClientOptions.
// Keep a local proxy-aware clone so Discord proxy config still works on OpenClaw.
class ProxyRequestClientCompat {
  readonly options: ProxyRequestClientOptions;
  readonly customFetch?: typeof fetch;
  protected queue: QueuedRequest[] = [];
  private readonly token: string;
  private abortController: AbortController | null = null;
  private processingQueue = false;
  private readonly routeBuckets = new Map<string, string>();
  private readonly bucketStates = new Map<string, number>();
  private globalRateLimitUntil = 0;

  constructor(token: string, options?: ProxyRequestClientOptions) {
    this.token = token;
    this.options = {
      ...defaultOptions,
      ...options,
    };
    this.customFetch = options?.fetch;
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

  clearQueue(): void {
    this.queue.length = 0;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  abortAllRequests(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async request(
    method: string,
    path: string,
    params: Pick<QueuedRequest, "data" | "query">,
  ): Promise<unknown> {
    const routeKey = this.getRouteKey(method, path);
    if (this.options.queueRequests) {
      if (
        typeof this.options.maxQueueSize === "number" &&
        this.options.maxQueueSize > 0 &&
        this.queue.length >= this.options.maxQueueSize
      ) {
        const stats = this.queue.reduce(
          (acc, item) => {
            const count = (acc.counts.get(item.routeKey) ?? 0) + 1;
            acc.counts.set(item.routeKey, count);
            if (count > acc.topCount) {
              acc.topCount = count;
              acc.topRoute = item.routeKey;
            }
            return acc;
          },
          {
            counts: new Map([[routeKey, 1]]),
            topRoute: routeKey,
            topCount: 1,
          },
        );
        throw new Error(
          `Request queue is full (${this.queue.length} / ${this.options.maxQueueSize}), you should implement a queuing system in your requests or raise the queue size in Carbon. Top offender: ${stats.topRoute}`,
        );
      }
      return await new Promise((resolve, reject) => {
        this.queue.push({
          method,
          path,
          data: params.data,
          query: params.query,
          resolve,
          reject,
          routeKey,
        });
        void this.processQueue();
      });
    }
    return await new Promise((resolve, reject) => {
      void this.executeRequest({
        method,
        path,
        data: params.data,
        query: params.query,
        resolve,
        reject,
        routeKey,
      })
        .then(resolve)
        .catch(reject);
    });
  }

  private async executeRequest(request: QueuedRequest): Promise<unknown> {
    const { method, path, data, query, routeKey } = request;
    await this.waitForBucket(routeKey);

    const queryString = query
      ? `?${Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("&")}`
      : "";
    const url = `${this.options.baseUrl}${path}${queryString}`;
    const originalRequest = new Request(url, { method });
    const headers =
      this.token === "webhook"
        ? new Headers()
        : new Headers({
            Authorization: `${this.options.tokenHeader} ${this.token}`,
          });

    if (data?.headers) {
      for (const [key, value] of Object.entries(data.headers)) {
        headers.set(key, value);
      }
    }

    this.abortController = new AbortController();
    const timeoutMs =
      typeof this.options.timeout === "number" && this.options.timeout > 0
        ? this.options.timeout
        : undefined;

    let body: BodyInit | undefined;
    if (data?.body && isMultipartPayload(data.body)) {
      const payload = data.body;
      const normalizedBody: Record<string, unknown> & { attachments: Attachment[] } =
        typeof payload === "string"
          ? { content: payload, attachments: [] }
          : { ...payload, attachments: [] };
      const formData = new UndiciFormData();
      const files = getMultipartFiles(payload);

      for (const [index, file] of files.entries()) {
        const normalizedFileData =
          file.data instanceof Blob ? file.data : new Blob([toBlobPart(file.data)]);
        formData.append(`files[${index}]`, normalizedFileData, file.name);
        normalizedBody.attachments.push({
          id: index,
          filename: file.name,
          description: file.description,
        });
      }

      const cleanedBody = {
        ...normalizedBody,
        files: undefined,
      };
      formData.append("payload_json", JSON.stringify(cleanedBody));
      body = formData as unknown as BodyInit;
    } else if (data?.body != null) {
      headers.set("Content-Type", "application/json");
      body = data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        this.abortController?.abort();
      }, timeoutMs);
    }

    let response: Response;
    try {
      response = await (this.customFetch ?? globalThis.fetch)(url, {
        method,
        headers,
        body,
        signal: this.abortController.signal,
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    let rawBody = "";
    let parsedBody: unknown;
    try {
      rawBody = await response.text();
    } catch {
      rawBody = "";
    }

    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = undefined;
      }
    }

    if (response.status === 429) {
      const rateLimitBody = toRateLimitBody(parsedBody, rawBody, response.headers);
      const rateLimitError = createRateLimitErrorCompat(response, rateLimitBody, originalRequest);
      this.scheduleRateLimit(
        routeKey,
        rateLimitError.retryAfter,
        rateLimitError.scope === "global",
      );
      throw rateLimitError;
    }

    this.updateBucketFromHeaders(routeKey, response.headers);

    if (!response.ok) {
      throw new DiscordError(response, toDiscordErrorBody(parsedBody, rawBody));
    }

    return parsedBody ?? rawBody;
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) {
      return;
    }
    this.processingQueue = true;
    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift();
        if (!request) {
          continue;
        }
        try {
          const result = await this.executeRequest(request);
          request.resolve(result);
        } catch (error) {
          if (error instanceof RateLimitError && this.options.queueRequests) {
            this.queue.unshift(request);
            continue;
          }
          request.reject(error);
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async waitForBucket(routeKey: string): Promise<void> {
    while (true) {
      const now = Date.now();
      if (this.globalRateLimitUntil > now) {
        await new Promise((resolve) => setTimeout(resolve, this.globalRateLimitUntil - now));
        continue;
      }

      const bucketKey = this.routeBuckets.get(routeKey);
      const bucketUntil = bucketKey ? (this.bucketStates.get(bucketKey) ?? 0) : 0;
      if (bucketUntil > now) {
        await new Promise((resolve) => setTimeout(resolve, bucketUntil - now));
        continue;
      }
      return;
    }
  }

  private scheduleRateLimit(routeKey: string, retryAfterSeconds: number, global: boolean): void {
    const resetAt = Date.now() + Math.ceil(retryAfterSeconds * 1000);
    if (global) {
      this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, resetAt);
      return;
    }
    const bucketKey = this.routeBuckets.get(routeKey) ?? routeKey;
    this.routeBuckets.set(routeKey, bucketKey);
    this.bucketStates.set(bucketKey, Math.max(this.bucketStates.get(bucketKey) ?? 0, resetAt));
  }

  private updateBucketFromHeaders(routeKey: string, headers: Headers): void {
    const bucket = headers.get("X-RateLimit-Bucket");
    const retryAfter = headers.get("X-RateLimit-Reset-After");
    const remaining = headers.get("X-RateLimit-Remaining");
    const resetAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const remainingRequests = remaining ? Number(remaining) : Number.NaN;

    if (!bucket) {
      return;
    }

    this.routeBuckets.set(routeKey, bucket);
    if (!Number.isFinite(resetAfterSeconds) || !Number.isFinite(remainingRequests)) {
      if (!this.bucketStates.has(bucket)) {
        this.bucketStates.set(bucket, 0);
      }
      return;
    }

    if (remainingRequests <= 0) {
      this.bucketStates.set(bucket, Date.now() + Math.ceil(resetAfterSeconds * 1000));
      return;
    }
    this.bucketStates.set(bucket, 0);
  }

  private getMajorParameter(path: string): string | null {
    const guildMatch = path.match(/^\/guilds\/(\d+)/);
    if (guildMatch?.[1]) {
      return guildMatch[1];
    }
    const channelMatch = path.match(/^\/channels\/(\d+)/);
    if (channelMatch?.[1]) {
      return channelMatch[1];
    }
    const webhookMatch = path.match(/^\/webhooks\/(\d+)(?:\/([^/]+))?/);
    if (webhookMatch) {
      const [, id, token] = webhookMatch;
      return token ? `${id}/${token}` : (id ?? null);
    }
    return null;
  }

  private getRouteKey(method: string, path: string): string {
    return `${method.toUpperCase()}:${this.getBucketKey(path)}`;
  }

  private getBucketKey(path: string): string {
    const majorParameter = this.getMajorParameter(path);
    const normalizedPath = path
      .replace(/\?.*$/, "")
      .replace(/\/\d{17,20}(?=\/|$)/g, "/:id")
      .replace(/\/reactions\/[^/]+/g, "/reactions/:reaction");

    return majorParameter ? `${normalizedPath}:${majorParameter}` : normalizedPath;
  }
}

export function createDiscordRequestClient(
  token: string,
  options?: ProxyRequestClientOptions,
): RequestClient {
  if (!options?.fetch) {
    return new RequestClient(token, options);
  }
  return new ProxyRequestClientCompat(token, options) as unknown as RequestClient;
}
