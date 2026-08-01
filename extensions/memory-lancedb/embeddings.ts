import { Buffer } from "node:buffer";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";

type OpenAiEmbeddingClient = {
  post<T>(
    path: string,
    options: { body: unknown; timeout?: number; maxRetries?: number },
  ): Promise<T>;
};
const loadOpenAiModule = createLazyRuntimeModule(() => import("openai"));
const loadMemoryEmbeddingProviderModule = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/memory-core-host-engine-embeddings"),
);
const loadMemoryHostCoreModule = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/memory-host-core"),
);

export type Embeddings = {
  embed(text: string, options?: { timeoutMs?: number }): Promise<number[]>;
  close?(): Promise<void>;
};

type ProviderAdapterLifecycleState = {
  retainedProviders: Set<MemoryEmbeddingProvider>;
  tail: Promise<void>;
};

const PROVIDER_ADAPTER_LIFECYCLE = resolveGlobalSingleton<ProviderAdapterLifecycleState>(
  Symbol.for("openclaw.memoryLanceDbEmbeddingProviderLifecycle.v1"),
  // Plugin reload replaces the service instance. Retain failed closes process-wide so
  // the next instance cannot create a provider before its predecessor retires.
  () => ({ retainedProviders: new Set(), tail: Promise.resolve() }),
);

function runProviderAdapterLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = PROVIDER_ADAPTER_LIFECYCLE.tail.then(operation, operation);
  PROVIDER_ADAPTER_LIFECYCLE.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function drainRetainedProviders(): Promise<void> {
  let firstError: unknown;
  let closeFailed = false;
  for (const provider of PROVIDER_ADAPTER_LIFECYCLE.retainedProviders) {
    try {
      await provider.close?.();
      PROVIDER_ADAPTER_LIFECYCLE.retainedProviders.delete(provider);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw toErrorObject(firstError, "memory-lancedb embedding provider retirement failed");
  }
}

class OpenAiCompatibleEmbeddings implements Embeddings {
  private clientPromise: Promise<OpenAiEmbeddingClient>;

  constructor(
    apiKey: string,
    private model: string,
    baseUrl?: string,
    private dimensions?: number,
  ) {
    this.clientPromise = loadOpenAiModule().then(
      ({ default: OpenAI }) => new OpenAI({ apiKey, baseURL: baseUrl }) as OpenAiEmbeddingClient,
    );
  }

  async embed(text: string, options?: { timeoutMs?: number }): Promise<number[]> {
    const dimensions = this.dimensions;
    const startedAtMs =
      options?.timeoutMs && Number.isFinite(options.timeoutMs) ? Date.now() : null;
    try {
      const response = await this.postEmbedding(text, { includeDimensions: true, options });
      return normalizeEmbeddingVector(response.data?.[0]?.embedding);
    } catch (error) {
      if (typeof dimensions !== "number" || !isEmbeddingDimensionsRejectedError(error)) {
        throw error;
      }
    }

    const fallbackOptions =
      startedAtMs === null || options?.timeoutMs === undefined
        ? options
        : { timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - startedAtMs)) };
    const response = await this.postEmbedding(text, {
      includeDimensions: false,
      options: fallbackOptions,
    });
    const embedding = normalizeEmbeddingVector(response.data?.[0]?.embedding);
    return truncateEmbeddingVector(embedding, dimensions, this.model);
  }

  private async postEmbedding(
    text: string,
    request: {
      includeDimensions: boolean;
      options?: { timeoutMs?: number };
    },
  ): Promise<EmbeddingCreateResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      input: text,
      ...(request.includeDimensions && typeof this.dimensions === "number"
        ? { dimensions: this.dimensions }
        : {}),
    };

    ensureGlobalUndiciEnvProxyDispatcher();
    // The OpenAI SDK's embeddings helper injects encoding_format=base64 when
    // omitted, then decodes the response. Several compatible providers either
    // reject encoding_format or always return float arrays, so use the generic
    // transport and normalize the response ourselves.
    return await (
      await this.clientPromise
    ).post<EmbeddingCreateResponse>("/embeddings", {
      body: params,
      ...(request.options?.timeoutMs ? { timeout: request.options.timeoutMs, maxRetries: 0 } : {}),
    });
  }
}

function isEmbeddingDimensionsRejectedError(error: unknown): boolean {
  const record = asRecord(error);
  if (record?.status !== 400 && record?.status !== 422) {
    return false;
  }
  const details = stringifyEmbeddingApiError(error).toLowerCase();
  return /\bdimensions\b/.test(details) && isUnsupportedEmbeddingFieldError(details);
}

