// Coordinates parsed reply directives before get-reply executes commands or agents.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { type ModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  expandExplicitSkillReferences,
  hasSkillReferenceCandidate,
} from "../../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import { markCommandReplyForDelivery } from "../reply-payload.js";
import type {
  FinalizedRuntimeMsgContext,
  FinalizedTemplateContext as TemplateContext,
} from "../templating.js";
import {
  normalizeThinkLevel,
  type ElevatedLevel,
  type FastMode,
  type ReasoningLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveBlockStreamingChunking } from "./block-streaming.js";
import { buildCommandContext } from "./commands-context.js";
import {
  type InlineDirectives,
  resolveNativeReplyDirectiveCommand,
} from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { defaultGroupActivation, resolveGroupRequireMention } from "./groups.js";
import {
  createFastTestModelSelectionState,
  createModelSelectionState,
  resolveContextTokens,
} from "./model-selection.js";
import { formatElevatedUnavailableMessage, resolveElevatedPermissions } from "./reply-elevated.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

const commandsRegistryLoader = createLazyImportLoader(
  () => import("../commands-registry.runtime.js"),
);
const skillCommandsLoader = createLazyImportLoader(
  () => import("../../skills/discovery/chat-commands.runtime.js"),
);

function loadCommandsRegistry() {
  return commandsRegistryLoader.load();
}

function loadSkillCommands() {
  return skillCommandsLoader.load();
}

function canUseFastExplicitModelDirective(params: {
  directives: InlineDirectives;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
}): boolean {
  const raw = normalizeOptionalString(params.directives.rawModelDirective);
  if (!raw || /^[0-9]+$/.test(raw)) {
    return false;
  }
  return Boolean(
    resolveModelRefFromString({
      raw,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    }),
  );
}

type ReplyDirectiveContinuation = {
  commandSource: string;
  command: ReturnType<typeof buildCommandContext>;
  allowTextCommands: boolean;
  skillCommands?: SkillCommandSpec[];
  directives: InlineDirectives;
  cleanedBody: string;
  messageProviderKey: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultActivation: ReturnType<typeof defaultGroupActivation>;
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedFastMode: FastMode;
  resolvedFastModeAutoOnSeconds: number;
  resolvedFastModeOverride: boolean;
  resolvedFastModeAutoOnSecondsOverride: boolean;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ReplyExecOverrides;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  provider: string;
  model: string;
  requestedRouteResolution: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["requestedRouteResolution"];
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  contextTokens: number;
  inlineStatusRequested: boolean;
  directiveAck?: ReplyPayload;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
};

type ReplyDirectiveResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | { kind: "continue"; result: ReplyDirectiveContinuation };

