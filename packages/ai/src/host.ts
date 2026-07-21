// Host policy ports for the reusable transport package. Fetch guarding,
// secret redaction, strict-tool policy, and diagnostics logging are owned by
// the embedding application (OpenClaw core installs its implementations via
// configureAiTransportHost); the library defaults below are inert so external
// consumers get safe, dependency-free behavior without wiring anything.
import type { Api, Context, Model, StreamFn } from "@openclaw/llm-core";
import type { ApiRegistry } from "./api-registry.js";

/** Provider capability facts needed by the package-owned transports. */
export interface AiProviderRequestCapabilities {
  endpointClass: string;
  knownProviderFamily: string;
  supportsNativeStreamingUsageCompat: boolean;
  supportsOpenAICompletionsStreamingUsageCompat: boolean;
  usesExplicitProxyLikeEndpoint: boolean;
  allowsAnthropicServiceTier: boolean;
}

/** Transport-safe provider policy input kept independent of OpenClaw config types. */
export interface AiProviderRequestPolicyInput {
  provider?: string;
  api?: string;
  baseUrl?: string;
  capability?: "llm" | "audio" | "image" | "video" | "other";
  transport?: "stream" | "websocket" | "http" | "media-understanding";
  modelId?: string | null;
  compat?: unknown;
}

/** Context shared by plugin-owned provider stream hooks. */
export interface AiProviderStreamHookContext {
  config?: unknown;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: Model;
}

/** Narrow plugin-runtime port used by package-owned transports. */
export interface AiTransportPluginHost {
  resolveProviderStream(
    this: void,
    params: {
      provider: string;
      config?: unknown;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
      allowRuntimePluginLoad?: boolean;
      context: AiProviderStreamHookContext;
    },
  ): StreamFn | undefined;
  resolveTransportTurnState(
    this: void,
    params: {
      provider: string;
      modelId?: string | null;
      config?: unknown;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
      allowRuntimePluginLoad?: boolean;
      context: {
        provider: string;
        modelId: string;
        model?: Model;
        sessionId?: string;
        turnId: string;
        attempt: number;
        transport: "stream" | "websocket";
      };
    },
  ): { headers?: Record<string, string>; metadata?: Record<string, string> } | undefined;
  wrapSimpleCompletionStream(
    this: void,
    params: {
      provider: string;
      config?: unknown;
      context: AiProviderStreamHookContext & { streamFn: StreamFn };
    },
  ): StreamFn | undefined;
  createAnthropicVertexStream(
    this: void,
    model: Pick<Model, "baseUrl">,
    env?: NodeJS.ProcessEnv,
  ): StreamFn;
}

/** Host-owned transcript normalization contract used immediately before provider projection. */
export type AiTransformTransportMessages = (
  messages: Context["messages"],
  model: Model,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model,
    source: { provider: string; api: Api; model: string },
  ) => string,
  options?: {
    normalizeSameModelToolCallIds?: boolean;
    preserveCrossModelToolCallThoughtSignature?: boolean;
  },
) => Context["messages"];

/** Strict-tool policy inputs for OpenAI-compatible routes. */
export interface OpenAIStrictToolSettingOptions {
  transport?: "stream" | "websocket";
  supportsStrictMode?: boolean;
}

/** Narrow host ports consumed by the built-in provider adapters. */
export interface AiTransportHost {
  /**
   * Builds a policy-guarded fetch for one model request.
   * Returning undefined keeps the provider SDK's default fetch.
   */
  buildModelFetch(
    model: Model,
    timeoutMs?: number,
    options?: { sanitizeSse?: boolean },
  ): typeof fetch | undefined;
  /** Resolves host-owned process-local secret sentinel substrings immediately before egress. */
  resolveSecretSentinel(value: string): string;
  /** Redacts secrets inside structured tool-result payloads. */
  redactSecrets<T>(value: T): T;
  /** Redacts secret-bearing text in tool payload strings. */
  redactToolPayloadText(text: string): string;
  /**
   * Resolves the host strict-tool default for OpenAI-compatible routes.
   * undefined lets the request omit the strict flag entirely.
   */
  resolveOpenAIStrictToolSetting(
    model: Pick<Model, "provider" | "api" | "baseUrl" | "id"> & { compat?: unknown },
    options?: OpenAIStrictToolSettingOptions,
  ): boolean | undefined;
  /** Provider-plugin operations required by the generic package transports. */
  plugin: AiTransportPluginHost;
  /** Builds provider-owned Copilot compatibility headers for one message turn. */
  buildCopilotDynamicHeaders(messages: Context["messages"]): Record<string, string>;
  /** Resolves endpoint classification without importing core provider registries. */
  resolveProviderEndpointClass(baseUrl?: string): string;
  /** Resolves provider capability flags used by payload compatibility policy. */
  resolveProviderRequestCapabilities(
    input: AiProviderRequestPolicyInput,
  ): AiProviderRequestCapabilities;
  /** Merges host-owned provider request headers and attribution policy. */
  resolveProviderRequestHeaders(input: {
    provider?: string;
    api?: string;
    baseUrl?: string;
    providerHeaders?: Record<string, string>;
    callerHeaders?: Record<string, string>;
    precedence?: "caller-wins" | "defaults-win";
  }): Record<string, string> | undefined;
  /** Returns the host-configured request timeout attached to a model. */
  resolveModelRequestTimeoutMs(model: Model): number | undefined;
  /** Reports whether the model carries host-managed proxy, TLS, or local-service state. */
  requiresManagedTransport(model: Model): boolean;
  /** Copies host-owned managed-transport state onto a projected model. */
  inheritManagedTransport(source: Model, target: Model): Model;
  /** Applies host-owned transcript replay and pairing rules. */
  transformTransportMessages: AiTransformTransportMessages;
  /** Registers a custom transport API with the host's stream error bridge. */
  registerCustomApi(registry: ApiRegistry, api: Api, streamFn: StreamFn): boolean;
  /** Prepares the provider-owned Google simple-completion alias when needed. */
  prepareGoogleSimpleCompletionModel(registry: ApiRegistry, model: Model): Model;
  /**
   * Emits one transport diagnostic; build runs only when the host logs it and
   * may return null to suppress the entry (e.g. de-duplication).
   */
  logDebug(
    subsystem: string,
    build: () => { message: string; data?: Record<string, unknown> } | null,
  ): void;
  /** Emits an informational transport diagnostic through the host logger. */
  logInfo(subsystem: string, message: string, data?: Record<string, unknown>): void;
  /** Emits a warning through the host logger. */
  logWarn(subsystem: string, message: string, data?: Record<string, unknown>): void;
}