function isUnsupportedEmbeddingFieldError(details: string): boolean {
  if (/\b(?:parameter|field|argument)[_ -]value\b/.test(details)) {
    return false;
  }
  return (
    /\bextra[_ -]forbidden\b/.test(details) ||
    /\bextra inputs? (?:are )?not permitted\b/.test(details) ||
    /\bextra fields? (?:are )?not permitted\b/.test(details) ||
    /\b(?:unknown|unrecognized|unexpected|unsupported)[_ -](?:request[_ -])?(?:parameter|field|argument)\b/.test(
      details,
    )
  );
}

function stringifyEmbeddingApiError(error: unknown): string {
  const record = asRecord(error);
  const parts = error instanceof Error ? [error.message] : [];
  for (const value of [record?.code, record?.type, record?.param, record?.error]) {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      continue;
    }
    if (value && typeof value === "object") {
      try {
        parts.push(JSON.stringify(value));
      } catch {
        // The SDK error message and scalar fields still provide bounded detection.
      }
    }
  }
  return parts.join("\n");
}

function truncateEmbeddingVector(embedding: number[], dimensions: number, model: string): number[] {
  if (embedding.length < dimensions) {
    throw new Error(
      `Embedding model ${model} returned ${embedding.length} dimensions, need at least ${dimensions} for local truncation`,
    );
  }
  const truncated = embedding.slice(0, dimensions);
  // Prefix truncation changes vector magnitude. Re-normalize so LanceDB distance
  // ranking compares fallback query and stored vectors on the same scale.
  const magnitude = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? truncated.map((value) => value / magnitude) : truncated;
}

class ProviderAdapterEmbeddings implements Embeddings {
  private providerPromise: Promise<MemoryEmbeddingProvider> | undefined;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private activeUses = 0;
  private idleWaiters = new Set<() => void>();

  constructor(
    private api: OpenClawPluginApi,
    private embedding: MemoryConfig["embedding"],
  ) {}

  private getProvider(): Promise<MemoryEmbeddingProvider> {
    // Auth profiles and local providers can be repaired while the Gateway stays up.
    // Cache successful setup, but retry after failed provider discovery/auth.
    this.providerPromise ??= this.createProvider().catch((err: unknown) => {
      this.providerPromise = undefined;
      throw err;
    });
    return this.providerPromise;
  }

