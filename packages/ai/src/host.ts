// Host policy ports for the reusable transport package. Fetch guarding,
// secret redaction, strict-tool policy, and diagnostics logging are owned by
// the embedding application (OpenClaw core installs its implementations via
// configureAiTransportHost); the library defaults below are inert so external
// consumers get safe, dependency-free behavior without wiring anything.
import type { Api, Context, Model, StreamFn } from "@openclaw/llm-core";
import type { ApiRegistry } from "./api-registry.js";
import { transformMessages } from "./transcript-transform.js";

/** Provider capability facts needed by the package-owned transports. */
export interface AiProviderRequestCapabilities {
  endpointClass: string;
  knownProviderFamily: string;
  supportsNativeStreamingUsageCompat: boolean;
  supportsOpenAICompletionsStreamingUsageCompat: boolean;
  usesExplicitProxyLikeEndpoint: boolean;
  allowsAnthropicServiceTier: boolean;
}

export type AiBeforeFetchDispatch = (params: { url: string; init: RequestInit }) => void;

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

export type AiInlineTextBlock = { type: "text"; text: string };
export type AiInlineImageBlock = { type: "image"; data: string; mimeType: string };
export type AiInlineContentBlock = AiInlineTextBlock | AiInlineImageBlock;
type AnthropicInlineContentNormalizer = (
  content: readonly AiInlineContentBlock[],
) => Promise<AiInlineContentBlock[]>;

export const AI_MODEL_TRANSPORT_OUTCOMES = ["completed", "failed", "aborted"] as const;
export const AI_MODEL_TRANSPORT_ATTEMPT_REASONS = [
  "initial",
  "retry",
  "auth_recovery",
  "payload_recovery",
  "transport_fallback",
] as const;
export const AI_MODEL_TRANSPORT_CONNECTION_REASONS = ["initial", "prewarm", "reconnect"] as const;
export const AI_MODEL_TRANSPORT_FALLBACK_REASONS = [
  "unsupported",
  "connection_failure",
  "submission_failure",
  "stream_failure",
  "policy",
] as const;
export const AI_MODEL_ZERO_SUBMISSION_OUTCOMES = ["failed", "aborted"] as const;
export const AI_MODEL_ZERO_SUBMISSION_REASONS = [
  "failed_before_submission",
  "aborted_before_submission",
] as const;

export type AiModelTransportOutcome = (typeof AI_MODEL_TRANSPORT_OUTCOMES)[number];
export type AiModelTransportAttemptReason = (typeof AI_MODEL_TRANSPORT_ATTEMPT_REASONS)[number];
export type AiModelTransportConnectionReason =
  (typeof AI_MODEL_TRANSPORT_CONNECTION_REASONS)[number];
export type AiModelTransportFallbackReason = (typeof AI_MODEL_TRANSPORT_FALLBACK_REASONS)[number];
export type AiModelZeroSubmissionOutcome = (typeof AI_MODEL_ZERO_SUBMISSION_OUTCOMES)[number];
export type AiModelZeroSubmissionReason = (typeof AI_MODEL_ZERO_SUBMISSION_REASONS)[number];
export type AiModelFetchProvenance = "dispatch_attested";
export type AiModelFetchResult = {
  fetch: typeof fetch;
  provenance: AiModelFetchProvenance;
};

export type AiModelFetchOptions = {
  sanitizeSse?: boolean;
  /**
   * Observes each admitted fetch invocation and its endpoint after synchronous
   * preflight. This does not attest byte-level network egress.
   */
  observeFetchDispatch?: AiBeforeFetchDispatch;
  /**
   * Observes each fetch invocation admitted past synchronous preflight. It
   * receives no request material and does not attest byte-level network egress.
   */
  onFetchInvocation?: () => void;
  /**
   * Legacy once-per-attempt callback after the first admitted fetch invocation.
   * New hosts should prefer `onFetchInvocation` for per-invocation accounting.
   */
  onFetchDispatch?: () => void;
};