const MAX_PENDING_CUSTOM_API_REGISTRATIONS = 32;

type PendingCustomApiRegistration = {
  registry: ApiRegistry;
  api: Api;
  streamFn: StreamFn;
};

const pendingCustomApiRegistrations: PendingCustomApiRegistration[] = [];

function queueCustomApiRegistration(registry: ApiRegistry, api: Api, streamFn: StreamFn): boolean {
  const existing = pendingCustomApiRegistrations.find(
    (registration) => registration.registry === registry && registration.api === api,
  );
  if (existing) {
    existing.streamFn = streamFn;
    return false;
  }
  if (pendingCustomApiRegistrations.length >= MAX_PENDING_CUSTOM_API_REGISTRATIONS) {
    throw new Error("Too many custom transport APIs were registered before host configuration");
  }
  pendingCustomApiRegistrations.push({ registry, api, streamFn });
  return false;
}

const inertAiTransportHost: AiTransportHost = {
  buildModelFetch: () => undefined,
  resolveSecretSentinel: (value) => value,
  redactSecrets: (value) => value,
  redactToolPayloadText: (text) => text,
  resolveOpenAIStrictToolSetting: (_model, options) =>
    options?.supportsStrictMode ? false : undefined,
  plugin: {
    resolveProviderStream: () => undefined,
    resolveTransportTurnState: () => undefined,
    wrapSimpleCompletionStream: () => undefined,
    createAnthropicVertexStream: () => {
      throw new Error("Anthropic Vertex transport is not configured by the embedding host");
    },
  },
  buildCopilotDynamicHeaders: () => ({}),
  resolveProviderEndpointClass: () => "default",
  resolveProviderRequestCapabilities: () => ({
    endpointClass: "default",
    knownProviderFamily: "",
    supportsNativeStreamingUsageCompat: false,
    supportsOpenAICompletionsStreamingUsageCompat: false,
    usesExplicitProxyLikeEndpoint: false,
    allowsAnthropicServiceTier: false,
  }),
  resolveProviderRequestHeaders: ({ providerHeaders, callerHeaders, precedence }) => ({
    ...(precedence === "caller-wins" ? providerHeaders : callerHeaders),
    ...(precedence === "caller-wins" ? callerHeaders : providerHeaders),
  }),
  resolveModelRequestTimeoutMs: () => undefined,
  requiresManagedTransport: () => false,
  inheritManagedTransport: (_source, target) => target,
  transformTransportMessages: (messages) => messages,
  registerCustomApi: queueCustomApiRegistration,
  prepareGoogleSimpleCompletionModel: (_registry, model) => model,
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
};

let activeAiTransportHost = inertAiTransportHost;

/** Installs host implementations for the transport policy ports. */
export function configureAiTransportHost(host: Partial<AiTransportHost>): void {
  activeAiTransportHost = {
    ...inertAiTransportHost,
    ...host,
    plugin: { ...inertAiTransportHost.plugin, ...host.plugin },
  };
  const transportHost = activeAiTransportHost;
  if (
    transportHost.registerCustomApi === inertAiTransportHost.registerCustomApi ||
    pendingCustomApiRegistrations.length === 0
  ) {
    return;
  }

  // Transport modules may register before host wiring. Drain once after a concrete
  // registrar installs so module caching cannot permanently lose those registrations.
  const pending = pendingCustomApiRegistrations.splice(0);
  for (const [index, registration] of pending.entries()) {
    try {
      transportHost.registerCustomApi(
        registration.registry,
        registration.api,
        registration.streamFn,
      );
    } catch (error) {
      pendingCustomApiRegistrations.unshift(...pending.slice(index));
      throw error;
    }
  }
}

/** Returns the active transport host (inert defaults unless configured). */
export function getAiTransportHost(): AiTransportHost {
  return activeAiTransportHost;
}

/** Resolves sentinel substrings in custom headers at a no-fetch adapter boundary. */
export function resolveAiTransportHeaderSentinels(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const host = getAiTransportHost();
  let resolvedHeaders: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const resolved = host.resolveSecretSentinel(value);
    if (resolved !== value) {
      resolvedHeaders ??= { ...headers };
      resolvedHeaders[name] = resolved;
    }
  }
  return resolvedHeaders ?? headers;
}
