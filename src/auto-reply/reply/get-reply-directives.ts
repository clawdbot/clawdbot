import { listAgentEntries } from "../../agents/agent-scope.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { type ModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveBlockStreamingChunking } from "./block-streaming.js";
import { buildCommandContext } from "./commands-context.js";
import { type InlineDirectives, parseInlineDirectives } from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { clearExecInlineDirectives, clearInlineDirectives } from "./get-reply-directives-utils.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { defaultGroupActivation, resolveGroupRequireMention } from "./groups.js";
import { CURRENT_MESSAGE_MARKER, stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  createFastTestModelSelectionState,
  createModelSelectionState,
  resolveContextTokens,
} from "./model-selection.js";
import { formatElevatedUnavailableMessage, resolveElevatedPermissions } from "./reply-elevated.js";
import { stripInlineStatus } from "./reply-inline.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

const commandsRegistryLoader = createLazyImportLoader(
  () => import("../commands-registry.runtime.js"),
);
const skillCommandsLoader = createLazyImportLoader(() => import("../skill-commands.runtime.js"));

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

function resolveDirectiveCommandText(params: { ctx: MsgContext; sessionCtx: TemplateContext }) {
  const commandSource =
    params.sessionCtx.BodyForCommands ??
    params.sessionCtx.CommandBody ??
    params.sessionCtx.RawBody ??
    params.sessionCtx.Transcript ??
    params.sessionCtx.BodyStripped ??
    params.sessionCtx.Body ??
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    "";
  const promptSource =
    params.sessionCtx.BodyForAgent ??
    params.sessionCtx.BodyStripped ??
    params.sessionCtx.Body ??
    "";
  return {
    commandSource,
    promptSource,
    commandText: commandSource || promptSource,
  };
}

