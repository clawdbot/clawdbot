import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ExtensionFactory, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Command } from "commander";
import type {
  ApiKeyCredential,
  AuthProfileCredential,
  OAuthCredential,
  AuthProfileStore,
} from "../agents/auth-profiles/types.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { FailoverReason } from "../agents/pi-embedded-helpers/types.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import type { PromptMode } from "../agents/system-prompt.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";
import type { MediaUnderstandingProvider } from "../media-understanding/types.js";
import type { MusicGenerationProvider } from "../music-generation/types.js";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderId,
  RealtimeVoiceProviderResolveConfigContext,
} from "../realtime-voice/provider-types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfiguredContext,
  SpeechProviderConfig,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechListVoicesRequest,
  SpeechProviderId,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechTelephonySynthesisRequest,
  SpeechTelephonySynthesisResult,
  SpeechVoiceOption,
} from "../tts/provider-types.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
  CliBackendPlugin,
  CliBundleMcpMode,
  PluginTextReplacement,
  PluginTextTransforms,
} from "./cli-backend.types.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingResolutionDecision,
} from "./conversation-binding.types.js";
import type { PluginHookHandlerMap, PluginHookName } from "./hook-types.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
} from "./manifest-types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { SecretInputMode } from "./provider-auth-types.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type {
  ProviderExternalAuthProfile,
  ProviderExternalOAuthProfile,
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveExternalOAuthProfilesContext,
  ProviderResolveSyntheticAuthContext,
  ProviderSyntheticAuthResult,
} from "./provider-external-auth.types.js";
import type { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
import type { WebFetchProviderPlugin, WebSearchProviderPlugin } from "./web-provider-types.js";

export type { PluginRuntime } from "./runtime/types.js";
export type { PluginOrigin } from "./plugin-origin.types.js";
export type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
} from "./manifest-types.js";
export type {
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type { AgentHarness } from "../agents/harness/types.js";
export type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingResolutionDecision,
} from "./conversation-binding.types.js";
export type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
  CliBackendPlugin,
  CliBundleMcpMode,
  PluginTextReplacement,
  PluginTextTransforms,
} from "./cli-backend.types.js";
export * from "./hook-types.js";

export type ProviderAuthOptionBag = {
  token?: string;
  tokenProvider?: string;
  secretInputMode?: SecretInputMode;
  [key: string]: unknown;
};

/** Logger passed into plugin registration, services, and CLI surfaces. */
export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type { PluginKind } from "./plugin-kind.types.js";
export type {
  ProviderExternalAuthProfile,
  ProviderExternalOAuthProfile,
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveExternalOAuthProfilesContext,
  ProviderResolveSyntheticAuthContext,
  ProviderSyntheticAuthResult,
} from "./provider-external-auth.types.js";
export type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebFetchProviderContext,
  WebFetchProviderId,
  WebFetchProviderPlugin,
  WebFetchProviderToolDefinition,
  WebFetchRuntimeMetadataContext,
  WebSearchCredentialResolutionSource,
  WebSearchProviderContext,
  WebSearchProviderId,
  WebSearchProviderPlugin,
  WebSearchProviderSetupContext,
  WebSearchProviderToolDefinition,
  WebSearchRuntimeMetadataContext,
} from "./web-provider-types.js";
export type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";

export type PluginConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };

/**
 * Config schema contract accepted by plugin manifests and runtime registration.
 *
 * Plugins can provide a Zod-like parser, a lightweight `validate(...)`
 * function, or both. `uiHints` and `jsonSchema` are optional extras for docs,
 * forms, and config UIs.
 */
export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: JsonSchemaObject;
};

export type ProviderAuthKind = "oauth" | "api_key" | "token" | "device_code" | "custom";

/** Standard result payload returned by provider auth methods. */
export type ProviderAuthResult = {
  profiles: Array<{ profileId: string; credential: AuthProfileCredential }>;
  /**
   * Optional config patch to merge after credentials are written.
   *
   * Use this for provider-owned onboarding defaults such as
   * `models.providers.<id>` entries, default aliases, or agent model helpers.
   * The caller still persists auth-profile bindings separately.
   */
  configPatch?: Partial<OpenClawConfig>;
  defaultModel?: string;
  notes?: string[];
  /**
   * Opt in to replace `agents.defaults.models` wholesale with the patch map.
   * Default behavior merges the map so other providers' entries survive.
   * Set only from migrations that intentionally rename/remove model keys.
   */
  replaceDefaultModels?: boolean;
};

/** Interactive auth context passed to provider login/setup methods. */
export type ProviderAuthContext = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  /**
   * Optional onboarding CLI options that triggered this auth flow.
   *
   * Present for setup/configure/auth-choice flows so provider methods can
   * honor preseeded flags like `--openai-api-key` or generic
   * `--token/--token-provider` pairs. Direct `models auth login` usually
   * leaves this undefined.
   */
  opts?: ProviderAuthOptionBag;
  /**
   * Onboarding secret persistence preference.
   *
   * Interactive wizard flows set this when the caller explicitly requested
   * plaintext or env/file/exec ref storage. Ad-hoc `models auth login` flows
   * usually leave it undefined.
   */
  secretInputMode?: SecretInputMode;
  /**
   * Whether the provider auth flow should offer the onboarding secret-storage
   * mode picker when `secretInputMode` is unset.
   *
   * This is true for onboarding/configure flows and false for direct
   * `models auth` commands, which should keep a tighter, provider-owned prompt
   * surface.
   */
  allowSecretRefPrompt?: boolean;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  oauth: {
    createVpsAwareHandlers: typeof createVpsAwareOAuthHandlers;
  };
};

export type ProviderNonInteractiveApiKeyResult = {
  key: string;
  source: "profile" | "env" | "flag";
  envVarName?: string;
};

export type ProviderResolveNonInteractiveApiKeyParams = {
  provider: string;
  flagValue?: string;
  flagName: `--${string}`;
  envVar: string;
  envVarName?: string;
  allowProfile?: boolean;
  required?: boolean;
};

export type ProviderNonInteractiveApiKeyCredentialParams = {
  provider: string;
  resolved: ProviderNonInteractiveApiKeyResult;
  email?: string;
  metadata?: Record<string, string>;
};

export type ProviderAuthMethodNonInteractiveContext = {
  authChoice: string;
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: ProviderAuthOptionBag;
  runtime: RuntimeEnv;
  agentDir?: string;
  workspaceDir?: string;
  resolveApiKey: (
    params: ProviderResolveNonInteractiveApiKeyParams,
  ) => Promise<ProviderNonInteractiveApiKeyResult | null>;
  toApiKeyCredential: (
    params: ProviderNonInteractiveApiKeyCredentialParams,
  ) => ApiKeyCredential | null;
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  hint?: string;
  kind: ProviderAuthKind;
  /**
   * Optional wizard/onboarding metadata for this specific auth method.
   *
   * Use this when one provider exposes multiple setup entries (for example API
   * key + OAuth, or region-specific login flows). OpenClaw uses this to expose
   * method-specific auth choices while keeping the provider id stable.
   */
  wizard?: ProviderPluginWizardSetup;
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
  runNonInteractive?: (
    ctx: ProviderAuthMethodNonInteractiveContext,
  ) => Promise<OpenClawConfig | null>;
};

export type ProviderCatalogOrder = "simple" | "profile" | "paired" | "late";

export type ProviderCatalogContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (
    providerId?: string,
    options?: {
      oauthMarker?: string;
    },
  ) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
};

export type ProviderCatalogResult =
  | { provider: ModelProviderConfig }
  | { providers: Record<string, ModelProviderConfig> }
  | null
  | undefined;

export type ProviderPluginCatalog = {
  order?: ProviderCatalogOrder;
  run: (ctx: ProviderCatalogContext) => Promise<ProviderCatalogResult>;
};

