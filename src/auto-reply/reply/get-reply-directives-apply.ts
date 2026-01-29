import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { buildStatusReply } from "./commands.js";
import {
  applyInlineDirectivesFastLane,
  handleDirectiveOnly,
  type InlineDirectives,
  isDirectiveOnly,
  persistInlineDirectives,
} from "./directive-handling.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<MoltbotConfig["agents"]>["defaults"];

export type ApplyDirectiveResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      provider: string;
      model: string;
      contextTokens: number;
      directiveAck?: ReplyPayload;
      perMessageQueueMode?: InlineDirectives["queueMode"];
      perMessageQueueOptions?: {
        debounceMs?: number;
        cap?: number;
        dropPolicy?: InlineDirectives["dropPolicy"];
      };
    };

export async function applyInlineDirectiveOverrides(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  agentThinkingDefault?: ThinkLevel;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
  isGroup: boolean;
  allowTextCommands: boolean;
  command: Parameters<typeof buildStatusReply>[0]["command"];
  directives: InlineDirectives;
  messageProviderKey: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: Parameters<typeof applyInlineDirectivesFastLane>[0]["aliasIndex"];
  provider: string;
  model: string;
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  resolvedElevatedLevel: ElevatedLevel;
  defaultActivation: () => ReturnType<
    Parameters<typeof buildStatusReply>[0]["defaultGroupActivation"]
  >;
  contextTokens: number;
  effectiveModelDirective?: string;
  typing: TypingController;
}): Promise<ApplyDirectiveResult> {
  const {
    ctx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    agentThinkingDefault,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    isGroup,
    allowTextCommands,
    command,
    messageProviderKey,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultProvider,
    defaultModel,
    aliasIndex,
    modelState,
    initialModelLabel,
    formatModelSwitchEvent,
    resolvedElevatedLevel,
    defaultActivation,
    typing,
    effectiveModelDirective,
  } = params;
  let { directives } = params;
  let { provider, model } = params;
  let { contextTokens } = params;

  let directiveAck: ReplyPayload | undefined;

  if (!command.isAuthorizedSender) {
    directives = {
      ...directives,
      hasThinkDirective: false,
      hasVerboseDirective: false,
      hasReasoningDirective: false,
      hasElevatedDirective: false,
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
      hasStatusDirective: false,
      hasModelDirective: false,
      hasQueueDirective: false,
      queueReset: false,
    };
  }

  if (
    isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    })
  ) {
    if (!command.isAuthorizedSender) {
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }
    const resolvedDefaultThinkLevel =
      (sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
      agentThinkingDefault ??
      (agentCfg?.thinkingDefault as ThinkLevel | undefined) ??
      (await modelState.resolveDefaultThinkingLevel());
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const currentVerboseLevel =
      (sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
      (agentCfg?.verboseDefault as VerboseLevel | undefined);
    const currentReasoningLevel =
      (sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    const currentElevatedLevel =
      (sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined);
    const directiveReply = await handleDirectiveOnly({
      cfg,
      directives,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      messageProviderKey,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys: modelState.allowedModelKeys,
      allowedModelCatalog: modelState.allowedModelCatalog,
      resetModelOverride: modelState.resetModelOverride,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      currentThinkLevel,
      currentVerboseLevel,
      currentReasoningLevel,
      currentElevatedLevel,
    });
    let statusReply: ReplyPayload | undefined;
    if (directives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender) {
      statusReply = await buildStatusReply({
        cfg,
        command,
        sessionEntry,
        sessionKey,
        sessionScope,
        provider,
        model,
        contextTokens,
        resolvedThinkLevel: resolvedDefaultThinkLevel,
        resolvedVerboseLevel: (currentVerboseLevel ?? "off") as VerboseLevel,
        resolvedReasoningLevel: (currentReasoningLevel ?? "off") as ReasoningLevel,
        resolvedElevatedLevel,
        resolveDefaultThinkingLevel: async () => resolvedDefaultThinkLevel,
        isGroup,
        defaultGroupActivation: defaultActivation,
        mediaDecisions: ctx.MediaUnderstandingDecisions,
      });
    }
    typing.cleanup();
    if (statusReply?.text && directiveReply?.text) {
      return {
        kind: "reply",
        reply: { text: `${directiveReply.text}\n${statusReply.text}` },
      };
    }
    return { kind: "reply", reply: statusReply ?? directiveReply };
  }

  const hasAnyDirective =
    directives.hasThinkDirective ||
    directives.hasVerboseDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasExecDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective ||
    directives.hasStatusDirective;

  if (hasAnyDirective && command.isAuthorizedSender) {
    const fastLane = await applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: command.isAuthorizedSender,
      ctx,
      cfg,
      agentId,
      isGroup,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      messageProviderKey,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys: modelState.allowedModelKeys,
      allowedModelCatalog: modelState.allowedModelCatalog,
      resetModelOverride: modelState.resetModelOverride,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      agentCfg,
      modelState: {
        resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
        allowedModelKeys: modelState.allowedModelKeys,
        allowedModelCatalog: modelState.allowedModelCatalog,
        resetModelOverride: modelState.resetModelOverride,
      },
    });
    directiveAck = fastLane.directiveAck;
    provider = fastLane.provider;
    model = fastLane.model;
  }

  const persisted = await persistInlineDirectives({
    directives,
    effectiveModelDirective,
    cfg,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys: modelState.allowedModelKeys,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    agentCfg,
  });
  provider = persisted.provider;
  model = persisted.model;
  contextTokens = persisted.contextTokens;

  const perMessageQueueMode =
    directives.hasQueueDirective && !directives.queueReset ? directives.queueMode : undefined;
  const perMessageQueueOptions =
    directives.hasQueueDirective && !directives.queueReset
      ? {
          debounceMs: directives.debounceMs,
          cap: directives.cap,
          dropPolicy: directives.dropPolicy,
        }
      : undefined;

  return {
    kind: "continue",
    directives,
    provider,
    model,
    contextTokens,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  };
}
