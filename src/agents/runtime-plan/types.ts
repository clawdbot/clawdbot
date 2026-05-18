import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type AgentRuntimeTransport = "sse" | "websocket" | "auto";

export type AgentRuntimeThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type AgentRuntimePromptMode = "full" | "minimal" | "none";
export type AgentRuntimePromptTrigger =
  | "cron"
  | "heartbeat"
  | "manual"
  | "memory"
  | "overflow"
  | "user";

export type AgentRuntimeFailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "server_error"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";

export type AgentRuntimeConfig = unknown;

export type AgentRuntimeModel = {
  id?: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: readonly string[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  contextTokens?: number;
  compat?: unknown;
};

export type AgentRuntimeTextReplacement = {
  from: string | RegExp;
  to: string;
};

export type AgentRuntimeTextTransforms = {
  input?: AgentRuntimeTextReplacement[];
  output?: AgentRuntimeTextReplacement[];
};

export type AgentRuntimeProviderHandle = {
  provider: string;
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
};

export type AgentRuntimeInteractiveButtonStyle = "primary" | "secondary" | "success" | "danger";

/** Portable action control exposed to agent runtime reply payloads. */
export type AgentRuntimeMessagePresentationButton = {
  /** User-visible button label. */
  label: string;
  /** Callback command or opaque value sent when pressed. */
  value?: string;
  /** External URL opened by the button. */
  url?: string;
  /** Channel-native web app URL for renderers that support embedded web apps. */
  webApp?: { url: string };
  /** Higher values are kept first when channel action limits require dropping controls. */
  priority?: number;
  /** Disabled action hint; channels without disabled-state support render fallback text. */
  disabled?: boolean;
  /** Optional visual style hint for renderers that support styled actions. */
  style?: AgentRuntimeInteractiveButtonStyle;
};

/** Portable select/menu option exposed to agent runtime reply payloads. */
export type AgentRuntimeMessagePresentationOption = {
  /** User-visible option label. */
  label: string;
  /** Callback command or opaque value sent when selected. */
  value: string;
};

/**
 * @deprecated Use AgentRuntimeMessagePresentationButton.
 */
export type AgentRuntimeInteractiveReplyButton = AgentRuntimeMessagePresentationButton;

/**
 * @deprecated Use AgentRuntimeMessagePresentationOption.
 */
export type AgentRuntimeInteractiveReplyOption = AgentRuntimeMessagePresentationOption;

/**
 * @deprecated Use AgentRuntimeMessagePresentationBlock.
 */
export type AgentRuntimeInteractiveReplyBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "buttons";
      buttons: AgentRuntimeInteractiveReplyButton[];
    }
  | {
      type: "select";
      placeholder?: string;
      options: AgentRuntimeInteractiveReplyOption[];
    };

/**
 * @deprecated Use AgentRuntimeMessagePresentation.
 */
export type AgentRuntimeInteractiveReply = {
  blocks: AgentRuntimeInteractiveReplyBlock[];
};

export type AgentRuntimeMessagePresentationTone =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export type AgentRuntimeMessagePresentationBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "context";
      text: string;
    }
  | {
      type: "divider";
    }
  | {
      type: "buttons";
      buttons: AgentRuntimeMessagePresentationButton[];
    }
  | {
      type: "select";
      placeholder?: string;
      options: AgentRuntimeMessagePresentationOption[];
    };

export type AgentRuntimeMessagePresentation = {
  /** Optional short heading rendered before blocks when supported. */
  title?: string;
  /** Optional severity/status tone for renderers that support toned presentations. */
  tone?: AgentRuntimeMessagePresentationTone;
  /** Ordered portable blocks rendered or downgraded by channel adapters. */
  blocks: AgentRuntimeMessagePresentationBlock[];
};

export type AgentRuntimeReplyPayloadDeliveryPin = {
  enabled: boolean;
  notify?: boolean;
  required?: boolean;
};

export type AgentRuntimeReplyPayloadDelivery = {
  pin?: boolean | AgentRuntimeReplyPayloadDeliveryPin;
};

export type AgentRuntimeReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  presentation?: AgentRuntimeMessagePresentation;
  delivery?: AgentRuntimeReplyPayloadDelivery;
  /**
   * @deprecated Use presentation.
   */
  interactive?: AgentRuntimeInteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: {
    spokenText: string;
    visibleTextAlreadyDelivered?: boolean;
  };
  isError?: boolean;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
  channelData?: Record<string, unknown>;
};

export type AgentRuntimeSystemPromptSectionId =
  | "interaction_style"
  | "tool_call_style"
  | "execution_bias";

export type AgentRuntimeSystemPromptContribution = {
  stablePrefix?: string;
  dynamicSuffix?: string;
  sectionOverrides?: Partial<Record<AgentRuntimeSystemPromptSectionId, string>>;
};

export type AgentRuntimeSystemPromptContributionContext = {
  config?: AgentRuntimeConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  promptMode: AgentRuntimePromptMode;
  runtimeChannel?: string;
  runtimeCapabilities?: string[];
  agentId?: string;
  trigger?: AgentRuntimePromptTrigger;
};

export type AgentRuntimeFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};

