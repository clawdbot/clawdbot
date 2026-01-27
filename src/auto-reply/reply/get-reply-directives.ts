import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { listChatCommands, shouldHandleTextCommands } from "../commands-registry.js";
import { listSkillCommandsForWorkspace } from "../skill-commands.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveBlockStreamingChunking } from "./block-streaming.js";
import { buildCommandContext } from "./commands.js";
import { type InlineDirectives, parseInlineDirectives } from "./directive-handling.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { defaultGroupActivation, resolveGroupRequireMention } from "./groups.js";
import { CURRENT_MESSAGE_MARKER, stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { createModelSelectionState, resolveContextTokens } from "./model-selection.js";
import { formatElevatedUnavailableMessage, resolveElevatedPermissions } from "./reply-elevated.js";
import { stripInlineStatus } from "./reply-inline.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<MoltbotConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

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
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
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

function resolveExecOverrides(params: {
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
}): ExecOverrides | undefined {
  const host =
    params.directives.execHost ?? (params.sessionEntry?.execHost as ExecOverrides["host"]);
  const security =
    params.directives.execSecurity ??
    (params.sessionEntry?.execSecurity as ExecOverrides["security"]);
  const ask = params.directives.execAsk ?? (params.sessionEntry?.execAsk as ExecOverrides["ask"]);
  const node = params.directives.execNode ?? params.sessionEntry?.execNode;
  if (!host && !security && !ask && !node) return undefined;
  return { host, security, ask, node };
}

export type ReplyDirectiveResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | { kind: "continue"; result: ReplyDirectiveContinuation };

export async function resolveReplyDirectives(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
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
  commandAuthorized: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
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
    commandAuthorized,
    defaultProvider,
    defaultModel,
    provider: initialProvider,
    model: initialModel,
    typing,
    opts,
    skillFilter,
  } = params;
  let provider = initialProvider;
  let model = initialModel;

  // Prefer CommandBody/RawBody (clean message without structural context) for directive parsing.
  // Keep `Body`/`BodyStripped` as the best-available prompt text (may include context).
  const commandSource =
    sessionCtx.BodyForCommands ??
    sessionCtx.CommandBody ??
    sessionCtx.RawBody ??
    sessionCtx.Transcript ??
    sessionCtx.BodyStripped ??
    sessionCtx.Body ??
    ctx.BodyForCommands ??
    ctx.CommandBody ??
    ctx.RawBody ??
    "";
  const promptSource = sessionCtx.BodyForAgent ?? sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const commandText = commandSource || promptSource;
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
  const shouldResolveSkillCommands =
    allowTextCommands && command.commandBodyNormalized.includes("/");
  const skillCommands = shouldResolveSkillCommands
    ? listSkillCommandsForWorkspace({
        workspaceDir,
        cfg,
        skillFilter,
      })
    : [];
  const reservedCommands = new Set(
    listChatCommands().flatMap((cmd) =>
      cmd.textAliases.map((a) => a.replace(/^\//, "").toLowerCase()),
    ),
  );
  for (const command of skillCommands) {
    reservedCommands.add(command.name.toLowerCase());
  }
  const configuredAliases = Object.values(cfg.agents?.defaults?.models ?? {})
    .map((entry) => entry.alias?.trim())
    .filter((alias): alias is string => Boolean(alias))
    .filter((alias) => !reservedCommands.has(alias.toLowerCase()));
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
      parsedDirectives = {
        ...parsedDirectives,
        hasExecDirective: false,
        execHost: undefined,
        execSecurity: undefined,
        execAsk: undefined,
        execNode: undefined,
        rawExecHost: undefined,
        rawExecSecurity: undefined,
        rawExecAsk: undefined,
        rawExecNode: undefined,
        hasExecOptions: false,
        invalidExecHost: false,
        invalidExecSecurity: false,
        invalidExecAsk: false,
        invalidExecNode: false,
      };
    }
  }
  const hasInlineDirective =
    parsedDirectives.hasThinkDirective ||
    parsedDirectives.hasVerboseDirective ||
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
  let directives = commandAuthorized
    ? parsedDirectives
    : {
        ...parsedDirectives,
        hasThinkDirective: false,
        hasVerboseDirective: false,
        hasReasoningDirective: false,
        hasStatusDirective: false,
        hasModelDirective: false,
        hasQueueDirective: false,
        queueReset: false,
      };
  const existingBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  let cleanedBody = (() => {
    if (!existingBody) return parsedDirectives.cleaned;
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

  const messageProviderKey =
    sessionCtx.Provider?.trim().toLowerCase() ?? ctx.Provider?.trim().toLowerCase() ?? "";
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
      sessionKey: ctx.SessionKey,
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

  const requireMention = resolveGroupRequireMention({
    cfg,
    ctx: sessionCtx,
    groupResolution,
  });
  const defaultActivation = defaultGroupActivation(requireMention);
  const resolvedThinkLevel =
    (directives.thinkLevel as ThinkLevel | undefined) ??
    (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (agentCfg?.thinkingDefault as ThinkLevel | undefined);

  const resolvedVerboseLevel =
    (directives.verboseLevel as VerboseLevel | undefined) ??
    (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);
  const resolvedReasoningLevel: ReasoningLevel =
    (directives.reasoningLevel as ReasoningLevel | undefined) ??
    (sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
    "off";
  const resolvedElevatedLevel = elevatedAllowed
    ? ((directives.elevatedLevel as ElevatedLevel | undefined) ??
      (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
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

  const modelState = await createModelSelectionState({
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey: ctx.ParentSessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    provider,
    model,
    hasModelDirective: directives.hasModelDirective,
  });
  provider = modelState.provider;
  model = modelState.model;

  let contextTokens = resolveContextTokens({
    agentCfg,
    model,
  });

  const initialModelLabel = `${provider}/${model}`;
  const formatModelSwitchEvent = (label: string, alias?: string) =>
    alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
  const isModelListAlias =
    directives.hasModelDirective &&
    ["status", "list"].includes(directives.rawModelDirective?.trim().toLowerCase() ?? "");
  const effectiveModelDirective = isModelListAlias ? undefined : directives.rawModelDirective;

  const inlineStatusRequested = hasInlineStatus && allowTextCommands && command.isAuthorizedSender;

  const applyResult = await applyInlineDirectiveOverrides({
    ctx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionEntry,
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
  const execOverrides = resolveExecOverrides({ directives, sessionEntry });

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
      resolvedThinkLevel,
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