export type ProviderRuntimeProviderConfig = {
  baseUrl?: string;
  api?: ModelProviderConfig["api"];
  models?: ModelProviderConfig["models"];
  headers?: unknown;
};

/**
 * Sync hook for provider-owned model ids that are not present in the local
 * registry/catalog yet.
 *
 * Use this for pass-through providers or provider-specific forward-compat
 * behavior. The hook should be cheap and side-effect free; async refreshes
 * belong in `prepareDynamicModel`.
 */
export type ProviderResolveDynamicModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  providerConfig?: ProviderRuntimeProviderConfig;
};

/**
 * Optional async warm-up for dynamic model resolution.
 *
 * Called only from async model resolution paths, before retrying
 * `resolveDynamicModel`. This is the place to refresh caches or fetch provider
 * metadata over the network.
 */
export type ProviderPrepareDynamicModelContext = ProviderResolveDynamicModelContext;

export type ProviderPreferRuntimeResolvedModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
};

/**
 * Last-chance rewrite hook for provider-owned transport normalization.
 *
 * Runs after OpenClaw resolves an explicit/discovered/dynamic model and before
 * the embedded runner uses it. Typical uses: swap API ids, fix base URLs, or
 * patch provider-specific compat bits.
 */
export type ProviderNormalizeResolvedModelContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

/**
 * Provider-owned model-id normalization before config/runtime lookup.
 *
 * Use this for provider-specific alias cleanup that should stay with the
 * plugin rather than in core string tables.
 */
export type ProviderNormalizeModelIdContext = {
  provider: string;
  modelId: string;
};

export type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";

/**
 * Provider-owned transport normalization for arbitrary provider/model config.
 *
 * Use this when transport cleanup depends on API/baseUrl rather than the
 * owning provider id, for example custom providers that still target a
 * plugin-owned transport family.
 */
export type ProviderNormalizeTransportContext = {
  provider: string;
  api?: string | null;
  baseUrl?: string;
};

/**
 * Runtime auth input for providers that need an extra exchange step before
 * inference. The incoming `apiKey` is the raw credential resolved from auth
 * profiles/env/config. The returned value should be the actual token/key to use
 * for the request.
 */
export type ProviderPrepareRuntimeAuthContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
  apiKey: string;
  authMode: string;
  profileId?: string;
};

/**
 * Result of `prepareRuntimeAuth`.
 *
 * `apiKey` is required and becomes the runtime credential stored in auth
 * storage. `baseUrl` is optional and lets providers like GitHub Copilot swap to
 * an entitlement-specific endpoint at request time. `expiresAt` enables generic
 * background refresh in long-running turns.
 */
export type ProviderPreparedRuntimeAuth = {
  apiKey: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};

/**
 * Usage/billing auth input for providers that expose quota/usage endpoints.
 *
 * This hook is intentionally separate from `prepareRuntimeAuth`: usage
 * snapshots often need a different credential source than live inference
 * requests, and they run outside the embedded runner.
 *
 * The helper methods cover the common OpenClaw auth resolution paths:
 *
 * - `resolveApiKeyFromConfigAndStore`: env/config/plain token/api_key profiles
 * - `resolveOAuthToken`: oauth/token profiles resolved through the auth store,
 *   optionally for an explicit provider override
 *
 * Plugins can still do extra provider-specific work on top (for example parse a
 * token blob, read a legacy credential file, or pick between aliases).
 */
export type ProviderResolveUsageAuthContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  resolveApiKeyFromConfigAndStore: (params?: {
    providerIds?: string[];
    envDirect?: Array<string | undefined>;
  }) => string | undefined;
  resolveOAuthToken: (params?: { provider?: string }) => Promise<ProviderResolvedUsageAuth | null>;
};

/**
 * Result of `resolveUsageAuth`.
 *
 * `token` is the credential used for provider usage/billing endpoints.
 * `accountId` is optional provider-specific metadata used by some usage APIs.
 */
export type ProviderResolvedUsageAuth = {
  token: string;
  accountId?: string;
};

/**
 * Usage/quota snapshot input for providers that own their usage endpoint
 * fetch/parsing behavior.
 *
 * This hook runs after `resolveUsageAuth` succeeds. Core still owns summary
 * fan-out, timeout wrapping, filtering, and formatting; the provider plugin
 * owns the provider-specific HTTP request + response normalization.
 */
export type ProviderFetchUsageSnapshotContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  token: string;
  accountId?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
};

/**
 * Provider-owned auth-doctor hint input.
 *
 * Called when OAuth refresh fails and OpenClaw wants a provider-specific repair
 * hint to append to the generic re-auth message. Use this for legacy profile-id
 * migrations or other provider-owned auth-store cleanup guidance.
 */
export type ProviderAuthDoctorHintContext = {
  config?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
};

/**
 * Provider-owned extra-param normalization before OpenClaw builds its generic
 * stream option wrapper.
 *
 * Use this to set provider defaults or rewrite provider-specific config keys
 * into the merged `extraParams` object. Return the full next extraParams object.
 */
export type ProviderPrepareExtraParamsContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  extraParams?: Record<string, unknown>;
  thinkingLevel?: ThinkLevel;
};

export type ProviderExtraParamsForTransportContext = Omit<
  ProviderPrepareExtraParamsContext,
  "extraParams"
> & {
  model?: ProviderRuntimeModel;
  transport?: "sse" | "websocket" | "auto";
  extraParams: Record<string, unknown>;
};

export type ProviderExtraParamsForTransportResult = {
  patch?: Record<string, unknown> | null;
};

export type ProviderResolvePromptOverlayContext = ProviderSystemPromptContributionContext & {
  baseOverlay?: ProviderSystemPromptContribution;
};

export type ProviderFollowupFallbackRouteContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  payload: ReplyPayload;
  originatingChannel?: string;
  originatingTo?: string;
  originRoutable: boolean;
  dispatcherAvailable: boolean;
};

export type ProviderFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};

export type ProviderResolveAuthProfileIdContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  preferredProfileId?: string;
  lockedProfileId?: string;
  profileOrder: string[];
  authStore: AuthProfileStore;
};

export type ProviderReplaySanitizeMode = "full" | "images-only";

export type ProviderReplayToolCallIdMode = "strict" | "strict9";

export type ProviderReasoningOutputMode = "native" | "tagged";

/**
 * @deprecated Legacy static provider capability bag.
 *
 * Core replay/runtime ownership now lives on explicit provider hooks such as
 * `buildReplayPolicy`, `normalizeToolSchemas`, and `wrapStreamFn`. OpenClaw no
 * longer reads this bag at runtime, but the field remains typed so existing
 * third-party plugins do not fail to compile immediately.
 */
export type ProviderCapabilities = Record<string, unknown>;

/**
 * Provider-owned replay/compaction transcript policy.
 *
 * These values are consumed by shared history replay and compaction logic.
 * Return only the fields the provider wants to override; core fills the rest
 * with its default policy.
 */
export type ProviderReplayPolicy = {
  sanitizeMode?: ProviderReplaySanitizeMode;
  sanitizeToolCallIds?: boolean;
  toolCallIdMode?: ProviderReplayToolCallIdMode;
  preserveNativeAnthropicToolUseIds?: boolean;
  preserveSignatures?: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  dropThinkingBlocks?: boolean;
  repairToolUseResultPairing?: boolean;
  applyAssistantFirstOrderingFix?: boolean;
  validateGeminiTurns?: boolean;
  validateAnthropicTurns?: boolean;
  allowSyntheticToolResults?: boolean;
};

/**
 * Provider-owned replay/compaction policy input.
 *
 * Use this when transcript replay rules depend on provider/model transport
 * behavior and should stay with the provider plugin instead of core tables.
 */