export type AgentRuntimeToolCallIdMode = "strict" | "strict9";

export type AgentRuntimeTranscriptPolicy = {
  sanitizeMode: "full" | "images-only";
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: AgentRuntimeToolCallIdMode;
  preserveNativeAnthropicToolUseIds: boolean;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  dropReasoningFromHistory?: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

export type AgentRuntimeOutcomeClassification =
  | {
      message: string;
      reason?: AgentRuntimeFailoverReason;
      status?: number;
      code?: string;
      rawError?: string;
    }
  | {
      error: unknown;
    }
  | null
  | undefined;

export type AgentRuntimeOutcomeClassifier = (params: {
  provider: string;
  model: string;
  result: unknown;
  hasDirectlySentBlockReply?: boolean;
  hasBlockReplyPipelineOutput?: boolean;
}) => AgentRuntimeOutcomeClassification;

export type AgentRuntimeResolvedRef = {
  provider: string;
  modelId: string;
  modelApi?: string;
  harnessId?: string;
  transport?: AgentRuntimeTransport;
};

export type AgentRuntimeAuthPlan = {
  providerForAuth: string;
  authProfileProviderForAuth: string;
  harnessAuthProvider?: string;
  forwardedAuthProfileId?: string;
  forwardedAuthProfileCandidateIds?: string[];
};

export type AgentRuntimePromptPlan = {
  provider: string;
  modelId: string;
  textTransforms?: AgentRuntimeTextTransforms;
  resolveSystemPromptContribution(
    context: AgentRuntimeSystemPromptContributionContext,
  ): AgentRuntimeSystemPromptContribution | undefined;
  transformSystemPrompt(
    context: AgentRuntimeSystemPromptContributionContext & {
      systemPrompt: string;
    },
  ): string;
};

// Keep the leaf runtime-plan contract decoupled from plugin metadata internals.
export type AgentRuntimePreparedMetadataSnapshot = object;

export type PreparedOpenClawToolPlanning = {
  metadataSnapshot?: AgentRuntimePreparedMetadataSnapshot;
  loadMetadataSnapshot?: () => AgentRuntimePreparedMetadataSnapshot;
};

export type AgentRuntimeToolPlan = {
  preparedPlanning?: PreparedOpenClawToolPlanning;
  normalize<TSchemaType extends TSchema = TSchema, TResult = unknown>(
    tools: AgentTool<TSchemaType, TResult>[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    },
  ): AgentTool<TSchemaType, TResult>[];
  logDiagnostics(
    tools: AgentTool[],
    params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    },
  ): void;
};

export type AgentRuntimeDeliveryPlan = {
  isSilentPayload(
    payload: Pick<
      AgentRuntimeReplyPayload,
      "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData"
    >,
  ): boolean;
  resolveFollowupRoute(params: {
    payload: AgentRuntimeReplyPayload;
    originatingChannel?: string;
    originatingTo?: string;
    originRoutable: boolean;
    dispatcherAvailable: boolean;
  }): AgentRuntimeFollowupFallbackRouteResult | undefined;
};

export type AgentRuntimeOutcomePlan = {
  classifyRunResult: AgentRuntimeOutcomeClassifier;
};

export type AgentRuntimeTransportPlan = {
  extraParams: Record<string, unknown>;
  resolveExtraParams(params?: {
    extraParamsOverride?: Record<string, unknown>;
    thinkingLevel?: AgentRuntimeThinkLevel;
    agentId?: string;
    workspaceDir?: string;
    model?: AgentRuntimeModel;
    resolvedTransport?: AgentRuntimeTransport;
  }): Record<string, unknown>;
};

export type AgentRuntimePlan = {
  resolvedRef: AgentRuntimeResolvedRef;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
  auth: AgentRuntimeAuthPlan;
  prompt: AgentRuntimePromptPlan;
  tools: AgentRuntimeToolPlan;
  transcript: {
    policy: AgentRuntimeTranscriptPolicy;
    resolvePolicy(params?: {
      workspaceDir?: string;
      modelApi?: string;
      model?: AgentRuntimeModel;
    }): AgentRuntimeTranscriptPolicy;
  };
  delivery: AgentRuntimeDeliveryPlan;
  outcome: AgentRuntimeOutcomePlan;
  transport: AgentRuntimeTransportPlan;
  observability: {
    resolvedRef: string;
    provider: string;
    modelId: string;
    modelApi?: string;
    harnessId?: string;
    authProfileId?: string;
    transport?: AgentRuntimeTransport;
  };
};

export type BuildAgentRuntimeDeliveryPlanParams = {
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
};

export type BuildAgentRuntimePlanParams = {
  config?: AgentRuntimeConfig;
  workspaceDir?: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  model?: AgentRuntimeModel;
  modelApi?: string | null;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding?: boolean;
  authProfileProvider?: string;
  authProfileMode?: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileCandidateIds?: string[];
  agentId?: string;
  thinkingLevel?: AgentRuntimeThinkLevel;
  extraParamsOverride?: Record<string, unknown>;
  resolvedTransport?: AgentRuntimeTransport;
  providerRuntimeHandle?: AgentRuntimeProviderHandle;
};