  private acquireUse(): () => void {
    if (this.closed) {
      throw new Error("memory-lancedb embeddings are closed");
    }
    this.activeUses += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeUses -= 1;
      if (this.activeUses === 0) {
        const waiters = Array.from(this.idleWaiters);
        this.idleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  private async awaitIdle(): Promise<void> {
    if (this.activeUses === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private async createProvider(): Promise<MemoryEmbeddingProvider> {
    return await runProviderAdapterLifecycle(async () => {
      await drainRetainedProviders();
      return await this.createProviderAfterRetirement();
    });
  }

  private async createProviderAfterRetirement(): Promise<MemoryEmbeddingProvider> {
    const cfg = (this.api.runtime.config?.current?.() ?? this.api.config) as OpenClawConfig;
    const providerId = this.embedding.provider;
    const { getMemoryEmbeddingProvider } = await loadMemoryEmbeddingProviderModule();
    const adapter = getMemoryEmbeddingProvider(providerId, cfg);
    if (!adapter) {
      throw new Error(`Unknown memory embedding provider: ${providerId}`);
    }
    const { resolveDefaultAgentId } = await loadMemoryHostCoreModule();
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const agentDir = this.api.runtime.agent.resolveAgentDir(cfg, defaultAgentId);
    const remote =
      this.embedding.apiKey || this.embedding.baseUrl
        ? {
            ...(this.embedding.apiKey ? { apiKey: this.embedding.apiKey } : {}),
            ...(this.embedding.baseUrl ? { baseUrl: this.embedding.baseUrl } : {}),
          }
        : undefined;
    const result = await adapter.create({
      config: cfg,
      agentDir,
      provider: providerId,
      fallback: "none",
      model: this.embedding.model,
      ...(remote ? { remote } : {}),
      ...(typeof this.embedding.dimensions === "number"
        ? { outputDimensionality: this.embedding.dimensions }
        : {}),
    });
    if (!result.provider) {
      throw new Error(`Memory embedding provider ${providerId} is unavailable.`);
    }
    return result.provider;
  }

  async embed(text: string, options?: { timeoutMs?: number }): Promise<number[]> {
    const releaseUse = this.acquireUse();
    try {
      const provider = await this.getProvider();
      if (!options?.timeoutMs) {
        return await provider.embedQuery(text);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        timer = setTimeout(
          () => controller.abort(new Error("memory-lancedb embedding timed out")),
          resolveTimerTimeoutMs(options.timeoutMs, 1),
        );
        timer.unref?.();
        return await provider.embedQuery(text, { signal: controller.signal });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    } finally {
      releaseUse();
    }
  }

  async close(): Promise<void> {
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.closeOnce();
    this.closePromise = closeOperation;
    try {
      await closeOperation;
    } catch (err) {
      if (this.closePromise === closeOperation) {
        this.closePromise = null;
      }
      throw err;
    }
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const providerPromise = this.providerPromise;
    await runProviderAdapterLifecycle(async () => {
      // Close intent is queued before waiting. Replacement instances therefore remain
      // behind this owner while already-admitted embeddings drain to completion.
      await this.awaitIdle();
      const provider = await providerPromise?.catch(() => null);
      if (provider) {
        PROVIDER_ADAPTER_LIFECYCLE.retainedProviders.add(provider);
      }
      try {
        await drainRetainedProviders();
      } finally {
        // Ownership moved to the process-global retained set before draining. Clear the
        // instance even when another retained provider fails, so successful closes stay final.
        if (this.providerPromise === providerPromise) {
          this.providerPromise = undefined;
        }
      }
    });
  }
}

export async function runWithTimeout<T>(params: {
  timeoutMs: number;
  task: () => Promise<T>;
}): Promise<{ status: "ok"; value: T } | { status: "timeout" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT = Symbol("timeout");
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timeout = setTimeout(() => resolve(TIMEOUT), resolveTimerTimeoutMs(params.timeoutMs, 1));
    timeout.unref?.();
  });
  const taskPromise = params.task();
  taskPromise.catch(() => undefined);

  try {
    const result = await Promise.race([taskPromise, timeoutPromise]);
    if (result === TIMEOUT) {
      return { status: "timeout" };
    }
    return { status: "ok", value: result };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function formatMemoryRecallError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMemoryRecallTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
    const record = asRecord(current);
    const name =
      current instanceof Error ? current.name : typeof record?.name === "string" ? record.name : "";
    const message =
      current instanceof Error
        ? current.message
        : typeof record?.message === "string"
          ? record.message
          : "";
    const code = typeof record?.code === "string" ? record.code : "";
    if (
      name === "APIConnectionTimeoutError" ||
      name === "TimeoutError" ||
      code === "ETIMEDOUT" ||
      /^UND_ERR_.*_TIMEOUT$/.test(code) ||
      /\btimed out\b/i.test(message)
    ) {
      return true;
    }
    current = record?.cause;
  }
  return false;
}

export function buildMemoryRecallUnavailableResult(error: string): AgentToolResult<{
  count: number;
  disabled: true;
  unavailable: true;
  error: string;
}> {
  return {
    content: [{ type: "text", text: "Memory recall is unavailable right now." }],
    details: {
      count: 0,
      disabled: true,
      unavailable: true,
      error,
    },
  };
}

export class MemoryRecallEmbeddingError extends Error {
  constructor(readonly originalError: unknown) {
    super(formatMemoryRecallError(originalError));
    this.name = "MemoryRecallEmbeddingError";
  }
}

export const testing = {
  isEmbeddingDimensionsRejectedError,
  isMemoryRecallTimeoutError,
  runWithTimeout,
  truncateEmbeddingVector,
} as const;

export function createEmbeddings(api: OpenClawPluginApi, cfg: MemoryConfig): Embeddings {
  const { provider, model, dimensions, apiKey, baseUrl } = cfg.embedding;
  if (provider === "openai" && apiKey) {
    return new OpenAiCompatibleEmbeddings(apiKey, model, baseUrl, dimensions);
  }
  return new ProviderAdapterEmbeddings(api, cfg.embedding);
}

type EmbeddingCreateResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
};

export function normalizeEmbeddingVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new Error("Embedding response contains non-numeric values");
    }
    return value;
  }

  if (typeof value === "string") {
    const canonicalEmbedding = canonicalizeBase64(value);
    if (!canonicalEmbedding) {
      throw new Error("Base64 embedding response is malformed");
    }
    const bytes = Buffer.from(canonicalEmbedding, "base64");
    if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("Base64 embedding response has invalid byte length");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const floats: number[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
      floats.push(view.getFloat32(offset, true));
    }
    return floats;
  }

  throw new Error("Embedding response is missing a vector");
}