export async function resolveReplyDirectives(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  agentCfg: AgentDefaults;
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof applyInlineDirectiveOverrides>[0]["sessionScope"];
  groupResolution: Parameters<typeof resolveGroupRequireMention>[0]["groupResolution"];
  isGroup: boolean;
  triggerBodyNormalized: string;
  resetTriggered: boolean;
  commandAuthorized: boolean;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  hasResolvedHeartbeatModelOverride: boolean;
  typing: TypingController;
  opts?: GetReplyOptions;
  skillFilter?: string[];
  preparedModelCatalog?: ModelCatalogSnapshot;
}): Promise<ReplyDirectiveResult> {
  const {
    ctx,
    cfg,
    agentId,
    agentCfg,
    agentDir,
    workspaceDir,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    resetTriggered,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    primaryProvider,
    primaryModel,
    provider: initialProvider,
    model: initialModel,
    hasOneTurnModelOverride,
    skipStoredModelOverride,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts,
    skillFilter,
  } = params;
  const agentEntry = listAgentEntries(cfg).find(
    (entry) => normalizeAgentId(entry.id) === normalizeAgentId(agentId),
  );
  const targetSessionEntry = sessionStore[sessionKey] ?? sessionEntry;
  let provider = initialProvider;
  let model = initialModel;

  const commandText = sessionCtx.commandText;
  const command = buildCommandContext({
    ctx,
    cfg,
    agentId,
    sessionKey,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
  });
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: command.surface,
    commandSource: ctx.CommandSource,
  });
  const canInterpretTextDirectives =
    allowTextCommands && command.isAuthorizedSender && ctx.CommandInterpretationSuppressed !== true;
  const commandTextHasSlash = commandText.includes("/");
  const hasConfiguredModelAliases =
    commandTextHasSlash &&
    Object.values(cfg.agents?.defaults?.models ?? {}).some((entry) =>
      Boolean(normalizeOptionalString(entry.alias)),
    );
  const hasSkillReferences =
    canInterpretTextDirectives && hasSkillReferenceCandidate(command.commandBodyNormalized);
  const reservedCommands = new Set<string>();
  if (hasConfiguredModelAliases) {
    const { listChatCommands } = await loadCommandsRegistry();
    for (const chatCommand of listChatCommands()) {
      for (const alias of chatCommand.textAliases) {
        reservedCommands.add(normalizeLowercaseStringOrEmpty(alias.replace(/^\//, "")));
      }
    }
  }

  const rawAliases = hasConfiguredModelAliases
    ? resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash,
        reservedCommands,
      })
    : [];
  const skillCommandContext = {
    workspaceDir,
    cfg,
    agentId,
    sessionEntry: targetSessionEntry,
    sessionKey,
  };

  // Only load workspace skill commands when aliases or explicit skill references need them.
  // This avoids scanning skills for ordinary text, paths, and built-in slash directives.
  const skillCommands =
    canInterpretTextDirectives && (rawAliases.length > 0 || hasSkillReferences)
      ? (await loadSkillCommands()).listSkillCommandsForWorkspace({
          ...skillCommandContext,
          skillFilter,
        })
      : [];
  reserveSkillCommandNames({ reservedCommands, skillCommands });

  const allSkillCommands =
    hasSkillReferences && skillFilter !== undefined
      ? (await loadSkillCommands()).listSkillCommandsForWorkspace({
          ...skillCommandContext,
          includeAllowlistHidden: true,
        })
      : skillCommands;
  const explicitSkillReferences = hasSkillReferences
    ? expandExplicitSkillReferences({
        text: command.commandBodyNormalized,
        skillCommands,
        allSkillCommands,
      })
    : undefined;
  if (explicitSkillReferences?.error) {
    typing.cleanup();
    return {
      kind: "reply",
      reply: markCommandReplyForDelivery({ text: explicitSkillReferences.error }),
    };
  }
  const hasExplicitSkillInvocation = Boolean(explicitSkillReferences?.skills.length);
  const canInterpretMessageDirectives = canInterpretTextDirectives && !hasExplicitSkillInvocation;

  const configuredAliases = rawAliases.filter(
    (alias) => !reservedCommands.has(normalizeLowercaseStringOrEmpty(alias)),
  );
  const commandTurn = resolveCommandTurnContext(ctx);
  const nativeDirectiveCommand =
    command.isAuthorizedSender && isNativeCommandTurn(commandTurn) && commandTurn.commandName
      ? resolveNativeReplyDirectiveCommand(
          (await loadCommandsRegistry()).findCommandByNativeName(
            commandTurn.commandName,
            command.channel,
            {
              includeBundledChannelFallback: false,
            },
          )?.key,
        )
      : undefined;
  const routedDirectives = resolveReplyDirectiveRouting({
    commandText,
    agentText: sessionCtx.agentText,
    modelAliases: configuredAliases,
    nativeCommand: nativeDirectiveCommand,
    canInterpretTextDirectives: canInterpretMessageDirectives,
    isAuthorizedSender: command.isAuthorizedSender,
    isGroup,
    wasMentioned: ctx.WasMentioned === true,
    ctx,
    cfg,
    agentId,
    resetTriggered,
  });
  let { directives } = routedDirectives;
  const { cleanedBody, hasInlineStatus, unauthorizedReasoningDirectiveAttempt } = routedDirectives;

  sessionCtx.agentText = cleanedBody;
  sessionCtx.BodyForAgent = cleanedBody;
  sessionCtx.Body = cleanedBody;
  sessionCtx.BodyStripped = cleanedBody;

  const messageProviderKey = normalizeOptionalString(sessionCtx.Provider)
    ? normalizeLowercaseStringOrEmpty(sessionCtx.Provider)
    : normalizeOptionalString(ctx.Provider)
      ? normalizeLowercaseStringOrEmpty(ctx.Provider)
      : "";
  const elevated = resolveElevatedPermissions({
    cfg,
    agentId,
    ctx,
    provider: messageProviderKey,
  });
  const elevatedEnabled = elevated.enabled;
  const elevatedAllowed = elevated.allowed;
  const elevatedFailures = elevated.failures;
  if (directives.hasElevatedDirective && (!elevatedEnabled || !elevatedAllowed)) {
    typing.cleanup();
    const runtimeSandboxed = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: resolveRuntimePolicySessionKey({
        agentId,
        cfg,
        ctx,
        sessionKey: ctx.SessionKey,
      }),
    }).sandboxed;
    return {
      kind: "reply",
      reply: {
        text: formatElevatedUnavailableMessage({
          runtimeSandboxed,
          failures: elevatedFailures,
          sessionKey: ctx.SessionKey,
        }),
      },
    };
  }

  const requireMention = await resolveGroupRequireMention({
    cfg,
    ctx: sessionCtx,
    groupResolution,
  });
  const defaultActivation = defaultGroupActivation(requireMention);
  const sessionThinkLevel = directives.clearThinkLevel
    ? undefined
    : (targetSessionEntry?.thinkingLevel as ThinkLevel | undefined);
  const thinkingLevelOverride = normalizeThinkLevel(opts?.thinkingLevelOverride);
  const configuredThinkingDefault =
    normalizeThinkLevel(agentEntry?.thinkingDefault) ??
    normalizeThinkLevel(agentCfg?.thinkingDefault);
  const resolvedThinkLevel = thinkingLevelOverride ?? directives.thinkLevel ?? sessionThinkLevel;

  const resolvedVerboseLevel =
    directives.verboseLevel ??
    (targetSessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);
  const configuredReasoningDefault =
    (agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
    (agentCfg?.reasoningDefault as ReasoningLevel | undefined);
  const canUseReasoningState =
    command.isAuthorizedSender ||
    command.senderIsOwner ||
    (Array.isArray(ctx.GatewayClientScopes) && ctx.GatewayClientScopes.includes("operator.admin"));
  const rawSessionReasoningLevel = targetSessionEntry?.reasoningLevel as
    | ReasoningLevel
    | null
    | undefined;
  const sessionReasoningLevel = canUseReasoningState ? rawSessionReasoningLevel : undefined;
  const blockedSessionReasoningLevel =
    rawSessionReasoningLevel !== undefined &&
    rawSessionReasoningLevel !== null &&
    !canUseReasoningState;
  const reasoningUsesConfiguredDefault =
    directives.reasoningLevel === undefined &&
    sessionReasoningLevel == null &&
    configuredReasoningDefault != null;
  let resolvedReasoningLevel: ReasoningLevel =
    directives.reasoningLevel ?? sessionReasoningLevel ?? configuredReasoningDefault ?? "off";
  if (reasoningUsesConfiguredDefault && !canUseReasoningState) {
    resolvedReasoningLevel = "off";
  }
  const resolvedElevatedLevel = elevatedAllowed
    ? (directives.elevatedLevel ??
      (targetSessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      "on")
    : "off";
  const blockStreamingEnabled =
    opts?.disableBlockStreaming === false ||
    (opts?.disableBlockStreaming !== true && agentCfg?.blockStreamingDefault === "on");
  // Off-mode text blocks are suppressed by delivery; keep captions until media is parsed.
  const resolvedBlockStreamingBreak: "text_end" | "message_end" =
    !blockStreamingEnabled || agentCfg?.blockStreamingBreak === "message_end"
      ? "message_end"
      : "text_end";
  const blockReplyChunking = blockStreamingEnabled
    ? resolveBlockStreamingChunking(cfg, sessionCtx.Provider, sessionCtx.AccountId)
    : undefined;
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: isFastTestRuntimeEnv(),
  });

  const useFastModelSelection =
    useFastReplyRuntime &&
    !hasResolvedHeartbeatModelOverride &&
    !(agentCfg?.models && Object.keys(agentCfg.models).length > 0) &&
    !normalizeOptionalString(targetSessionEntry?.modelOverride) &&
    !normalizeOptionalString(targetSessionEntry?.providerOverride) &&
    (!directives.hasModelDirective ||
      canUseFastExplicitModelDirective({
        directives,
        defaultProvider,
        aliasIndex: params.aliasIndex,
      }));

  let modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  try {
    modelState = useFastModelSelection
      ? createFastTestModelSelectionState({
          agentCfg,
          provider,
          model,
        })
      : await createModelSelectionState({
          cfg,
          agentId,
          agentCfg,
          sessionEntry: targetSessionEntry,
          sessionStore,
          sessionKey,
          parentSessionKey:
            targetSessionEntry?.parentSessionKey ??
            ctx.ModelParentSessionKey ??
            ctx.ParentSessionKey,
          storePath,
          defaultProvider,
          defaultModel,
          primaryProvider,
          primaryModel,
          provider,
          model,
          hasModelDirective: directives.hasModelDirective,
          hasOneTurnModelOverride,
          skipStoredModelOverride,
          hasResolvedHeartbeatModelOverride,
          isHeartbeat: opts?.isHeartbeat === true,
          preparedModelCatalog: params.preparedModelCatalog,
        });
  } catch (error) {
    if (error instanceof ModelSelectionLockedError) {
      typing.cleanup();
      return { kind: "reply", reply: { text: error.message, isError: true } };
    }
    if (!isSessionWorkStartInvalidatedError(error)) {
      throw error;
    }
    typing.cleanup();
    return { kind: "reply", reply: { text: error.message, isError: true } };
  }
  provider = modelState.provider;
  model = modelState.model;

  let contextTokens = useFastReplyRuntime
    ? DEFAULT_CONTEXT_TOKENS
    : resolveContextTokens({
        cfg,
        provider,
        model,
        modelContextWindow: modelState.modelContextWindow,
        modelContextTokens: modelState.modelContextTokens,
      });

  const initialModelLabel = `${provider}/${model}`;
  const formatModelSwitchEvent = (label: string, alias?: string) =>
    alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
  const isModelInfoDirective =
    directives.hasModelDirective &&
    directives.modelDirectiveSource !== "alias" &&
    ["status", "list"].includes(
      normalizeLowercaseStringOrEmpty(normalizeOptionalString(directives.rawModelDirective)),
    );
  const effectiveModelDirective = isModelInfoDirective ? undefined : directives.rawModelDirective;

  const inlineStatusRequested = hasInlineStatus && canInterpretMessageDirectives;

  const applyResult = await applyInlineDirectiveOverrides({
    ctx,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    agentEntry,
    sessionEntry: targetSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    isGroup,
    allowTextCommands,
    command,
    directives,
    messageProviderKey,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultProvider,
    defaultModel,
    aliasIndex: params.aliasIndex,
    provider,
    model,
    modelState,
    initialModelLabel,
    formatModelSwitchEvent,
    resolvedElevatedLevel,
    defaultActivation: () => defaultActivation,
    contextTokens,
    effectiveModelDirective,
    typing,
  });
  if (applyResult.kind === "reply") {
    return { kind: "reply", reply: markCommandReplyForDelivery(applyResult.reply) };
  }
  directives = applyResult.directives;
  provider = applyResult.provider;
  model = applyResult.model;
  contextTokens = applyResult.contextTokens;
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider,
    modelId: model,
    agentId,
    sessionKey: resolveRuntimePolicySessionKey({ agentId, cfg, ctx, sessionKey }),
    sessionEntry: targetSessionEntry,
  });
  const resolvedThinkLevelWithDefault =
    resolvedThinkLevel ??
    (await modelState.resolveDefaultThinkingLevel({
      provider,
      model,
      agentRuntime: thinkingRuntime,
    })) ??
    configuredThinkingDefault;

  const thinkingExplicitlySet =
    thinkingLevelOverride !== undefined ||
    directives.thinkLevel !== undefined ||
    sessionThinkLevel !== undefined ||
    configuredThinkingDefault !== undefined ||
    modelState.hasConfiguredThinkingDefault === true;

  // When neither directive nor session nor agent set reasoning, default to model capability
  // (e.g. OpenRouter with reasoning: true). Skip model default when thinking is active
  // or when thinking was explicitly disabled.
  const hasAgentReasoningDefault =
    (agentEntry?.reasoningDefault !== undefined && agentEntry?.reasoningDefault !== null) ||
    (agentCfg?.reasoningDefault !== undefined && agentCfg?.reasoningDefault !== null);
  const reasoningExplicitlySet =
    directives.reasoningLevel !== undefined ||
    unauthorizedReasoningDirectiveAttempt ||
    blockedSessionReasoningLevel ||
    (sessionReasoningLevel !== undefined && sessionReasoningLevel !== null) ||
    hasAgentReasoningDefault;
  const thinkingActive = resolvedThinkLevelWithDefault !== "off";
  if (
    !reasoningExplicitlySet &&
    resolvedReasoningLevel === "off" &&
    !thinkingActive &&
    !thinkingExplicitlySet
  ) {
    resolvedReasoningLevel = await modelState.resolveDefaultReasoningLevel();
  }
  const { directiveAck, perMessageQueueMode, perMessageQueueOptions } = applyResult;
  const resolvedFastModeState = resolveFastModeState({
    cfg,
    provider,
    model,
    agentId,
    sessionEntry: directives.clearFastMode ? undefined : targetSessionEntry,
  });
  const resolvedFastMode =
    opts?.fastModeOverride ?? directives.fastMode ?? resolvedFastModeState.mode;
  const resolvedFastModeAutoOnSeconds =
    opts?.fastModeAutoOnSecondsOverride ?? resolvedFastModeState.fastAutoOnSeconds;
  const resolvedFastModeOverride =
    opts?.fastModeOverride !== undefined || directives.fastMode !== undefined;
  const resolvedFastModeAutoOnSecondsOverride = opts?.fastModeAutoOnSecondsOverride !== undefined;
  const execOverrides = resolveReplyExecOverrides({
    directives,
    sessionEntry: targetSessionEntry,
    agentExecDefaults: agentEntry?.tools?.exec,
  });

  return {
    kind: "continue",
    result: {
      commandSource: commandText,
      command,
      allowTextCommands,
      skillCommands,
      directives,
      cleanedBody,
      messageProviderKey,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      defaultActivation,
      resolvedThinkLevel: resolvedThinkLevelWithDefault,
      resolvedFastMode,
      resolvedFastModeAutoOnSeconds,
      resolvedFastModeOverride,
      resolvedFastModeAutoOnSecondsOverride,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      execOverrides,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      provider,
      model,
      requestedRouteResolution: effectiveModelDirective
        ? "resolved"
        : modelState.requestedRouteResolution,
      modelState,
      contextTokens,
      inlineStatusRequested,
      directiveAck,
      perMessageQueueMode,
      perMessageQueueOptions,
    },
  };
}
