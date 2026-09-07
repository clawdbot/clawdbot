import { Buffer } from "node:buffer";
import { resolve as resolveFilePath } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult, type AgentToolResult } from "openclaw/plugin-sdk/tool-results";
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

type EmbeddingConfig = MemoryConfig["embedding"];

export type Embeddings = {
  embed(
    agentId: string,
    text: string,
    embedding: EmbeddingConfig,
    timeoutMs?: number,
  ): Promise<number[]>;
  close?(): Promise<void>;
};

type AgentEmbeddingProvider = {
  config: OpenClawConfig;
  agentDir: string;
  promise: Promise<MemoryEmbeddingProvider>;
  activeUses: number;
  idleResolver?: () => void;
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

function embeddingConfigFingerprint(embedding: EmbeddingConfig): string {
  const { provider, model, apiKey, baseUrl, dimensions } = embedding;
  return JSON.stringify([provider, model, apiKey, baseUrl, dimensions]);
}

class OpenAiCompatibleEmbeddings {
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
  const record = asOptionalRecord(error);
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
  const record = asOptionalRecord(error);
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
  private providers = new Map<string, AgentEmbeddingProvider>();
  private embeddingFingerprint: string | undefined;
  private unregisterAuthMutationListener: (() => void) | undefined;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private api: OpenClawPluginApi) {}

  private getProvider(agentId: string, embedding: EmbeddingConfig): AgentEmbeddingProvider {
    const config = (this.api.runtime.config?.current?.() ?? this.api.config) as OpenClawConfig;
    const agentDir = this.api.runtime.agent.resolveAgentDir(config, agentId);
    const existing = this.providers.get(agentId);
    if (existing?.config === config && existing.agentDir === agentDir) {
      return existing;
    }
    if (existing) {
      this.providers.delete(agentId);
      void this.retireProviders([existing]).catch(() => undefined);
    }

    const entry: AgentEmbeddingProvider = {
      config,
      agentDir,
      promise: this.createProvider(config, agentDir, embedding).catch((err: unknown) => {
        // Failed auth must not poison this agent or any other agent's provider cache.
        if (this.providers.get(agentId) === entry) {
          this.providers.delete(agentId);
        }
        throw err;
      }),
      activeUses: 0,
    };
    this.providers.set(agentId, entry);
    return entry;
  }

  invalidate(fingerprint?: string): void {
    if (this.embeddingFingerprint === fingerprint) {
      return;
    }
    this.embeddingFingerprint = fingerprint;
    this.retireMatchingProviders(() => true);
  }

  private retireMatchingProviders(predicate: (entry: AgentEmbeddingProvider) => boolean): void {
    const entries: AgentEmbeddingProvider[] = [];
    for (const [agentId, entry] of this.providers) {
      if (predicate(entry)) {
        this.providers.delete(agentId);
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      return;
    }
    // The next provider create/close retries process-global retained ownership.
    void this.retireProviders(entries).catch(() => undefined);
  }

  private invalidateProvidersForAuthMutation(event: {
    agentDir?: string;
    affectsInheritedStores: boolean;
  }): void {
    const changedAgentDir = event.agentDir ? resolveFilePath(event.agentDir) : undefined;
    this.retireMatchingProviders(
      (entry) =>
        event.affectsInheritedStores || resolveFilePath(entry.agentDir) === changedAgentDir,
    );
  }

  private async retireProviders(entries: AgentEmbeddingProvider[]): Promise<void> {
    await runProviderAdapterLifecycle(async () => {
      for (const entry of entries) {
        // Admission records the entry lease before embed() first yields, so this
        // covers invalidation, pending creation, and explicit service close.
        if (entry.activeUses > 0) {
          await new Promise<void>((resolve) => {
            entry.idleResolver = resolve;
          });
        }
        const provider = await entry.promise.catch(() => null);
        if (provider) {
          PROVIDER_ADAPTER_LIFECYCLE.retainedProviders.add(provider);
        }
      }
      await drainRetainedProviders();
    });
  }

  private async createProvider(
    config: OpenClawConfig,
    agentDir: string,
    embedding: EmbeddingConfig,
  ): Promise<MemoryEmbeddingProvider> {
    return await runProviderAdapterLifecycle(async () => {
      await drainRetainedProviders();
      return await this.createProviderAfterRetirement(config, agentDir, embedding);
    });
  }

  private async createProviderAfterRetirement(
    config: OpenClawConfig,
    agentDir: string,
    embedding: EmbeddingConfig,
  ): Promise<MemoryEmbeddingProvider> {
    const providerId = embedding.provider;
    const { getMemoryEmbeddingProvider, registerRuntimeAuthProfileStoreMutationListener } =
      await loadMemoryEmbeddingProviderModule();
    if (!this.closed && !this.unregisterAuthMutationListener) {
      // Auth profiles can rotate without replacing config. Observe their owner
      // publication edge so cached clients never outlive the selected account.
      this.unregisterAuthMutationListener = registerRuntimeAuthProfileStoreMutationListener(
        (event) => this.invalidateProvidersForAuthMutation(event),
      );
    }
    const adapter = getMemoryEmbeddingProvider(providerId, config);
    if (!adapter) {
      throw new Error(`Unknown memory embedding provider: ${providerId}`);
    }
    const remote =
      embedding.apiKey || embedding.baseUrl
        ? {
            ...(embedding.apiKey ? { apiKey: embedding.apiKey } : {}),
            ...(embedding.baseUrl ? { baseUrl: embedding.baseUrl } : {}),
          }
        : undefined;
    const result = await adapter.create({
      config,
      agentDir,
      provider: providerId,
      fallback: "none",
      model: embedding.model,
      ...(remote ? { remote } : {}),
      ...(typeof embedding.dimensions === "number" ? { dimensions: embedding.dimensions } : {}),
    });
    if (!result.provider) {
      throw new Error(`Memory embedding provider ${providerId} is unavailable.`);
    }
    return result.provider;
  }

  async embed(
    agentId: string,
    text: string,
    embeddingConfig: EmbeddingConfig,
    timeoutMs?: number,
  ): Promise<number[]> {
    if (this.closed) {
      throw new Error("memory-lancedb embeddings are closed");
    }
    const embedding = { ...embeddingConfig };
    const fingerprint = embeddingConfigFingerprint(embedding);
    this.invalidate(fingerprint);
    const entry = this.getProvider(normalizeAgentId(agentId), embedding);
    entry.activeUses += 1;
    try {
      const provider = await entry.promise;
      if (!timeoutMs) {
        return await provider.embed(text, { inputType: "query" });
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        timer = setTimeout(
          () => controller.abort(new Error("memory-lancedb embedding timed out")),
          resolveTimerTimeoutMs(timeoutMs, 1),
        );
        timer.unref?.();
        return await provider.embed(text, { signal: controller.signal, inputType: "query" });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    } finally {
      entry.activeUses -= 1;
      if (entry.activeUses === 0) {
        // Map removal gives each entry exactly one retirement waiter.
        const resolveIdle = entry.idleResolver;
        entry.idleResolver = undefined;
        resolveIdle?.();
      }
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
    this.unregisterAuthMutationListener?.();
    this.unregisterAuthMutationListener = undefined;
    const providers = Array.from(this.providers.values());
    this.providers.clear();
    // Queue close intent before waiting so replacement instances remain behind
    // every admitted entry and pending provider creation owned by this service.
    await this.retireProviders(providers);
  }
}

export async function runWithTimeout<T>(params: {
  timeoutMs: number;
  task: (deadlineAtMs: number) => Promise<T>;
}): Promise<{ status: "ok"; value: T } | { status: "timeout" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT = Symbol("timeout");
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  // Share one absolute deadline with native work so the outer race cannot
  // abandon a still-running operation after reporting a timeout.
  const deadlineAtMs = Date.now() + timeoutMs;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timeout = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timeout.unref?.();
  });
  const taskPromise = params.task(deadlineAtMs);
  taskPromise.catch(() => undefined);

  try {
    const result = await Promise.race([taskPromise, timeoutPromise]);
    if (result === TIMEOUT || Date.now() >= deadlineAtMs) {
      return { status: "timeout" };
    }
    return { status: "ok", value: result };
  } catch (error) {
    if (Date.now() >= deadlineAtMs) {
      return { status: "timeout" };
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function isMemoryRecallTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
    const record = asOptionalRecord(current);
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
  return textResult("Memory recall is unavailable right now.", {
    count: 0,
    disabled: true,
    unavailable: true,
    error,
  });
}

export class MemoryRecallEmbeddingError extends Error {
  constructor(readonly originalError: unknown) {
    super(formatErrorMessage(originalError));
    this.name = "MemoryRecallEmbeddingError";
  }
}

export function createEmbeddings(api: OpenClawPluginApi): Embeddings {
  const provider = new ProviderAdapterEmbeddings(api);
  let direct: { fingerprint: string; client: OpenAiCompatibleEmbeddings } | undefined;
  let closed = false;
  return {
    async embed(agentId, text, embeddingConfig, timeoutMs) {
      if (closed) {
        throw new Error("memory-lancedb embeddings are closed");
      }
      const embedding = { ...embeddingConfig };
      if (embedding.provider === "openai" && embedding.apiKey) {
        provider.invalidate();
        const fingerprint = embeddingConfigFingerprint(embedding);
        direct =
          direct?.fingerprint === fingerprint
            ? direct
            : {
                fingerprint,
                client: new OpenAiCompatibleEmbeddings(
                  embedding.apiKey,
                  embedding.model,
                  embedding.baseUrl,
                  embedding.dimensions,
                ),
              };
        return await direct.client.embed(text, timeoutMs ? { timeoutMs } : undefined);
      }
      direct = undefined;
      return await provider.embed(agentId, text, embedding, timeoutMs);
    },
    async close() {
      closed = true;
      direct = undefined;
      await provider.close();
    },
  };
}

type EmbeddingCreateResponse = {
  data?: Array<{
    embedding?: unknown;
  }>;
};

export function normalizeEmbeddingVector(value: unknown): number[] {
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
    return normalizeEmbeddingVector(floats);
  }

  if (!Array.isArray(value)) {
    throw new Error("Embedding response is missing a vector");
  }
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("Embedding response contains non-numeric values");
  }
  return value;
}