export type ProviderReplayPolicyContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
};

export type ProviderReplaySessionEntry = {
  customType: string;
  data?: unknown;
};

export type ProviderReplaySessionState = {
  getCustomEntries(): ProviderReplaySessionEntry[];
  appendCustomEntry(customType: string, data: unknown): void;
};

/**
 * Provider-owned replay-history sanitization input.
 *
 * Runs after core applies generic transcript cleanup so plugins can make
 * provider-specific replay rewrites without owning the whole compaction flow.
 */
export type ProviderSanitizeReplayHistoryContext = ProviderReplayPolicyContext & {
  sessionId: string;
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
  sessionState?: ProviderReplaySessionState;
};

/**
 * Provider-owned final replay-turn validation input.
 *
 * Use this for providers that require strict turn ordering or additional
 * replay-time transcript validation beyond generic sanitation.
 */
export type ProviderValidateReplayTurnsContext = ProviderReplayPolicyContext & {
  sessionId?: string;
  messages: AgentMessage[];
  sessionState?: ProviderReplaySessionState;
};

/**
 * Provider-owned tool-schema normalization input.
 *
 * Runs before tool registration for replay/compaction/inference so providers
 * can rewrite schema keywords that their transport family does not support.
 */
export type ProviderNormalizeToolSchemasContext = ProviderReplayPolicyContext & {
  tools: AnyAgentTool[];
};

export type ProviderToolSchemaDiagnostic = {
  toolName: string;
  toolIndex?: number;
  violations: string[];
};

/**
 * Provider-owned reasoning output mode input.
 *
 * Use this when a provider requires a specific reasoning-output contract, such
 * as text tags instead of native structured reasoning fields.
 */
export type ProviderReasoningOutputModeContext = ProviderReplayPolicyContext;

/**
 * Provider-owned transport creation.
 *
 * Use this when the provider needs to replace pi-ai's default transport with a
 * custom StreamFn (for example a native API transport that cannot be expressed
 * as a wrapper around `streamSimple`).
 */
export type ProviderCreateStreamFnContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

/**
 * Provider-owned stream wrapper hook after OpenClaw applies its generic
 * transport-independent wrappers.
 *
 * Use this for provider-specific payload/header/model mutations that still run
 * through the normal `pi-ai` stream path.
 */
export type ProviderWrapStreamFnContext = ProviderPrepareExtraParamsContext & {
  model?: ProviderRuntimeModel;
  streamFn?: StreamFn;
};

/**
 * Provider-owned transport turn state.
 *
 * Use this for provider-native request headers or metadata that should stay
 * stable across retries while still being attached by generic core transports.
 */
export type ProviderTransportTurnState = {
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
};

/**
 * Provider-owned request identity for transport turns.
 *
 * Use this when the provider exposes native request/session metadata that must
 * be attached by both HTTP and WebSocket transports.
 */
export type ProviderResolveTransportTurnStateContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
  turnId: string;
  attempt: number;
  transport: "stream" | "websocket";
};

/**
 * Provider-owned WebSocket session policy.
 *
 * Use this for session-scoped headers or cool-down behavior that should apply
 * before a generic WebSocket transport decides to retry or fall back.
 */
export type ProviderWebSocketSessionPolicy = {
  headers?: Record<string, string>;
  degradeCooldownMs?: number;
};

/**
 * Provider-owned WebSocket session policy input.
 *
 * Use this when the provider wants to control native session handshake headers
 * or the post-failure cool-down window for a generic WebSocket transport.
 */
export type ProviderResolveWebSocketSessionPolicyContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};

/**
 * Provider-owned failover error classification input.
 *
 * Use this when provider-specific transport or API errors need classification
 * hints that generic string matching cannot express safely.
 */
export type ProviderFailoverErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
};

/**
 * Generic embedding provider shape returned by provider plugins.
 *
 * Keep this aligned with the memory embedding contract without forcing the
 * plugin system to import memory internals directly.
 */
export type PluginEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedBatchInputs?: (inputs: unknown[]) => Promise<number[][]>;
  client?: unknown;
};

/**
 * Provider-owned embedding transport creation.
 *
 * Use this when a provider wants memory embeddings to live with the provider
 * plugin instead of the core memory switchboard.
 */
export type ProviderCreateEmbeddingProviderContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  providerApiKey?: string;
  outputDimensionality?: number;
  taskType?: string;
};

/**
 * Provider-owned prompt-cache eligibility.
 *
 * Return `true` or `false` to override OpenClaw's built-in provider cache TTL
 * detection for this provider. Return `undefined` to fall back to core rules.
 */
export type ProviderCacheTtlEligibilityContext = {
  provider: string;
  modelId: string;
  modelApi?: string;
};

/**
 * Provider-owned missing-auth message override.
 *
 * Runs only after OpenClaw exhausts normal env/profile/config auth resolution
 * for the requested provider. Return a custom message to replace the generic
 * "No API key found" error.
 */
export type ProviderBuildMissingAuthMessageContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  listProfileIds: (providerId: string) => string[];
};

/**
 * Provider-owned unknown-model hint override.
 *
 * Runs after catalog/runtime lookup misses for the requested provider. Return a
 * hint suffix that OpenClaw should append to the generic `Unknown model`
 * error.
 */
export type ProviderBuildUnknownModelHintContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};

/**
 * Built-in model suppression hook.
 *
 * Use this when a provider/plugin needs to hide stale upstream catalog rows or
 * replace them with a vendor-specific hint. This hook is consulted by model
 * resolution, model listing, and catalog loading.
 */
export type ProviderBuiltInModelSuppressionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};

export type ProviderBuiltInModelSuppressionResult = {
  suppress: boolean;
  errorMessage?: string;
};

export type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
} from "./provider-thinking.types.js";

/**
 * Provider-owned "modern model" policy input.
 *
 * Live smoke/model-profile selection uses this to keep provider-specific
 * inclusion/exclusion rules out of core.
 */
export type ProviderModernModelPolicyContext = {
  provider: string;
  modelId: string;
};

/**
 * Final catalog augmentation hook.
 *
 * Runs after OpenClaw loads the discovered model catalog and merges configured
 * opt-in providers. Use this for forward-compat rows or vendor-owned synthetic
 * entries that should appear in `models list` and model pickers even when the
 * upstream registry has not caught up yet.
 */
export type ProviderAugmentModelCatalogContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  entries: ModelCatalogEntry[];
};

/**
 * @deprecated Use ProviderCatalogOrder.
 */
export type ProviderDiscoveryOrder = ProviderCatalogOrder;

/**
 * @deprecated Use ProviderCatalogContext.
 */
export type ProviderDiscoveryContext = ProviderCatalogContext;

/**
 * @deprecated Use ProviderCatalogResult.
 */
export type ProviderDiscoveryResult = ProviderCatalogResult;

/**
 * @deprecated Use ProviderPluginCatalog.
 */
export type ProviderPluginDiscovery = ProviderPluginCatalog;

export type ProviderPluginWizardSetup = {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  methodId?: string;
  /**
   * Interactive onboarding surfaces where this auth choice should appear.
   * Defaults to `["text-inference"]` when omitted.
   */
  onboardingScopes?: Array<"text-inference" | "image-generation">;
  /**
   * Optional model-allowlist prompt policy applied after this auth choice is
   * selected in configure/onboarding flows.
   *
   * Keep this UI-facing and static. Provider logic that needs runtime state
   * should stay in `run`/`runNonInteractive`.
   */
  modelAllowlist?: {
    allowedKeys?: string[];
    initialSelections?: string[];
    message?: string;
  };
  /**
   * Optional default-model prompt policy for this auth/setup choice.
   *
   * Use this when selecting the auth choice should still force a model picker
   * even if the choice was preseeded via CLI/configure, or when "keep current"
   * would skip required provider-owned post-selection work.
   */
  modelSelection?: {
    promptWhenAuthChoiceProvided?: boolean;
    allowKeepCurrent?: boolean;
  };
};

