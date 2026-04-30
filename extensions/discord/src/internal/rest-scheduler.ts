import { readRetryAfter } from "./rest-errors.js";
import { createBucketKey, createRouteKey, readHeaderNumber, readResetAt } from "./rest-routes.js";

export type RequestQuery = Record<string, string | number | boolean>;
export type ScheduledRequest<TData> = {
  method: string;
  path: string;
  data?: TData;
  query?: RequestQuery;
  routeKey: string;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
};

type BucketState<TData> = {
  active: number;
  bucket?: string;
  invalidRequests: number;
  limit?: number;
  pending: Array<ScheduledRequest<TData>>;
  rateLimitHits: number;
  remaining?: number;
  resetAt: number;
  routeKeys: Set<string>;
};

export type RestSchedulerOptions = {
  maxConcurrency: number;
  maxQueueSize: number;
};

const INVALID_REQUEST_WINDOW_MS = 10 * 60_000;

export class RestScheduler<TData> {
  private activeWorkers = 0;
  private buckets = new Map<string, BucketState<TData>>();
  private drainTimer: NodeJS.Timeout | undefined;
  private globalRateLimitUntil = 0;
  private invalidRequestTimestamps: Array<{ at: number; status: number }> = [];
  private queuedRequests = 0;
  private routeBuckets = new Map<string, string>();

  constructor(
    private readonly options: RestSchedulerOptions,
    private readonly executor: (request: ScheduledRequest<TData>) => Promise<unknown>,
  ) {}

  enqueue(params: {
    method: string;
    path: string;
    data?: TData;
    query?: RequestQuery;
  }): Promise<unknown> {
    if (this.queuedRequests >= this.options.maxQueueSize) {
      throw new Error("Discord request queue is full");
    }
    const routeKey = createRouteKey(params.method, params.path);
    const bucket = this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
    return new Promise((resolve, reject) => {
      this.queuedRequests += 1;
      bucket.pending.push({ ...params, routeKey, resolve, reject });
      this.drainQueues();
    });
  }

  recordResponse(routeKey: string, path: string, response: Response, parsed: unknown): void {
    this.updateRateLimitState(routeKey, path, response, parsed);
    this.recordInvalidRequest(routeKey, path, response);
  }

  clearQueue(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.rejectPending(new Error("Discord request queue cleared"));
  }

  abortPending(): void {
    this.rejectPending(new DOMException("Aborted", "AbortError"));
  }

  get queueSize(): number {
    return this.queuedRequests;
  }

