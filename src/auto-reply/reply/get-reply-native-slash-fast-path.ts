// Handles native slash commands before full get-reply pipeline execution.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  resolveThinkingDefaultWithRuntimeCatalog,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  isAuthorizedTextSlashCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { markCommandReplyForDelivery, type ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeThinkLevel, type ThinkLevel } from "../thinking.js";
import {
  takeCommandSessionMetadataChangesFromTargets,
  type CommandSessionMetadataChange,
} from "./command-session-metadata.js";
import { buildCommandContext } from "./commands-context.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";
import type { createTypingController } from "./typing.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
type SkillCommandsRuntime = typeof import("../../skills/discovery/chat-commands.runtime.js");
type InternalGetReplyOptions = GetReplyOptions & {
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
};

const commandsRuntimeLoader = createLazyImportLoader(() => import("./commands.runtime.js"));
const skillCommandsRuntimeLoader = createLazyImportLoader<SkillCommandsRuntime>(
  () => import("../../skills/discovery/chat-commands.runtime.js"),
);
const statusCommandRuntimeLoader = createLazyImportLoader(() => import("./commands-status.js"));

function loadCommandsRuntime() {
  return commandsRuntimeLoader.load();
}

function loadSkillCommandsRuntime() {
  return skillCommandsRuntimeLoader.load();
}

function loadStatusCommandRuntime() {
  return statusCommandRuntimeLoader.load();
}

function resolveNativeSlashCommandName(ctx: MsgContext): string | undefined {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (!isNativeCommandTurn(commandTurn) && !isAuthorizedTextSlashCommandTurn(commandTurn)) {
    return undefined;
  }
  const commandText = stripStructuralPrefixes(
    ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "",
  ).trim();
  const match = commandText.match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeOptionalString(match?.[1])?.toLowerCase();
}

function shouldRunNativeSlashCommandFastPath(ctx: MsgContext): boolean {
  const commandTurn = resolveCommandTurnContext(ctx);
  const commandName = resolveNativeSlashCommandName(ctx);
  return Boolean(
    commandName &&
    commandName !== "new" &&
    commandName !== "reset" &&
    (isNativeCommandTurn(commandTurn) ||
      shouldRunInternalTextSlashCommandFastPath(ctx, commandTurn, commandName)),
  );
}

function shouldRunInternalTextSlashCommandFastPath(
  ctx: MsgContext,
  commandTurn: ReturnType<typeof resolveCommandTurnContext>,
  commandName: string,
): boolean {
  return (
    isAuthorizedTextSlashCommandTurn(commandTurn) &&
    (commandName === "export-trajectory" || commandName === "trajectory") &&
    ctx.ChatType !== "group" &&
    isInternalMessageChannel(normalizeOptionalString(ctx.Provider)) &&
    (ctx.Surface === undefined || isInternalMessageChannel(normalizeOptionalString(ctx.Surface))) &&
    (ctx.OriginatingChannel === undefined ||
      isInternalMessageChannel(normalizeOptionalString(ctx.OriginatingChannel)))
  );
}

async function resolveNativeSlashDefaultThinkingLevel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): Promise<ThinkLevel> {
  return resolveThinkingDefaultWithRuntimeCatalog({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    loadModelCatalog: () => loadModelCatalog({ config: params.cfg }),
  });
}

export async function maybeResolveNativeSlashCommandFastReply(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  commandAuthorized: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  workspaceDir: string;
  typing: ReturnType<typeof createTypingController>;
  opts?: GetReplyOptions;
  skillFilter?: string[];
}): Promise<
  { handled: true; reply: ReplyPayload | ReplyPayload[] | undefined } | { handled: false }