export type ReplyDirectiveContinuation = {
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
  resolvedFastMode: boolean;
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

export type ReplyDirectiveResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | { kind: "continue"; result: ReplyDirectiveContinuation };

export async function resolveReplyDirectives(params: {
  ctx: MsgContext;
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
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  hasResolvedHeartbeatModelOverride: boolean;
  typing: TypingController;
  opts?: GetReplyOptions;
  skillFilter?: string[];
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
    provider: initialProvider,
    model: initialModel,
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

  // Prefer CommandBody/RawBody (clean message without structural context) for directive parsing.
  // Keep `Body`/`BodyStripped` as the best-available prompt text (may include context).
  const { commandText } = resolveDirectiveCommandText({
    ctx,
    sessionCtx,
  });
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
  const commandTextHasSlash = commandText.includes("/");
  const hasConfiguredModelAliases =
    commandTextHasSlash &&
    Object.values(cfg.agents?.defaults?.models ?? {}).some((entry) =>
      Boolean(normalizeOptionalString(entry.alias)),
    );
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

  // Only load workspace skill commands when we actually need them to filter aliases.
  // This avoids scanning skills for messages that only use plain text with no slash syntax.
  const skillCommands =
    allowTextCommands && commandTextHasSlash && rawAliases.length > 0
      ? (await loadSkillCommands()).listSkillCommandsForWorkspace({
          workspaceDir,
          cfg,
          agentId,
          skillFilter,
        })
      : [];
  reserveSkillCommandNames({ reservedCommands, skillCommands });

  const configuredAliases = rawAliases.filter(
    (alias) => !reservedCommands.has(normalizeLowercaseStringOrEmpty(alias)),
  );
  const allowStatusDirective = allowTextCommands && command.isAuthorizedSender;
  let parsedDirectives = parseInlineDirectives(commandText, {
    modelAliases: configuredAliases,
    allowStatusDirective,
  });
  const hasInlineStatus =
    parsedDirectives.hasStatusDirective && parsedDirectives.cleaned.trim().length > 0;
  if (hasInlineStatus) {
    parsedDirectives = {
      ...parsedDirectives,
      hasStatusDirective: false,
    };
  }
  if (isGroup && ctx.WasMentioned !== true && parsedDirectives.hasElevatedDirective) {
    if (parsedDirectives.elevatedLevel !== "off") {
      parsedDirectives = {
        ...parsedDirectives,
        hasElevatedDirective: false,
        elevatedLevel: undefined,
        rawElevatedLevel: undefined,
      };
    }
  }
  if (isGroup && ctx.WasMentioned !== true && parsedDirectives.hasExecDirective) {
    if (parsedDirectives.execSecurity !== "deny") {
      parsedDirectives = clearExecInlineDirectives(parsedDirectives);
    }
  }
  const hasInlineDirective =
    parsedDirectives.hasThinkDirective ||
    parsedDirectives.hasVerboseDirective ||
    parsedDirectives.hasTraceDirective ||
    parsedDirectives.hasFastDirective ||
    parsedDirectives.hasReasoningDirective ||
    parsedDirectives.hasElevatedDirective ||
    parsedDirectives.hasExecDirective ||
    parsedDirectives.hasModelDirective ||
    parsedDirectives.hasQueueDirective;
  if (hasInlineDirective) {
    const stripped = stripStructuralPrefixes(parsedDirectives.cleaned);
    const noMentions = isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped;
    if (noMentions.trim().length > 0) {
      const directiveOnlyCheck = parseInlineDirectives(noMentions, {
        modelAliases: configuredAliases,
      });
      if (directiveOnlyCheck.cleaned.trim().length > 0) {
        const allowInlineStatus =
          parsedDirectives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender;
        parsedDirectives = allowInlineStatus
          ? {
              ...clearInlineDirectives(parsedDirectives.cleaned),
              hasStatusDirective: true,
            }
          : clearInlineDirectives(parsedDirectives.cleaned);
      }
    }
  }
  // Use command.isAuthorizedSender (resolved authorization) instead of raw commandAuthorized
  // to ensure inline directives work when commands.allowFrom grants access (e.g., LINE).
  const unauthorizedReasoningDirectiveAttempt =
    !command.isAuthorizedSender && parsedDirectives.hasReasoningDirective;
  let directives = command.isAuthorizedSender
    ? parsedDirectives
    : {
        ...parsedDirectives,
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasFastDirective: false,
        hasReasoningDirective: false,
        reasoningLevel: undefined,
        rawReasoningLevel: undefined,
        hasStatusDirective: false,
        hasModelDirective: false,
        hasQueueDirective: false,
        queueReset: false,
      };
  const existingBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  let cleanedBody = (() => {
    if (!existingBody) {
      if (resetTriggered) {
        return "";
      }
      return parsedDirectives.cleaned;
    }
    if (!sessionCtx.CommandBody && !sessionCtx.RawBody) {
      return parseInlineDirectives(existingBody, {
        modelAliases: configuredAliases,
        allowStatusDirective,
      }).cleaned;
    }

    const markerIndex = existingBody.indexOf(CURRENT_MESSAGE_MARKER);
    if (markerIndex < 0) {
      return parseInlineDirectives(existingBody, {
        modelAliases: configuredAliases,
        allowStatusDirective,
      }).cleaned;
    }

    const head = existingBody.slice(0, markerIndex + CURRENT_MESSAGE_MARKER.length);
    const tail = existingBody.slice(markerIndex + CURRENT_MESSAGE_MARKER.length);
    const cleanedTail = parseInlineDirectives(tail, {
      modelAliases: configuredAliases,
      allowStatusDirective,
    }).cleaned;
    return `${head}${cleanedTail}`;
  })();

  if (allowStatusDirective) {
    cleanedBody = stripInlineStatus(cleanedBody).cleaned;
  }

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
      sessionKey: resolveRuntimePolicySessionKey({ cfg, ctx, sessionKey: ctx.SessionKey }),
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
  const resolvedThinkLevel =
    directives.thinkLevel ?? (targetSessionEntry?.thinkingLevel as ThinkLevel | undefined);
  const resolvedFastMode =
    directives.fastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      agentId,
      sessionEntry: targetSessionEntry,
    }).enabled;

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
  const resolvedBlockStreaming =
    opts?.disableBlockStreaming === true
      ? "off"
      : opts?.disableBlockStreaming === false
        ? "on"
        : agentCfg?.blockStreamingDefault === "on"
          ? "on"
          : "off";
  const resolvedBlockStreamingBreak: "text_end" | "message_end" =
    agentCfg?.blockStreamingBreak === "message_end" ? "message_end" : "text_end";
  const blockStreamingEnabled =
    resolvedBlockStreaming === "on" && opts?.disableBlockStreaming !== true;
  const blockReplyChunking = blockStreamingEnabled
    ? resolveBlockStreamingChunking(cfg, sessionCtx.Provider, sessionCtx.AccountId)
    : undefined;
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: process.env.OPENCLAW_TEST_FAST === "1",
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

  const modelState = useFastModelSelection
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
          targetSessionEntry?.parentSessionKey ?? ctx.ModelParentSessionKey ?? ctx.ParentSessionKey,
        storePath,
        defaultProvider,
        defaultModel,
        provider,
        model,
        hasModelDirective: directives.hasModelDirective,
        hasResolvedHeartbeatModelOverride,
      });
  provider = modelState.provider;
  model = modelState.model;
  const resolvedThinkLevelWithDefault =
    resolvedThinkLevel ??
    (await modelState.resolveDefaultThinkingLevel()) ??
    (agentCfg?.thinkingDefault as ThinkLevel | undefined);

  const thinkingExplicitlySet =
    directives.thinkLevel !== undefined ||
    targetSessionEntry?.thinkingLevel !== undefined ||
    agentCfg?.thinkingDefault !== undefined;

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

  let contextTokens = useFastReplyRuntime
    ? (agentCfg?.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
    : resolveContextTokens({
        cfg,
        agentCfg,
        provider,
        model,
      });

  const initialModelLabel = `${provider}/${model}`;
  const formatModelSwitchEvent = (label: string, alias?: string) =>
    alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
  const isModelListAlias =
    directives.hasModelDirective &&
    ["status", "list"].includes(
      normalizeLowercaseStringOrEmpty(normalizeOptionalString(directives.rawModelDirective)),
    );
  const effectiveModelDirective = isModelListAlias ? undefined : directives.rawModelDirective;

  const inlineStatusRequested = hasInlineStatus && allowTextCommands && command.isAuthorizedSender;

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
    return { kind: "reply", reply: applyResult.reply };
  }
  directives = applyResult.directives;
  provider = applyResult.provider;
  model = applyResult.model;
  contextTokens = applyResult.contextTokens;
  const { directiveAck, perMessageQueueMode, perMessageQueueOptions } = applyResult;
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
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      execOverrides,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      provider,
      model,
      modelState,
      contextTokens,
      inlineStatusRequested,
      directiveAck,
      perMessageQueueMode,
      perMessageQueueOptions,
    },
  };
}
