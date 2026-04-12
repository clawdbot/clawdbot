import type { SessionEntry, SessionScope } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import type { ApplyInlineDirectivesFastLaneParams } from "./directive-handling.params.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

let commandsStatusPromise: Promise<typeof import("./commands-status.runtime.js")> | null = null;
let directiveLevelsPromise: Promise<typeof import("./directive-handling.levels.js")> | null = null;
let directiveImplPromise: Promise<typeof import("./directive-handling.impl.js")> | null = null;
let directiveFastLanePromise: Promise<typeof import("./directive-handling.fast-lane.js")> | null =
  null;
let directivePersistPromise: Promise<
  typeof import("./directive-handling.persist.runtime.js")
> | null = null;

function loadCommandsStatus() {
  commandsStatusPromise ??= import("./commands-status.runtime.js");
  return commandsStatusPromise;
}

function loadDirectiveLevels() {
  directiveLevelsPromise ??= import("./directive-handling.levels.js");
  return directiveLevelsPromise;
}

function loadDirectiveImpl() {
  directiveImplPromise ??= import("./directive-handling.impl.js");
  return directiveImplPromise;
}

function loadDirectiveFastLane() {
  directiveFastLanePromise ??= import("./directive-handling.fast-lane.js");
  return directiveFastLanePromise;
}

function loadDirectivePersist() {
  directivePersistPromise ??= import("./directive-handling.persist.runtime.js");
  return directivePersistPromise;
}

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
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  agentEntry?: AgentEntry;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: SessionScope | undefined;
  isGroup: boolean;
  allowTextCommands: boolean;
  command: CommandContext;
  directives: InlineDirectives;
  messageProviderKey: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ApplyInlineDirectivesFastLaneParams["aliasIndex"];
  provider: string;
  model: string;
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  resolvedElevatedLevel: ElevatedLevel;
  defaultActivation: () => "always" | "mention";
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
    agentEntry,
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
  const directiveModelState = {
    allowedModelKeys: modelState.allowedModelKeys,
    allowedModelCatalog: modelState.allowedModelCatalog,
    resetModelOverride: modelState.resetModelOverride,
  };
  const createDirectiveHandlingBase = () => ({
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
    ...directiveModelState,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
  });

  let directiveAck: ReplyPayload | undefined;

  if (modelState.resetModelOverride) {
    enqueueSystemEvent(
      `Model override not allowed for this agent; reverted to ${initialModelLabel}.`,
      {
        sessionKey,
        contextKey: `model:reset:${initialModelLabel}`,
      },
    );
  }

  if (!command.isAuthorizedSender) {
    directives = clearInlineDirectives(directives.cleaned);
  }

  const hasAnyDirective =
    directives.hasThinkDirective ||
    directives.hasFastDirective ||
    directives.hasVerboseDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasExecDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective ||
    directives.hasStatusDirective;

  if (!hasAnyDirective && !modelState.resetModelOverride) {
    return {
      kind: "continue",
      directives,
      provider,
      model,
      contextTokens,
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
    const {
      currentThinkLevel: resolvedDefaultThinkLevel,
      currentFastMode,
      currentVerboseLevel,
      currentReasoningLevel,
      currentElevatedLevel,
    } = await (
      await loadDirectiveLevels()
    ).resolveCurrentDirectiveLevels({
      sessionEntry,
      agentEntry,
      agentCfg,
      resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
    });
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const directiveReply = await (
      await loadDirectiveImpl()
    ).handleDirectiveOnly({
      ...createDirectiveHandlingBase(),
      currentThinkLevel,
      currentFastMode,
      currentVerboseLevel,
      currentReasoningLevel,
      currentElevatedLevel,
      messageProvider: ctx.Provider,
      surface: ctx.Surface,
      gatewayClientScopes: ctx.GatewayClientScopes,
    });
    let statusReply: ReplyPayload | undefined;
    if (directives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender) {
      const { buildStatusReply } = await loadCommandsStatus();
      const targetSessionEntry = sessionStore[sessionKey] ?? sessionEntry;
      statusReply = await buildStatusReply({
        cfg,
        command,
        sessionEntry: targetSessionEntry,
        sessionKey,
        parentSessionKey: targetSessionEntry?.parentSessionKey ?? ctx.ParentSessionKey,
        sessionScope,
        storePath,
        provider,
        model,
        contextTokens,
        resolvedThinkLevel: resolvedDefaultThinkLevel,
        resolvedVerboseLevel: currentVerboseLevel ?? "off",
        resolvedReasoningLevel: currentReasoningLevel ?? "off",
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

  if (hasAnyDirective && command.isAuthorizedSender) {
    const fastLane = await (
      await loadDirectiveFastLane()
    ).applyInlineDirectivesFastLane({
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
      ...directiveModelState,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      agentCfg,
      modelState: {
        resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
        ...directiveModelState,
      },
    });
    directiveAck = fastLane.directiveAck;
    provider = fastLane.provider;
    model = fastLane.model;
  }

  const persisted = await (
    await loadDirectivePersist()
  ).persistInlineDirectives({
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
    messageProvider: ctx.Provider,
    surface: ctx.Surface,
    gatewayClientScopes: ctx.GatewayClientScopes,
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