> {
  if (!shouldRunNativeSlashCommandFastPath(params.ctx)) {
    return { handled: false };
  }

  const sessionState = initFastReplySessionState({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    commandAuthorized: params.commandAuthorized,
    workspaceDir: params.workspaceDir,
  });
  if (params.commandAuthorized) {
    const creatingSession = sessionState.initialSessionEntry === undefined;
    const initializationEntry = sessionState.initialSessionEntry ?? sessionState.sessionEntry;
    const persistence = await persistReplySessionEntry({
      storePath: sessionState.storePath,
      sessionKey: sessionState.sessionKey,
      allowCreate: creatingSession,
      initialEntry: initializationEntry,
      entry: sessionState.sessionEntry,
      skipMaintenance: !creatingSession,
    });
    if (persistence.status === "lifecycle-invalidated") {
      params.typing.cleanup();
      return {
        handled: true,
        reply: markCommandReplyForDelivery({
          text: persistence.error,
        }),
      };
    }
    const persistedInitialEntry = persistence.entry;
    // Commit the synthesized activity/channel touch before commands or directives
    // capture their own mutation baseline.
    sessionState.sessionEntry = persistedInitialEntry;
    sessionState.sessionEntryHandle.replaceCurrent(persistedInitialEntry);
    sessionState.sessionStore[sessionState.sessionKey] = persistedInitialEntry;
    sessionState.sessionId = persistedInitialEntry.sessionId;
  }
  const command = buildCommandContext({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: sessionState.sessionKey,
    isGroup: sessionState.isGroup,
    triggerBodyNormalized: sessionState.triggerBodyNormalized,
    commandAuthorized: params.commandAuthorized,
  });
  if (command.commandBodyNormalized === "/status") {
    const targetSessionEntry =
      sessionState.sessionStore[sessionState.sessionKey] ?? sessionState.sessionEntry;
    let resolvedDefaultThinkingLevel: ThinkLevel | undefined;
    const resolveDefaultThinkingLevel = async () => {
      resolvedDefaultThinkingLevel ??= await resolveNativeSlashDefaultThinkingLevel({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
      });
      return resolvedDefaultThinkingLevel;
    };
    const resolvedThinkLevel = normalizeThinkLevel(targetSessionEntry?.thinkingLevel);
    const { buildStatusReply } = await loadStatusCommandRuntime();
    return {
      handled: true,
      reply: markCommandReplyForDelivery(
        await buildStatusReply({
          cfg: params.cfg,
          command,
          sessionEntry: targetSessionEntry,
          sessionKey: sessionState.sessionKey,
          parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
          sessionScope: sessionState.sessionScope,
          storePath: sessionState.storePath,
          provider: params.provider,
          model: params.model,
          workspaceDir: params.workspaceDir,
          resolvedThinkLevel,
          resolvedVerboseLevel: "off",
          resolvedReasoningLevel: "off",
          resolvedElevatedLevel: "off",
          resolveDefaultThinkingLevel,
          isGroup: sessionState.isGroup,
          defaultGroupActivation: () => "always",
          mediaDecisions: params.ctx.MediaUnderstandingDecisions,
        }),
      ),
    };
  }

  let loadedSkillCommands: SkillCommandSpec[] | undefined;
  const loadNativeSkillCommands = async () => {
    loadedSkillCommands ??= (await loadSkillCommandsRuntime()).listSkillCommandsForWorkspace({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      sessionEntry: sessionState.sessionEntry,
      sessionKey: sessionState.sessionKey,
    });
    return loadedSkillCommands;
  };

  const commandResult = await (
    await loadCommandsRuntime()
  ).handleCommands({
    ctx: sessionState.sessionCtx,
    rootCtx: params.ctx,
    cfg: params.cfg,
    command,
    agentId: params.agentId,
    agentDir: params.agentDir,
    directives: clearInlineDirectives(sessionState.triggerBodyNormalized),
    elevated: {
      enabled: false,
      allowed: false,
      failures: [],
    },
    sessionEntry: sessionState.sessionEntry,
    previousSessionEntry: sessionState.previousSessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    workspaceDir: params.workspaceDir,
    opts: params.opts,
    defaultGroupActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    blockReplyChunking: undefined,
    resolvedBlockStreamingBreak: "text_end",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: params.provider,
    model: params.model,
    contextTokens: params.agentCfg?.contextTokens ?? 0,
    isGroup: sessionState.isGroup,
    loadSkillCommands: loadNativeSkillCommands,
    typing: params.typing,
  });
  const commandSessionMetadataChanges = takeCommandSessionMetadataChangesFromTargets([
    sessionState.sessionCtx,
    params.ctx,
  ]);
  if (commandSessionMetadataChanges) {
    (params.opts as InternalGetReplyOptions | undefined)?.onSessionMetadataChanges?.(
      commandSessionMetadataChanges,
    );
  }
  if (!commandResult.shouldContinue) {
    params.typing.cleanup();
    return { handled: true, reply: markCommandReplyForDelivery(commandResult.reply) };
  }
  const continuationTriggerBodyNormalized = command.rawBodyNormalized;

  const directiveResult = await resolveReplyDirectives({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    agentCfg: params.agentCfg,
    sessionCtx: sessionState.sessionCtx,
    sessionEntry: sessionState.sessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    groupResolution: sessionState.groupResolution,
    isGroup: sessionState.isGroup,
    triggerBodyNormalized: continuationTriggerBodyNormalized,
    resetTriggered: false,
    commandAuthorized: params.commandAuthorized,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    provider: params.provider,
    model: params.model,
    hasResolvedHeartbeatModelOverride: false,
    typing: params.typing,
    opts: params.opts,
    skillFilter: params.skillFilter,
  });
  if (directiveResult.kind === "reply") {
    params.typing.cleanup();
    return { handled: true, reply: markCommandReplyForDelivery(directiveResult.reply) };
  }

  const inlineActionResult = await handleInlineActions({
    ctx: params.ctx,
    sessionCtx: sessionState.sessionCtx,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    sessionEntry: sessionState.sessionEntry,
    ...(sessionState.initialSessionEntry
      ? { initialSessionEntry: sessionState.initialSessionEntry }
      : {}),
    allowCreateSessionEntry: sessionState.initialSessionEntry === undefined,
    previousSessionEntry: sessionState.previousSessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
    sessionScope: sessionState.sessionScope,
    workspaceDir: params.workspaceDir,
    isGroup: sessionState.isGroup,
    opts: params.opts,
    typing: params.typing,
    allowTextCommands: directiveResult.result.allowTextCommands,
    inlineStatusRequested: directiveResult.result.inlineStatusRequested,
    command: directiveResult.result.command,
    skillCommands: loadedSkillCommands ?? directiveResult.result.skillCommands,
    directives: directiveResult.result.directives,
    cleanedBody: directiveResult.result.cleanedBody,
    elevatedEnabled: directiveResult.result.elevatedEnabled,
    elevatedAllowed: directiveResult.result.elevatedAllowed,
    elevatedFailures: directiveResult.result.elevatedFailures,
    defaultActivation: () => directiveResult.result.defaultActivation,
    resolvedThinkLevel: directiveResult.result.resolvedThinkLevel,
    resolvedVerboseLevel: directiveResult.result.resolvedVerboseLevel,
    resolvedReasoningLevel: directiveResult.result.resolvedReasoningLevel,
    resolvedElevatedLevel: directiveResult.result.resolvedElevatedLevel,
    execOverrides: directiveResult.result.execOverrides,
    blockReplyChunking: directiveResult.result.blockReplyChunking,
    resolvedBlockStreamingBreak: directiveResult.result.resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel: directiveResult.result.modelState.resolveDefaultThinkingLevel,
    provider: directiveResult.result.provider,
    model: directiveResult.result.model,
    contextTokens: directiveResult.result.contextTokens,
    directiveAck: directiveResult.result.directiveAck,
    abortedLastRun: sessionState.abortedLastRun,
    skillFilter: params.skillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    return {
      handled: true,
      reply: markCommandReplyForDelivery(inlineActionResult.reply),
    };
  }
  return { handled: false };
}