  getMetrics() {
    this.pruneInvalidRequests();
    return {
      globalRateLimitUntil: this.globalRateLimitUntil,
      activeBuckets: this.buckets.size,
      routeBucketMappings: this.routeBuckets.size,
      buckets: Array.from(this.buckets.entries()).map(([key, bucket]) => ({
        key,
        active: bucket.active,
        bucket: bucket.bucket,
        invalidRequests: bucket.invalidRequests,
        pending: bucket.pending.length,
        rateLimitHits: bucket.rateLimitHits,
        remaining: bucket.remaining,
        resetAt: bucket.resetAt,
        routeKeyCount: bucket.routeKeys.size,
      })),
      invalidRequestCount: this.invalidRequestTimestamps.length,
      invalidRequestCountByStatus: this.invalidRequestTimestamps.reduce<Record<number, number>>(
        (counts, entry) => {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      queueSize: this.queueSize,
      activeWorkers: this.activeWorkers,
      maxConcurrentWorkers: this.maxConcurrentWorkers,
    };
  }

  private get maxConcurrentWorkers(): number {
    return Math.max(1, Math.floor(this.options.maxConcurrency));
  }

  private getBucket(key: string): BucketState<TData> {
    const existing = this.buckets.get(key);
    if (existing) {
      return existing;
    }
    const bucket: BucketState<TData> = {
      active: 0,
      invalidRequests: 0,
      pending: [],
      rateLimitHits: 0,
      resetAt: 0,
      routeKeys: new Set([key]),
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private hasBucketReference(key: string): boolean {
    for (const bucketKey of this.routeBuckets.values()) {
      if (bucketKey === key) {
        return true;
      }
    }
    return false;
  }

  private isBucketRateLimited(bucket: BucketState<TData>, now = Date.now()): boolean {
    return bucket.remaining === 0 && bucket.resetAt > now;
  }

  private pruneRouteMapping(routeKey: string): void {
    const bucketKey = this.routeBuckets.get(routeKey);
    if (!bucketKey) {
      return;
    }
    this.routeBuckets.delete(routeKey);
    this.buckets.get(bucketKey)?.routeKeys.delete(routeKey);
  }

  private pruneIdleRouteMappings(
    bucketKey: string,
    bucket: BucketState<TData>,
    now = Date.now(),
  ): void {
    if (bucket.active > 0 || bucket.pending.length > 0 || this.isBucketRateLimited(bucket, now)) {
      return;
    }
    for (const routeKey of Array.from(bucket.routeKeys)) {
      if (this.routeBuckets.get(routeKey) === bucketKey) {
        this.pruneRouteMapping(routeKey);
      }
    }
  }

  private shouldPruneIdleBucket(key: string): boolean {
    const mappedBucketKey = this.routeBuckets.get(key);
    return mappedBucketKey !== key && !this.hasBucketReference(key);
  }

  private bindRouteToBucket(routeKey: string, bucketKey: string): BucketState<TData> {
    const target = this.getBucket(bucketKey);
    target.routeKeys.add(routeKey);
    this.routeBuckets.set(routeKey, bucketKey);
    const routeBucket = this.buckets.get(routeKey);
    if (routeBucket && routeBucket !== target) {
      target.pending.push(...routeBucket.pending);
      routeBucket.pending = [];
      if (routeBucket.active === 0) {
        this.buckets.delete(routeKey);
      }
    }
    return target;
  }

  private updateRateLimitState(
    routeKey: string,
    path: string,
    response: Response,
    parsed: unknown,
  ): void {
    const bucketHeader = response.headers.get("X-RateLimit-Bucket");
    const bucket = bucketHeader
      ? this.bindRouteToBucket(routeKey, createBucketKey(bucketHeader, path))
      : this.getBucket(this.routeBuckets.get(routeKey) ?? routeKey);
    bucket.bucket = bucketHeader ?? bucket.bucket;
    const limit = readHeaderNumber(response.headers, "X-RateLimit-Limit");
    if (limit !== undefined) {
      bucket.limit = limit;
    }
    const remaining = readHeaderNumber(response.headers, "X-RateLimit-Remaining");
    if (remaining !== undefined) {
      bucket.remaining = remaining;
    }
    const resetAt = readResetAt(response);
    if (resetAt !== undefined) {
      bucket.resetAt = resetAt;
    }
    if (response.status !== 429) {
      return;
    }
    bucket.rateLimitHits += 1;
    const retryAfterMs = Math.max(0, readRetryAfter(parsed, response) * 1000);
    const retryAt = Date.now() + retryAfterMs;
    if (response.headers.get("X-RateLimit-Global") === "true" || isGlobalRateLimit(parsed)) {
      this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, retryAt);
      return;
    }
    bucket.remaining = 0;
    bucket.resetAt = Math.max(bucket.resetAt, retryAt);
  }

  private recordInvalidRequest(routeKey: string, path: string, response: Response): void {
    if (response.status !== 401 && response.status !== 403 && response.status !== 429) {
      return;
    }
    if (response.status === 429 && response.headers.get("X-RateLimit-Scope") === "shared") {
      return;
    }
    const now = Date.now();
    this.invalidRequestTimestamps.push({ at: now, status: response.status });
    this.pruneInvalidRequests(now);
    const bucketHeader = response.headers.get("X-RateLimit-Bucket");
    const bucketKey = bucketHeader
      ? createBucketKey(bucketHeader, path)
      : (this.routeBuckets.get(routeKey) ?? routeKey);
    const bucket = this.buckets.get(bucketKey);
    if (bucket) {
      bucket.invalidRequests += 1;
    }
  }

  private pruneInvalidRequests(now = Date.now()): void {
    const cutoff = now - INVALID_REQUEST_WINDOW_MS;
    while (
      this.invalidRequestTimestamps.length > 0 &&
      (this.invalidRequestTimestamps[0]?.at ?? 0) <= cutoff
    ) {
      this.invalidRequestTimestamps.shift();
    }
  }

  private getBucketWaitMs(bucket: BucketState<TData>, now: number): number {
    if (bucket.remaining === 0 && bucket.resetAt > now) {
      return bucket.resetAt - now;
    }
    if (bucket.remaining === 0 && bucket.resetAt <= now) {
      bucket.remaining = bucket.limit;
    }
    return 0;
  }

  private scheduleDrain(delayMs = 0): void {
    if (this.drainTimer) {
      return;
    }
    this.drainTimer = setTimeout(
      () => {
        this.drainTimer = undefined;
        this.drainQueues();
      },
      Math.max(0, delayMs),
    );
    this.drainTimer.unref?.();
  }

  private drainQueues(): void {
    const now = Date.now();
    if (this.globalRateLimitUntil > now) {
      this.scheduleDrain(this.globalRateLimitUntil - now);
      return;
    }
    let nextDelayMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (this.activeWorkers >= this.maxConcurrentWorkers) {
        break;
      }
      if (bucket.pending.length === 0) {
        if (bucket.active !== 0) {
          continue;
        }
        if (this.isBucketRateLimited(bucket, now)) {
          nextDelayMs = Math.min(nextDelayMs, bucket.resetAt - now);
          continue;
        }
        this.pruneIdleRouteMappings(key, bucket, now);
        if (this.shouldPruneIdleBucket(key)) {
          this.buckets.delete(key);
        }
        continue;
      }
      if (bucket.active > 0) {
        continue;
      }
      const waitMs = this.getBucketWaitMs(bucket, now);
      if (waitMs > 0) {
        nextDelayMs = Math.min(nextDelayMs, waitMs);
        continue;
      }
      const queued = bucket.pending.shift();
      if (!queued) {
        continue;
      }
      if (bucket.remaining !== undefined && bucket.remaining > 0) {
        bucket.remaining -= 1;
      }
      bucket.active += 1;
      this.activeWorkers += 1;
      void this.runQueuedRequest(queued, bucket);
    }
    if (Number.isFinite(nextDelayMs)) {
      this.scheduleDrain(nextDelayMs);
    }
  }

  private async runQueuedRequest(
    queued: ScheduledRequest<TData>,
    bucket: BucketState<TData>,
  ): Promise<void> {
    try {
      queued.resolve(await this.executor(queued));
    } catch (error) {
      queued.reject(error);
    } finally {
      bucket.active = Math.max(0, bucket.active - 1);
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      if (bucket.active === 0 && bucket.pending.length === 0) {
        for (const routeKey of bucket.routeKeys) {
          if (this.routeBuckets.get(routeKey) === routeKey) {
            this.routeBuckets.delete(routeKey);
          }
        }
      }
      this.drainQueues();
    }
  }

  private rejectPending(error: Error | DOMException): void {
    for (const bucket of this.buckets.values()) {
      for (const queued of bucket.pending.splice(0)) {
        queued.reject(error);
        this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      }
    }
  }
}

function isGlobalRateLimit(parsed: unknown): boolean {
  return parsed && typeof parsed === "object" && "global" in parsed
    ? Boolean((parsed as { global?: unknown }).global)
    : false;
}
