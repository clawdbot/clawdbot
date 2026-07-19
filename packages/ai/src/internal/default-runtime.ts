import type { Api, StreamOptions } from "@openclaw/llm-core";
// Process-default registry/runtime retained for the OpenClaw compatibility
// facade (src/llm). Deliberately not part of the public package API: external
// consumers create isolated runtimes via createLlmRuntime(); exporting these
// from the root barrel would reintroduce the mutable process-global registry.
import {
  createApiRegistry,
  type ApiProvider,
  type ApiRegistry,
  type RegisteredApiProvider,
} from "../api-registry.js";
import { createLlmRuntime, type LlmRuntime } from "../stream.js";

type DefaultRuntimeState = {
  registry: ApiRegistry;
  runtime: LlmRuntime;
  publishedRegistry: ApiRegistry;
};

const DEFAULT_RUNTIME_KEY = Symbol.for("openclaw.ai.defaultRuntime");

function resolveDefaultRuntime(): DefaultRuntimeState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.hasOwn(globalStore, DEFAULT_RUNTIME_KEY)) {
    const existing = globalStore[DEFAULT_RUNTIME_KEY] as Omit<
      DefaultRuntimeState,
      "publishedRegistry"
    > &
      Partial<Pick<DefaultRuntimeState, "publishedRegistry">>;
    // Keep the legacy facade registry intact. Its entries are opaque, so only
    // registrations made through this host version enter lifecycle snapshots.
    existing.publishedRegistry ??= createApiRegistry();
    return existing as DefaultRuntimeState;
  }
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const state = { registry, runtime, publishedRegistry: createApiRegistry() };
  globalStore[DEFAULT_RUNTIME_KEY] = state;
  return state;
}

const defaultRuntime = resolveDefaultRuntime();

export const defaultApiRegistry = defaultRuntime.registry;
export const defaultLlmRuntime = defaultRuntime.runtime;

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  sourceId?: string,
): void {
  defaultApiRegistry.registerApiProvider(provider, sourceId);
  defaultRuntime.publishedRegistry.registerApiProvider(provider, sourceId);
}

export const { getApiProvider, getApiProviders } = defaultApiRegistry;

/** Returns only explicit compatibility registrations, excluding request-generated aliases. */
export function getPublishedApiProviders(): RegisteredApiProvider[] {
  return defaultRuntime.publishedRegistry.getApiProviders();
}

export function unregisterApiProviders(sourceId: string): void {
  defaultApiRegistry.unregisterApiProviders(sourceId);
  defaultRuntime.publishedRegistry.unregisterApiProviders(sourceId);
}

export function clearApiProviders(): void {
  defaultApiRegistry.clearApiProviders();
  defaultRuntime.publishedRegistry.clearApiProviders();
}

export const { stream, complete, streamSimple, completeSimple } = defaultLlmRuntime;