export type AiBlockingModelFetchOptions = AiModelFetchOptions & {
  /** Blocks each network invocation after SSRF/DNS preflight and before fetch. */
  beforeFetchDispatch: AiBeforeFetchDispatch;
};

export type AiModelWebSocketEventType = "message" | "error" | "close";
export type AiModelWebSocketListener = (event: unknown) => void;

/** Host-attested callback-send WebSocket surface kept independent of Node dependencies. */
export interface AiModelWebSocket {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  addEventListener(type: AiModelWebSocketEventType, listener: AiModelWebSocketListener): void;
  removeEventListener(type: AiModelWebSocketEventType, listener: AiModelWebSocketListener): void;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

export type AiModelWebSocketResource = {
  socket: AiModelWebSocket;
  /** Upgrade response headers observed by the host, including an authoritative absence. */
  handshakeHeaders: Record<string, string | readonly string[] | undefined>;
  /** Idempotently closes the socket and releases all host-owned connection resources. */
  dispose(): void;
};

export type AiModelWebSocketConnectOptions = {
  url: string;
  headers: Record<string, string>;
  /** Cancels connection establishment; an opened resource lives until `dispose()`. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

type AiModelTransportEventBase = {
  /** Stable identity for de-duplicating one emitted transport fact. */
  eventId: string;
  provider: string;
  model: string;
  api: string;
};

type AiModelTransportCallEventBase = AiModelTransportEventBase & {
  /** Model-call requestId used only for correlation, never session affinity. */
  callId: string;
};

/**
 * Provider transport facts for one model call.
 *
 * An attempt is one provider-request lifecycle. An invocation is one admitted
 * fetch or WebSocket write within that attempt; it does not claim byte-level
 * network egress. Connection setup and run-scoped prewarm never count as
 * attempts. A transport fallback remains pending until a matching
 * `transport_fallback` attempt or zero-submission phase consumes it. Retries stay
 * on the current transport. Zero-submission facts describe one route phase that
 * ended before the invocation boundary, including a pending fallback target after
 * earlier failed attempts. Server-side provider fallback records an in-request
 * serving model transition without changing the requested provider, model, API,
 * or active transport.
 */
export type AiModelTransportEvent =
  | (AiModelTransportCallEventBase & {
      /** One transport invocation admitted past synchronous preflight. */
      type: "invocation";
      transport: string;
      ordinal: number;
      attemptOrdinal: number;
      hopOrdinal: number;
      reason: AiModelTransportAttemptReason;
    })
  | (AiModelTransportCallEventBase & {
      type: "attempt";
      transport: string;
      ordinal: number;
      reason: AiModelTransportAttemptReason;
      outcome: AiModelTransportOutcome;
      statusCode?: number;
      durationMs?: number;
    })
  | (AiModelTransportCallEventBase & {
      type: "connection";
      transport: string;
      ordinal: number;
      reason: Exclude<AiModelTransportConnectionReason, "prewarm">;
      outcome: AiModelTransportOutcome;
      statusCode?: number;
      durationMs?: number;
    })
  | (AiModelTransportEventBase & {
      type: "connection";
      transport: string;
      ordinal: number;
      reason: "prewarm";
      outcome: AiModelTransportOutcome;
      statusCode?: number;
      durationMs?: number;
    })
  | (AiModelTransportCallEventBase & {
      type: "fallback";
      fromTransport: string;
      toTransport: string;
      reason: AiModelTransportFallbackReason;
    })
  | (AiModelTransportCallEventBase & {
      type: "provider_fallback";
      transport: string;
      fromModel: string;
      toModel: string;
    })
  | (AiModelTransportCallEventBase & {
      /** Scoped uncertainty that changes no transport aggregate. */
      type: "coverage";
      scope: "provider_fallbacks";
      state: "lower_bound";
      reason: "terminal_metadata_unavailable";
      transport: string;
    })
  | (AiModelTransportCallEventBase & {
      /** Semantic or dispatch uncertainty scoped to one transport. */
      type: "coverage";
      scope: "transport_semantics";
      state: "unverified";
      reason:
        | "transport_terminal_unverified"
        | "transport_endpoint_authority_partial"
        | "transport_submission_authority_partial";
      transport: string;
    })
  | (AiModelTransportCallEventBase & {
      type: "submission";
      transport: string;
      total: 0;
      outcome: AiModelZeroSubmissionOutcome;
      reason: AiModelZeroSubmissionReason;
    });

/** Narrow host ports consumed by the built-in provider adapters. */
export interface AiTransportHost {
  /**
   * Builds a policy-guarded fetch for one model request.
   * Returning undefined keeps the provider SDK's default fetch.
   */
  buildModelFetch(
    model: Model,
    timeoutMs?: number,
    options?: AiModelFetchOptions,
  ): typeof fetch | undefined;
  /**
   * Builds a policy-guarded fetch and attests that invocation callbacks run at
   * their documented application boundary. The legacy method name does not
   * claim byte-level network egress.
   */
  buildModelFetchWithDispatchAttestation?(
    model: Model,
    timeoutMs: number | undefined,
    options: AiModelFetchOptions,
  ): AiModelFetchResult | undefined;
  /**
   * Builds a fetch whose blocking callback is guaranteed to run immediately
   * before every network invocation. Missing support must fail closed.
   */
  buildModelFetchWithBlockingDispatchGuard?(
    model: Model,
    timeoutMs: number | undefined,
    options: AiBlockingModelFetchOptions,
  ): AiModelFetchResult | undefined;
  /**
   * Opens one policy-guarded model WebSocket. A returned resource attests
   * upgrade-header observation and callback-based send admission.
   */
  connectModelWebSocket?(
    model: Model,
    options: AiModelWebSocketConnectOptions,
  ): Promise<AiModelWebSocketResource | undefined>;
  /** Resolves host-owned process-local secret sentinel substrings immediately before egress. */
  resolveSecretSentinel(value: string): string;
  /** Redacts secrets inside structured tool-result payloads. */
  redactSecrets<T>(value: T): T;
  /** Redacts secret-bearing text in tool payload strings. */
  redactToolPayloadText(text: string): string;
  /** Normalizes Anthropic inline image blocks before provider payload construction. */
  normalizeAnthropicInlineContentBlocks?: AnthropicInlineContentNormalizer;
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
  /** Emits one provider transport fact to the embedding host's active run collector. */
  observeModelTransportEvent?(event: AiModelTransportEvent): void;
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

type ActiveAiTransportHost = Omit<
  AiTransportHost,
  "normalizeAnthropicInlineContentBlocks" | "observeModelTransportEvent"
> & {
  normalizeAnthropicInlineContentBlocks: AnthropicInlineContentNormalizer;
  observeModelTransportEvent: NonNullable<AiTransportHost["observeModelTransportEvent"]>;
};

const inertAiTransportHost: ActiveAiTransportHost = {
  buildModelFetch: () => undefined,
  resolveSecretSentinel: (value) => value,
  redactSecrets: (value) => value,
  redactToolPayloadText: (text) => text,
  normalizeAnthropicInlineContentBlocks: async (content) => [...content],
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
  transformTransportMessages: (messages, model, normalizeToolCallId) =>
    transformMessages(messages, model, normalizeToolCallId),
  registerCustomApi: queueCustomApiRegistration,
  prepareGoogleSimpleCompletionModel: (_registry, model) => model,
  observeModelTransportEvent: () => {},
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
};

let activeAiTransportHost: ActiveAiTransportHost = inertAiTransportHost;

/** Installs host implementations for the transport policy ports. */
export function configureAiTransportHost(host: Partial<AiTransportHost>): void {
  activeAiTransportHost = {
    ...inertAiTransportHost,
    ...host,
    normalizeAnthropicInlineContentBlocks:
      host.normalizeAnthropicInlineContentBlocks ??
      inertAiTransportHost.normalizeAnthropicInlineContentBlocks,
    observeModelTransportEvent:
      host.observeModelTransportEvent ?? inertAiTransportHost.observeModelTransportEvent,
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
export function getAiTransportHost(): ActiveAiTransportHost {
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