/** Optional model-picker metadata shown in interactive provider selection flows. */
export type ProviderPluginWizardModelPicker = {
  label?: string;
  hint?: string;
  methodId?: string;
};

/** UI metadata that lets provider plugins appear in onboarding and configure flows. */
export type ProviderPluginWizard = {
  setup?: ProviderPluginWizardSetup;
  modelPicker?: ProviderPluginWizardModelPicker;
};

export type ProviderOAuthProfileIdRepair = {
  /**
   * Legacy OAuth profile id to migrate away from.
   *
   * When omitted, OpenClaw falls back to `<provider>:default`.
   */
  legacyProfileId?: string;
  /**
   * Optional custom doctor prompt label.
   *
   * Defaults to the provider label when omitted.
   */
  promptLabel?: string;
};

export type ProviderModelSelectedContext = {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
};

export type ProviderDeferSyntheticProfileAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
  resolvedApiKey?: string;
};

export type ProviderSystemPromptContributionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  promptMode: PromptMode;
  runtimeChannel?: string;
  runtimeCapabilities?: string[];
  agentId?: string;
};

export type ProviderTransformSystemPromptContext = ProviderSystemPromptContributionContext & {
  systemPrompt: string;
};

export type PluginTextTransformRegistration = PluginTextTransforms;

