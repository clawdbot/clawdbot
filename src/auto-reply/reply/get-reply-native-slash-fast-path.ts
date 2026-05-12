import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  resolveThinkingDefaultWithRuntimeCatalog,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeThinkLevel, type ThinkLevel } from "../thinking.js";
import { buildCommandContext } from "./commands-context.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { stripStructuralPrefixes } from "./mentions.js";
import type { createTypingController } from "./typing.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;

const commandsRuntimeLoader = createLazyImportLoader(() => import("./commands.runtime.js"));
const statusCommandRuntimeLoader = createLazyImportLoader(() => import("./commands-status.js"));

function loadCommandsRuntime() {
  return commandsRuntimeLoader.load();
}

function loadStatusCommandRuntime() {
  return statusCommandRuntimeLoader.load();
}

function resolveNativeSlashCommandName(ctx: MsgContext): string | undefined {
  if (ctx.CommandSource !== "native") {
    return undefined;
  }
  const commandText = stripStructuralPrefixes(
    ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "",
  ).trim();
  const match = commandText.match(/^\/([^\s:]+)(?::|\s|$)/);
  return normalizeOptionalString(match?.[1])?.toLowerCase();
}

function shouldRunNativeSlashCommandFastPath(ctx: MsgContext): boolean {
  const commandName = resolveNativeSlashCommandName(ctx);
  return Boolean(commandName && commandName !== "new" && commandName !== "reset");
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
      reply: await buildStatusReply({
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
    };
  }

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
    skillCommands: [],
    typing: params.typing,
  });
  if (!commandResult.shouldContinue) {
    return { handled: true, reply: commandResult.reply };
  }

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
    triggerBodyNormalized: sessionState.triggerBodyNormalized,
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
    return { handled: true, reply: directiveResult.reply };
  }

  const inlineActionResult = await handleInlineActions({
    ctx: params.ctx,
    sessionCtx: sessionState.sessionCtx,
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    sessionEntry: sessionState.sessionEntry,
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
    skillCommands: directiveResult.result.skillCommands,
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
    return { handled: true, reply: inlineActionResult.reply };
  }
  return { handled: false };
}