/** Text-inference provider capability registered by a plugin. */
export type ProviderPlugin = {
  id: string;
  pluginId?: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  /**
   * Internal-only aliases used for runtime/config hook lookup.
   *
   * Unlike `aliases`, these values are not treated as user-facing provider ids
   * for auth/setup surfaces. Use them for legacy config keys or compat-only
   * hook routing.
   */
  hookAliases?: string[];
  /**
   * Provider-related env vars shown in setup/search/help surfaces.
   *
   * Keep entries in preferred display order. This can include direct auth env
   * vars or setup inputs such as OAuth client id/secret vars.
   */
  envVars?: string[];
  auth: ProviderAuthMethod[];
  /**
   * Preferred hook for plugin-defined provider catalogs.
   * Returns provider config/model definitions that merge into models.providers.
   */
  catalog?: ProviderPluginCatalog;
  /**
   * Offline provider catalog for display-only surfaces.
   *
   * Unlike `catalog`, this hook must not perform network I/O or require real
   * credentials. Use it for bundled/static rows that can be shown before auth is
   * configured.
   */
  staticCatalog?: ProviderPluginCatalog;
  /**
   * Legacy alias for catalog.
   * Kept for compatibility with existing provider plugins.
   */
  discovery?: ProviderPluginDiscovery;
  /**
   * Sync runtime fallback for model ids not present in the local catalog.
   *
   * Hook order:
   * 1. discovered/static model lookup
   * 2. plugin `resolveDynamicModel`
   * 3. core fallback heuristics
   * 4. generic provider-config fallback
   *
   * Keep this hook cheap and deterministic. If you need network I/O first, use
   * `prepareDynamicModel` to prime state for the async retry path.
   */
  resolveDynamicModel?: (
    ctx: ProviderResolveDynamicModelContext,
  ) => ProviderRuntimeModel | null | undefined;
  /**
   * Optional async prefetch for dynamic model resolution.
   *
   * OpenClaw calls this only from async model resolution paths. After it
   * completes, `resolveDynamicModel` is called again.
   */
  prepareDynamicModel?: (ctx: ProviderPrepareDynamicModelContext) => Promise<void>;
  /**
   * Lets a provider plugin opt exact configured models into a runtime
   * metadata comparison pass before the embedded runner returns the explicit
   * entry unchanged.
   */
  preferRuntimeResolvedModel?: (ctx: ProviderPreferRuntimeResolvedModelContext) => boolean;
  /**
   * Provider-owned transport normalization.
   *
   * Use this to rewrite a resolved model without forking the generic runner:
   * swap API ids, update base URLs, or adjust compat flags for a provider's
   * transport quirks.
   */
  normalizeResolvedModel?: (
    ctx: ProviderNormalizeResolvedModelContext,
  ) => ProviderRuntimeModel | null | undefined;
  /**
   * Provider-owned compat contribution for resolved models outside direct
   * provider ownership.
   *
   * Use this when a plugin can recognize its vendor's models behind another
   * OpenAI-compatible transport (for example OpenRouter or a custom base URL)
   * and needs to contribute compat flags without taking over the provider.
   */
  contributeResolvedModelCompat?: (
    ctx: ProviderNormalizeResolvedModelContext,
  ) => Partial<ModelCompatConfig> | null | undefined;
  /**
   * Provider-owned model-id normalization.
   *
   * Runs before model lookup/canonicalization. Use this for alias cleanup such
   * as provider-owned preview/legacy model ids.
   */
  normalizeModelId?: (ctx: ProviderNormalizeModelIdContext) => string | null | undefined;
  /**
   * Provider-owned transport-family normalization before generic model
   * assembly.
   *
   * Use this for API/baseUrl cleanup that may apply to custom provider ids
   * which still target the provider's transport family.
   */
  normalizeTransport?: (
    ctx: ProviderNormalizeTransportContext,
  ) => { api?: string | null; baseUrl?: string } | null | undefined;
  /**
   * Provider-owned config normalization for `models.providers.<id>`.
   *
   * Use this for provider-specific baseUrl/model-id cleanup that should stay
   * with the plugin rather than in core config-policy tables.
   */
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  /**
   * Provider-owned final native-streaming compat pass for config providers.
   *
   * Use this when a provider opts specific native base URLs into
   * `supportsUsageInStreaming` or similar transport compatibility flags.
   */
  applyNativeStreamingUsageCompat?: (
    ctx: ProviderNormalizeConfigContext,
  ) => ModelProviderConfig | null | undefined;
  /**
   * Provider-owned config apiKey/env marker resolution.
   *
   * Use this when a provider resolves auth from env vars such as AWS/GCP
   * markers rather than a normal API-key env var.
   */
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  /**
   * @deprecated Legacy static capability bag kept only for compatibility.
   *
   * New provider behavior should use explicit hooks instead. Core replay and
   * stream/runtime logic no longer consumes this field.
   */
  capabilities?: ProviderCapabilities;
  /**
   * Provider-owned replay/compaction policy override.
   *
   * Use this when transcript replay or compaction should follow provider-owned
   * rules that are more expressive than the static `capabilities` bag.
   */
  buildReplayPolicy?: (ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined;
  /**
   * Provider-owned replay-history sanitization.
   *
   * Runs after OpenClaw performs generic transcript cleanup. Use this for
   * provider-specific replay rewrites that should stay with the provider
   * plugin rather than in shared core compaction helpers.
   */
  sanitizeReplayHistory?: (
    ctx: ProviderSanitizeReplayHistoryContext,
  ) => Promise<AgentMessage[] | null | undefined> | AgentMessage[] | null | undefined;
  /**
   * Provider-owned final replay-turn validation.
   *
   * Use this when provider transports need stricter replay-time validation or
   * turn reshaping after generic sanitation. Returning a non-null value
   * replaces the built-in replay validators rather than composing with them.
   */
  validateReplayTurns?: (
    ctx: ProviderValidateReplayTurnsContext,
  ) => Promise<AgentMessage[] | null | undefined> | AgentMessage[] | null | undefined;
  /**
   * Provider-owned tool-schema normalization.
   *
   * Use this for transport-family schema cleanup before OpenClaw registers
   * tools with the embedded runner.
   */
  normalizeToolSchemas?: (
    ctx: ProviderNormalizeToolSchemasContext,
  ) => AnyAgentTool[] | null | undefined;
  /**
   * Provider-owned tool-schema diagnostics after normalization.
   *
   * Use this when a provider wants to surface transport-specific schema
   * warnings without teaching core about provider-specific keyword rules.
   */
  inspectToolSchemas?: (
    ctx: ProviderNormalizeToolSchemasContext,
  ) => ProviderToolSchemaDiagnostic[] | null | undefined;
  /**
   * Provider-owned reasoning output mode.
   *
   * Use this when a provider requires tagged reasoning/final output instead of
   * native structured reasoning fields.
   */
  resolveReasoningOutputMode?: (
    ctx: ProviderReasoningOutputModeContext,
  ) => ProviderReasoningOutputMode | null | undefined;
  /**
   * Provider-owned extra-param normalization before generic stream option
   * wrapping.
   *
   * Typical uses: set provider-default `transport`, map provider-specific
   * config aliases, or inject extra request metadata sourced from
   * `agents.defaults.models.<provider>/<model>.params`.
   */
  prepareExtraParams?: (
    ctx: ProviderPrepareExtraParamsContext,
  ) => Record<string, unknown> | null | undefined;
  /**
   * Provider-owned request params after transport/model resolution.
   *
   * Use this for transport-family request knobs that should be keyed by the
   * resolved model API/transport rather than a hardcoded core allowlist.
   */
  extraParamsForTransport?: (
    ctx: ProviderExtraParamsForTransportContext,
  ) => ProviderExtraParamsForTransportResult | null | undefined;
  /**
   * Provider-owned transport factory.
   *
   * Use this when the provider needs a fully custom StreamFn instead of a
   * wrapper around the normal `streamSimple` path.
   */
  createStreamFn?: (ctx: ProviderCreateStreamFnContext) => StreamFn | null | undefined;
  /**
   * Provider-owned stream wrapper applied after generic OpenClaw wrappers.
   *
   * Typical uses: provider attribution headers, request-body rewrites, or
   * provider-specific compat payload patches that do not justify a separate
   * transport implementation.
   */
  wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;
  /**
   * Provider-owned native transport turn identity.
   *
   * Use this when a provider wants generic transports to attach provider-native
   * request headers or metadata on each turn without hardcoding vendor logic in
   * core.
   */
  resolveTransportTurnState?: (
    ctx: ProviderResolveTransportTurnStateContext,
  ) => ProviderTransportTurnState | null | undefined;
  /**
   * Provider-owned WebSocket session policy.
   *
   * Use this when a provider wants generic WebSocket transports to attach
   * native session headers or tune the session-scoped cool-down before HTTP
   * fallback.
   */
  resolveWebSocketSessionPolicy?: (
    ctx: ProviderResolveWebSocketSessionPolicyContext,
  ) => ProviderWebSocketSessionPolicy | null | undefined;
  /**
   * Provider-owned embedding provider factory.
   *
   * Use this when memory embedding behavior belongs with the provider plugin
   * rather than the core embedding switchboard.
   */
  createEmbeddingProvider?: (
    ctx: ProviderCreateEmbeddingProviderContext,
  ) =>
    | Promise<PluginEmbeddingProvider | null | undefined>
    | PluginEmbeddingProvider
    | null
    | undefined;
  /**
   * Runtime auth exchange hook.
   *
   * Called after OpenClaw resolves the raw configured credential but before the
   * runner stores it in runtime auth storage. This lets plugins exchange a
   * source credential (for example a GitHub token) into a short-lived runtime
   * token plus optional base URL override.
   */
  prepareRuntimeAuth?: (
    ctx: ProviderPrepareRuntimeAuthContext,
  ) => Promise<ProviderPreparedRuntimeAuth | null | undefined>;
  /**
   * Usage/billing auth resolution hook.
   *
   * Called by provider-usage surfaces (`/usage`, status snapshots, reporting).
   * Use this when a provider's usage endpoint needs provider-owned token
   * extraction, blob parsing, or alias handling.
   */
  resolveUsageAuth?: (
    ctx: ProviderResolveUsageAuthContext,
  ) =>
    | Promise<ProviderResolvedUsageAuth | null | undefined>
    | ProviderResolvedUsageAuth
    | null
    | undefined;
  /**
   * Usage/quota snapshot fetch hook.
   *
   * Called after `resolveUsageAuth` by `/usage` and related reporting surfaces.
   * Use this when the provider's usage endpoint or payload shape is
   * provider-specific and you want that logic to live with the provider plugin
   * instead of the core switchboard.
   */
  fetchUsageSnapshot?: (
    ctx: ProviderFetchUsageSnapshotContext,
  ) => Promise<ProviderUsageSnapshot | null | undefined> | ProviderUsageSnapshot | null | undefined;
  /**
   * Provider-owned failover context-overflow matcher.
   *
   * Return true when the provider recognizes the raw error as a context-window
   * overflow shape that generic heuristics would miss.
   */
  matchesContextOverflowError?: (ctx: ProviderFailoverErrorContext) => boolean | undefined;
  /**
   * Provider-owned failover error classification.
   *
   * Return a failover reason when the provider recognizes a provider-specific
   * raw error shape. Return undefined to fall back to generic classification.
   */
  classifyFailoverReason?: (ctx: ProviderFailoverErrorContext) => FailoverReason | null | undefined;
  /**
   * Provider-owned cache TTL eligibility.
   *
   * Use this when a proxy provider supports Anthropic-style prompt caching for
   * only a subset of upstream models.
   */
  isCacheTtlEligible?: (ctx: ProviderCacheTtlEligibilityContext) => boolean | undefined;
  /**
   * Provider-owned missing-auth message override.
   *
   * Return a custom message when the provider wants a more specific recovery
   * hint than OpenClaw's generic auth-store guidance.
   */
  buildMissingAuthMessage?: (
    ctx: ProviderBuildMissingAuthMessageContext,
  ) => string | null | undefined;
  /**
   * Provider-owned unknown-model hint override.
   *
   * Return a suffix when the provider wants a more specific recovery hint than
   * OpenClaw's generic `Unknown model` error after catalog/runtime lookup
   * fails.
   */
  buildUnknownModelHint?: (ctx: ProviderBuildUnknownModelHintContext) => string | null | undefined;
  /**
   * Provider-owned built-in model suppression.
   *
   * Return `{ suppress: true }` to hide a stale upstream row. Include
   * `errorMessage` when OpenClaw should surface a provider-specific hint for
   * direct model resolution failures.
   */
  suppressBuiltInModel?: (
    ctx: ProviderBuiltInModelSuppressionContext,
  ) => ProviderBuiltInModelSuppressionResult | null | undefined;
  /**
   * Provider-owned final catalog augmentation.
   *
   * Return extra rows to append to the final catalog after discovery/config
   * merging. OpenClaw deduplicates by `provider/id`, so plugins only need to
   * describe the desired supplemental rows.
   */
  augmentModelCatalog?: (
    ctx: ProviderAugmentModelCatalogContext,
  ) =>
    | Array<ModelCatalogEntry>
    | ReadonlyArray<ModelCatalogEntry>
    | Promise<Array<ModelCatalogEntry> | ReadonlyArray<ModelCatalogEntry> | null | undefined>
    | null
    | undefined;
  /**
   * Provider-owned binary thinking toggle.
   *
   * Return true when the provider exposes a coarse on/off reasoning control
   * instead of the normal multi-level ladder shown by `/think`.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  isBinaryThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  /**
   * Provider-owned xhigh reasoning support.
   *
   * Return true only for models that should expose the `xhigh` thinking level.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  supportsXHighThinking?: (ctx: ProviderThinkingPolicyContext) => boolean | undefined;
  /**
   * Provider-owned thinking level profile.
   *
   * Prefer this over the individual thinking capability hooks when a provider
   * or model exposes a custom set of thinking levels. OpenClaw stores the
   * canonical `id`, shows `label` when provided, and downgrades stale stored
   * values by profile rank.
   */
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
  /**
   * Provider-owned default thinking level.
   *
   * Use this to keep model-family defaults (for example Claude 4.6 =>
   * adaptive) out of core command logic.
   *
   * @deprecated Prefer `resolveThinkingProfile`.
   */
  resolveDefaultThinkingLevel?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null | undefined;
  /**
   * Provider-owned system-prompt contribution.
   *
   * Use this when a provider/model family needs cache-aware prompt tuning
   * without replacing the full OpenClaw-owned system prompt.
   */
  resolveSystemPromptContribution?: (
    ctx: ProviderSystemPromptContributionContext,
  ) => ProviderSystemPromptContribution | null | undefined;
  /**
   * Provider-owned GPT/model prompt overlay seam.
   *
   * Runs after OpenClaw's built-in overlay is resolved and before the
   * provider's regular system-prompt contribution is merged.
   */
  resolvePromptOverlay?: (
    ctx: ProviderResolvePromptOverlayContext,
  ) => ProviderSystemPromptContribution | null | undefined;
  /**
   * Provider-owned fallback route override for model/profile failure handling.
   *
   * Return undefined/null to keep OpenClaw's default fallback policy.
   */
  followupFallbackRoute?: (
    ctx: ProviderFollowupFallbackRouteContext,
  ) => ProviderFollowupFallbackRouteResult | null | undefined;
  /**
   * Provider-owned auth profile resolver.
   *
   * Return a profile id from the supplied order to prefer it for this attempt;
   * invalid or missing ids are ignored by core.
   */
  resolveAuthProfileId?: (ctx: ProviderResolveAuthProfileIdContext) => string | null | undefined;
  /**
   * Provider-owned final system-prompt transform.
   *
   * Use this sparingly when a provider transport needs small compatibility
   * rewrites after OpenClaw has assembled the complete prompt. Return
   * `undefined`/`null` to leave the prompt unchanged.
   */
  transformSystemPrompt?: (ctx: ProviderTransformSystemPromptContext) => string | null | undefined;
  /**
   * Provider-owned bidirectional text replacements.
   *
   * `input` applies to system prompts and text message content before transport.
   * `output` applies to assistant text deltas/final text before OpenClaw handles
   * its own control markers or channel delivery.
   */
  textTransforms?: PluginTextTransforms;
  /**
   * Provider-owned global config defaults.
   *
   * Use this when config materialization needs provider-specific defaults that
   * depend on auth mode, env, or provider model-family semantics.
   */
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  /**
   * Provider-owned "modern model" matcher used by live profile/smoke filters.
   *
   * Return true when the given provider/model ref should be treated as a
   * preferred modern model candidate.
   */
  isModernModelRef?: (ctx: ProviderModernModelPolicyContext) => boolean | undefined;
  wizard?: ProviderPluginWizard;
  /**
   * Provider-owned auth-profile API-key formatter.
   *
   * OpenClaw uses this when a stored auth profile is already valid and needs to
   * be converted into the runtime `apiKey` string expected by the provider. Use
   * this for providers whose auth profile stores extra metadata alongside the
   * bearer token (for example Gemini CLI's `{ token, projectId }` payload).
   */
  formatApiKey?: (cred: AuthProfileCredential) => string;
  /**
   * Legacy auth-profile ids that should be retired by `openclaw doctor`.
   *
   * Use this when a provider plugin replaces an older core-managed profile id
   * and wants cleanup/migration messaging to live with the provider instead of
   * in hardcoded doctor tables.
   */
  deprecatedProfileIds?: string[];
  /**
   * Legacy OAuth profile-id migrations that `openclaw doctor` should offer.
   *
   * Use this when a provider moved from a legacy default OAuth profile id to a
   * newer identity-based id and wants doctor to own the config rewrite without
   * another core-specific migration branch.
   */
  oauthProfileIdRepairs?: ProviderOAuthProfileIdRepair[];
  /**
   * Provider-owned OAuth refresh.
   *
   * OpenClaw calls this before falling back to the shared `pi-ai` OAuth
   * refreshers. Use it when the provider has a custom refresh endpoint, or when
   * the provider needs custom refresh-failure behavior that should stay out of
   * core auth-profile code.
   */
  refreshOAuth?: (cred: OAuthCredential) => Promise<OAuthCredential>;
  /**
   * Provider-owned auth-doctor hint.
   *
   * Return a multiline repair hint when OAuth refresh fails and the provider
   * wants to steer users toward a specific auth-profile migration or recovery
   * path. Return nothing to keep OpenClaw's generic error text.
   */
  buildAuthDoctorHint?: (
    ctx: ProviderAuthDoctorHintContext,
  ) => string | Promise<string | null | undefined> | null | undefined;
  /**
   * Provider-owned config-backed auth resolution.
   *
   * Providers own any provider-specific fallback secret rules here so core
   * auth/discovery code can stay generic and avoid parsing provider-private
   * config layouts.
   *
   * The returned `apiKey` may be:
   * - a real credential from the active runtime snapshot, suitable for runtime use
   * - a non-secret marker (for example a managed SecretRef marker), suitable only
   *   for discovery/bootstrap callers
   *
   * Runtime callers must not treat non-secret markers as runnable credentials;
   * they should retry against the active runtime snapshot when available.
   *
   * This hook is the canonical seam for provider-specific fallback auth
   * derived from plugin/private config. It may return:
   * - a runnable literal credential for runtime callers
   * - a non-secret marker for managed-secret source config, which is still useful
   *   for discovery/bootstrap callers
   *
   * Runtime callers must not treat non-secret markers as runnable credentials;
   * they should retry against the active runtime snapshot when available.
   *
   * Use this when the provider can operate without a real secret for certain
   * configured local/self-hosted cases and wants auth resolution to treat that
   * config as available.
   */
  resolveSyntheticAuth?: (
    ctx: ProviderResolveSyntheticAuthContext,
  ) => ProviderSyntheticAuthResult | null | undefined;
  /**
   * Provider-owned external auth profile discovery.
   *
   * Use this when credentials are managed by an external tool and should be visible
   * to runtime auth resolution without being written back into `auth-profiles.json`
   * by core.
   */
  resolveExternalAuthProfiles?: (
    ctx: ProviderResolveExternalAuthProfilesContext,
  ) =>
    | Array<ProviderExternalAuthProfile>
    | ReadonlyArray<ProviderExternalAuthProfile>
    | null
    | undefined;
  /**
   * @deprecated Declare `contracts.externalAuthProviders` in the plugin manifest
   * and implement `resolveExternalAuthProfiles` instead. This compatibility hook
   * is loaded through a slower fallback path and will be removed in a future release.
   */
  resolveExternalOAuthProfiles?: (
    ctx: ProviderResolveExternalOAuthProfilesContext,
  ) =>
    | Array<ProviderExternalOAuthProfile>
    | ReadonlyArray<ProviderExternalOAuthProfile>
    | null
    | undefined;
  /**
   * Provider-owned precedence rule for stored synthetic auth profiles.
   *
   * Return true when a stored profile API key is only a provider-owned
   * synthetic placeholder and should yield to env/config-backed auth before
   * OpenClaw falls back to that stored profile.
   */
  shouldDeferSyntheticProfileAuth?: (
    ctx: ProviderDeferSyntheticProfileAuthContext,
  ) => boolean | undefined;
  onModelSelected?: (ctx: ProviderModelSelectedContext) => Promise<void>;
};

/** Speech capability registered by a plugin. */
export type SpeechProviderPlugin = {
  id: SpeechProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  models?: readonly string[];
  voices?: readonly string[];
  resolveConfig?: (ctx: SpeechProviderResolveConfigContext) => SpeechProviderConfig;
  parseDirectiveToken?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  resolveTalkConfig?: (ctx: SpeechProviderResolveTalkConfigContext) => SpeechProviderConfig;
  resolveTalkOverrides?: (
    ctx: SpeechProviderResolveTalkOverridesContext,
  ) => SpeechProviderConfig | undefined;
  isConfigured: (ctx: SpeechProviderConfiguredContext) => boolean;
  synthesize: (req: SpeechSynthesisRequest) => Promise<SpeechSynthesisResult>;
  synthesizeTelephony?: (
    req: SpeechTelephonySynthesisRequest,
  ) => Promise<SpeechTelephonySynthesisResult>;
  listVoices?: (req: SpeechListVoicesRequest) => Promise<SpeechVoiceOption[]>;
};

export type PluginSpeechProviderEntry = SpeechProviderPlugin & {
  pluginId: string;
};

/** Realtime transcription capability registered by a plugin. */
export type RealtimeTranscriptionProviderPlugin = {
  id: RealtimeTranscriptionProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  resolveConfig?: (
    ctx: RealtimeTranscriptionProviderResolveConfigContext,
  ) => RealtimeTranscriptionProviderConfig;
  isConfigured: (ctx: RealtimeTranscriptionProviderConfiguredContext) => boolean;
  createSession: (req: RealtimeTranscriptionSessionCreateRequest) => RealtimeTranscriptionSession;
};

export type PluginRealtimeTranscriptionProviderEntry = RealtimeTranscriptionProviderPlugin & {
  pluginId: string;
};

/** Realtime voice capability registered by a plugin. */
export type RealtimeVoiceProviderPlugin = {
  id: RealtimeVoiceProviderId;
  label: string;
  aliases?: string[];
  autoSelectOrder?: number;
  resolveConfig?: (ctx: RealtimeVoiceProviderResolveConfigContext) => RealtimeVoiceProviderConfig;
  isConfigured: (ctx: RealtimeVoiceProviderConfiguredContext) => boolean;
  createBridge: (req: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
  createBrowserSession?: (
    req: RealtimeVoiceBrowserSessionCreateRequest,
  ) => Promise<RealtimeVoiceBrowserSession>;
};

export type PluginRealtimeVoiceProviderEntry = RealtimeVoiceProviderPlugin & {
  pluginId: string;
};

export type MediaUnderstandingProviderPlugin = MediaUnderstandingProvider;
export type ImageGenerationProviderPlugin = ImageGenerationProvider;
export type VideoGenerationProviderPlugin = VideoGenerationProvider;
export type MusicGenerationProviderPlugin = MusicGenerationProvider;

export type OpenClawPluginGatewayMethod = {
  method: string;
  handler: GatewayRequestHandler;
};

// =============================================================================
// Plugin Commands
// =============================================================================

/**
 * Context passed to plugin command handlers.
 */
export type PluginCommandContext = {
  /** The sender's identifier (for example a channel-scoped user ID) */
  senderId?: string;
  /** The channel/surface (for example "chat" or "team-chat") */
  channel: string;
  /** Provider channel id */
  channelId?: ChannelId;
  /** Whether the sender is on the allowlist */
  isAuthorizedSender: boolean;
  /** Gateway client scopes for internal control-plane callers */
  gatewayClientScopes?: string[];
  /** Stable host session key for the active conversation when available. */
  sessionKey?: string;
  /** Ephemeral host session id for the active conversation when available. */
  sessionId?: string;
  /** Transcript file for the active OpenClaw session when available. */
  sessionFile?: string;
  /** Raw command arguments after the command name */
  args?: string;
  /** The full normalized command body */
  commandBody: string;
  /** Current OpenClaw configuration */
  config: OpenClawConfig;
  /** Raw "From" value (channel-scoped id) */
  from?: string;
  /** Raw "To" value (channel-scoped id) */
  to?: string;
  /** Account id for multi-account channels */
  accountId?: string;
  /** Thread/topic id if available */
  messageThreadId?: string | number;
  /** Parent conversation id for thread-capable channels */
  threadParentId?: string;
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

/**
 * Result returned by a plugin command handler.
 */
export type PluginCommandResult = ReplyPayload;

/**
 * Handler function for plugin commands.
 */
export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

/**
 * Definition for a plugin-registered command.
 */
export type OpenClawPluginCommandDefinition = {
  /** Command name without leading slash (e.g., "tts") */
  name: string;
  /**
   * Optional native-command aliases for slash/menu surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists (for example `{ default: "talkvoice", teamChat: "voice2" }`).
   */
  nativeNames?: Partial<Record<string, string>> & { default?: string };
  /**
   * Optional native progress placeholder text for native command surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists.
   */
  nativeProgressMessages?: Partial<Record<string, string>> & {
    default?: string;
  };
  /** Description shown in /help and command menus */
  description: string;
  /** Whether this command accepts arguments */
  acceptsArgs?: boolean;
  /** Whether only authorized senders can use this command (default: true) */
  requireAuth?: boolean;
  /** The handler function */
  handler: PluginCommandHandler;
};

export type PluginInteractiveHandlerResult = {
  handled?: boolean;
} | void;

export type PluginInteractiveRegistration<
  TContext = unknown,
  TChannel extends string = string,
  TResult = PluginInteractiveHandlerResult,
> = {
  channel: TChannel;
  namespace: string;
  handler: (ctx: TContext) => Promise<TResult> | TResult;
};

export type PluginInteractiveHandlerRegistration = PluginInteractiveRegistration;

export type OpenClawPluginHttpRouteAuth = "gateway" | "plugin";
export type OpenClawPluginHttpRouteMatch = "exact" | "prefix";
export type OpenClawPluginGatewayRuntimeScopeSurface = "write-default" | "trusted-operator";

export type OpenClawPluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

export type OpenClawPluginHttpRouteParams = {
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match?: OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  replaceExisting?: boolean;
};

export type OpenClawPluginCliContext = {
  program: Command;
  config: OpenClawConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};

export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;

/**
 * Top-level CLI metadata for plugin-owned commands.
 *
 * Descriptors are the parse-time contract for lazy plugin CLI registration.
 * If you want OpenClaw to keep a plugin command lazy-loaded while still
 * advertising it at the root CLI level, provide descriptors that cover every
 * top-level command root registered by that plugin CLI surface.
 */
export type OpenClawPluginCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export type OpenClawPluginReloadRegistration = {
  restartPrefixes?: string[];
  hotPrefixes?: string[];
  noopPrefixes?: string[];
};

export type OpenClawPluginNodeHostCommand = {
  command: string;
  cap?: string;
  handle: (paramsJSON?: string | null) => Promise<string>;
};

export type OpenClawPluginSecurityAuditContext = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
};

export type OpenClawPluginSecurityAuditCollector = (
  ctx: OpenClawPluginSecurityAuditContext,
) => SecurityAuditFinding[] | Promise<SecurityAuditFinding[]>;

export type OpenClawGatewayDiscoveryAdvertiseContext = {
  machineDisplayName: string;
  gatewayPort: number;
  gatewayTlsEnabled: boolean;
  gatewayTlsFingerprintSha256?: string;
  canvasPort?: number;
  tailnetDns?: string;
  sshPort?: number;
  cliPath?: string;
  minimal: boolean;
};

export type OpenClawGatewayDiscoveryService = {
  id: string;
  advertise: (
    ctx: OpenClawGatewayDiscoveryAdvertiseContext,
  ) => void | Promise<void | { stop?: () => void | Promise<void> }>;
};

/** Context passed to long-lived plugin services. */
export type OpenClawPluginServiceContext = {
  config: OpenClawConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

/** Background service registered by a plugin during `register(api)`. */
export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

export type OpenClawPluginChannelRegistration = {
  plugin: ChannelPlugin;
};

/** Module-level plugin definition loaded from a native plugin entry file. */
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind | PluginKind[];
  configSchema?: OpenClawPluginConfigSchema;
  reload?: OpenClawPluginReloadRegistration;
  nodeHostCommands?: OpenClawPluginNodeHostCommand[];
  securityAuditCollectors?: OpenClawPluginSecurityAuditCollector[];
  register?: (api: OpenClawPluginApi) => void;
  activate?: (api: OpenClawPluginApi) => void;
};

export type OpenClawPluginModule = OpenClawPluginDefinition | ((api: OpenClawPluginApi) => void);

export type PluginRegistrationMode = "full" | "setup-only" | "setup-runtime" | "cli-metadata";

export type PluginConfigMigration = (config: OpenClawConfig) =>
  | {
      config: OpenClawConfig;
      changes: string[];
    }
  | null
  | undefined;

export type PluginSetupAutoEnableContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export type PluginSetupAutoEnableProbe = (
  ctx: PluginSetupAutoEnableContext,
) => string | string[] | null | undefined;

/** Main registration API injected into native plugin entry files. */
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: PluginRegistrationMode;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  /**
   * In-process runtime helpers for trusted native plugins.
   *
   * This surface is broader than hooks. Prefer hooks for third-party
   * automation/integration unless you need native registry integration.
   */
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
  /** Register a native messaging channel plugin (channel capability). */
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  /**
   * Register a gateway RPC method for this plugin.
   *
   * Reserved core admin namespaces (`config.*`, `exec.approvals.*`,
   * `wizard.*`, `update.*`) always normalize to `operator.admin` even if a
   * narrower scope is requested.
   */
  registerGatewayMethod: (
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => void;
  registerCli: (
    registrar: OpenClawPluginCliRegistrar,
    opts?: {
      /** Explicit top-level command roots owned by this registrar. */
      commands?: string[];
      /**
       * Parse-time command descriptors for lazy root CLI registration.
       *
       * When descriptors cover every top-level command root, OpenClaw can keep
       * the plugin registrar lazy in the normal root CLI path. Command-only
       * registrations stay on the eager compatibility path.
       */
      descriptors?: OpenClawPluginCliCommandDescriptor[];
    },
  ) => void;
  registerReload: (registration: OpenClawPluginReloadRegistration) => void;
  registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => void;
  registerSecurityAuditCollector: (collector: OpenClawPluginSecurityAuditCollector) => void;
  registerService: (service: OpenClawPluginService) => void;
  /** Register a local gateway discovery advertiser such as mDNS/Bonjour. */
  registerGatewayDiscoveryService: (service: OpenClawGatewayDiscoveryService) => void;
  /** Register a text-only CLI backend used by the local CLI runner. */
  registerCliBackend: (backend: CliBackendPlugin) => void;
  /** Register plugin-owned prompt/message compatibility text transforms. */
  registerTextTransforms: (transforms: PluginTextTransformRegistration) => void;
  /** Register a lightweight config migration that can run before plugin runtime loads. */
  registerConfigMigration: (migrate: PluginConfigMigration) => void;
  /** Register a lightweight config probe that can auto-enable this plugin generically. */
  registerAutoEnableProbe: (probe: PluginSetupAutoEnableProbe) => void;
  /** Register a native model/provider plugin (text inference capability). */
  registerProvider: (provider: ProviderPlugin) => void;
  /** Register a speech synthesis provider (speech capability). */
  registerSpeechProvider: (provider: SpeechProviderPlugin) => void;
  /** Register a realtime transcription provider (streaming STT capability). */
  registerRealtimeTranscriptionProvider: (provider: RealtimeTranscriptionProviderPlugin) => void;
  /** Register a realtime voice provider (duplex voice capability). */
  registerRealtimeVoiceProvider: (provider: RealtimeVoiceProviderPlugin) => void;
  /** Register a media understanding provider (media understanding capability). */
  registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => void;
  /** Register an image generation provider (image generation capability). */
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
  /** Register a video generation provider (video generation capability). */
  registerVideoGenerationProvider: (provider: VideoGenerationProviderPlugin) => void;
  /** Register a music generation provider (music generation capability). */
  registerMusicGenerationProvider: (provider: MusicGenerationProviderPlugin) => void;
  /** Register a web fetch provider (web fetch capability). */
  registerWebFetchProvider: (provider: WebFetchProviderPlugin) => void;
  /** Register a web search provider (web search capability). */
  registerWebSearchProvider: (provider: WebSearchProviderPlugin) => void;
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  onConversationBindingResolved: (
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => void;
  /**
   * Register a custom command that bypasses the LLM agent.
   * Plugin commands are processed before built-in commands and before agent invocation.
   * Use this for simple state-toggling or status commands that don't need AI reasoning.
   */
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  /** Register a context engine implementation (exclusive slot - only one active at a time). */
  registerContextEngine: (
    id: string,
    factory: import("../context-engine/registry.js").ContextEngineFactory,
  ) => void;
  /** Register a compaction provider (pluggable summarization backend). */
  registerCompactionProvider: (
    provider: import("./compaction-provider.js").CompactionProvider,
  ) => void;
  /** Register an agent harness implementation. */
  registerAgentHarness: (harness: AgentHarness) => void;
  /** Register a Pi embedded extension factory for OpenClaw embedded runs. Only bundled plugins may use this seam, and `contracts.embeddedExtensionFactories` must include `"pi"`. */
  registerEmbeddedExtensionFactory: (factory: ExtensionFactory) => void;
  /** Register a Codex app-server extension factory for Codex harness tool-result middleware. Only bundled plugins may use this seam, and `contracts.embeddedExtensionFactories` must include `"codex-app-server"`. */
  registerCodexAppServerExtensionFactory: (factory: CodexAppServerExtensionFactory) => void;
  /** Register the active detached task runtime for this plugin (exclusive slot). */
  registerDetachedTaskRuntime: (
    runtime: import("./runtime/runtime-tasks.types.js").DetachedTaskLifecycleRuntime,
  ) => void;
  /** Register the active memory capability for this memory plugin (exclusive slot). */
  registerMemoryCapability: (
    capability: import("./memory-state.js").MemoryPluginCapability,
  ) => void;
  /**
   * Register the system prompt section builder for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ promptBuilder }) instead.
   */
  registerMemoryPromptSection: (
    builder: import("./memory-state.js").MemoryPromptSectionBuilder,
  ) => void;
  /** Register an additive memory-adjacent prompt section (non-exclusive). */
  registerMemoryPromptSupplement: (
    builder: import("./memory-state.js").MemoryPromptSectionBuilder,
  ) => void;
  /** Register an additive memory-adjacent search/read corpus supplement (non-exclusive). */
  registerMemoryCorpusSupplement: (
    supplement: import("./memory-state.js").MemoryCorpusSupplement,
  ) => void;
  /**
   * Register the pre-compaction flush plan resolver for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ flushPlanResolver }) instead.
   */
  registerMemoryFlushPlan: (resolver: import("./memory-state.js").MemoryFlushPlanResolver) => void;
  /**
   * Register the active memory runtime adapter for this memory plugin (exclusive slot).
   * @deprecated Use registerMemoryCapability({ runtime }) instead.
   */
  registerMemoryRuntime: (runtime: import("./memory-state.js").MemoryPluginRuntime) => void;
  /** Register a memory embedding provider adapter. Multiple adapters may coexist. */
  registerMemoryEmbeddingProvider: (
    adapter: import("./memory-embedding-providers.js").MemoryEmbeddingProviderAdapter,
  ) => void;
  resolvePath: (input: string) => string;
  /** Register a lifecycle hook handler */
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
};

// Plugin hook contracts now live in hook-types.ts so hook runners can import a
// leaf contract surface instead of pulling the full plugin runtime barrel.
