/** Handles inline slash commands, skill invocations, and abort actions before model runs. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import type { BlockReplyChunking } from "../../agents/embedded-agent-block-chunker.js";
import type { ExecPolicyOverrides } from "../../agents/exec-defaults.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  listReservedChatSlashCommandNames,
  resolveSkillCommandInvocation,
} from "../../skills/discovery/chat-commands.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import { markCommandReplyForDelivery } from "../reply-payload.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  VerboseLevel,
} from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  readAbortCutoffFromSessionEntry,
  resolveAbortCutoffFromContext,
  shouldSkipMessageByAbortCutoff,
} from "./abort-cutoff.js";
import { getAbortMemory, isAbortRequestText } from "./abort-primitives.js";
import {
  takeCommandSessionMetadataChangesFromTargets,
  type CommandSessionMetadataChange,
} from "./command-session-metadata.js";
import type { buildStatusReply, handleCommands } from "./commands.runtime.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { extractExplicitGroupId } from "./group-id.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import type { createModelSelectionState } from "./model-selection.js";
import { extractInlineSimpleCommand } from "./reply-inline.js";
import type { TypingController } from "./typing.js";

type SkillCommandsRuntime = typeof import("../../skills/discovery/chat-commands.runtime.js");
type SkillToolDispatchRuntime = typeof import("../../skills/runtime/tool-dispatch.js");
type AbortCutoffRuntime = typeof import("./abort-cutoff.runtime.js");
type CommandsRuntime = typeof import("./commands.runtime.js");

type InternalGetReplyOptions = GetReplyOptions & {
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
};

const skillCommandsRuntimeLoader = createLazyImportLoader<SkillCommandsRuntime>(
  () => import("../../skills/discovery/chat-commands.runtime.js"),
);
const skillToolDispatchRuntimeLoader = createLazyImportLoader<SkillToolDispatchRuntime>(
  () => import("../../skills/runtime/tool-dispatch.js"),
);
const abortCutoffRuntimeLoader = createLazyImportLoader<AbortCutoffRuntime>(
  () => import("./abort-cutoff.runtime.js"),
);
const commandsRuntimeLoader = createLazyImportLoader<CommandsRuntime>(
  () => import("./commands.runtime.js"),
);
let builtinSlashCommands: Set<string> | null = null;

function loadSkillCommandsRuntime(): Promise<SkillCommandsRuntime> {
  return skillCommandsRuntimeLoader.load();
}

function loadSkillToolDispatchRuntime(): Promise<SkillToolDispatchRuntime> {
  return skillToolDispatchRuntimeLoader.load();
}

function loadAbortCutoffRuntime(): Promise<AbortCutoffRuntime> {
  return abortCutoffRuntimeLoader.load();
}

function loadCommandsRuntime(): Promise<CommandsRuntime> {
  return commandsRuntimeLoader.load();
}

function getBuiltinSlashCommands(): Set<string> {
  if (builtinSlashCommands) {
    return builtinSlashCommands;
  }
  builtinSlashCommands = listReservedChatSlashCommandNames([
    "btw",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "exec",
    "model",
    "status",
    "queue",
  ]);
  return builtinSlashCommands;
}

function resolveSlashCommandName(commandBodyNormalized: string): string | null {
  const trimmed = commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = trimmed.match(/^\/([^\s:]+)(?::|\s|$)/);
  const name = normalizeOptionalLowercaseString(match?.[1]) ?? "";
  return name ? name : null;
}

function expandBundleCommandPromptTemplate(template: string, args?: string): string {
  const normalizedArgs = normalizeOptionalString(args) || "";
  const rendered = template.includes("$ARGUMENTS")
    ? template.replaceAll("$ARGUMENTS", normalizedArgs)
    : template;
  if (!normalizedArgs || template.includes("$ARGUMENTS")) {
    return rendered.trim();
  }
  return `${rendered.trim()}\n\nUser input:\n${normalizedArgs}`;
}

function isMentionOnlyResidualText(text: string, wasMentioned: boolean | undefined): boolean {
  if (wasMentioned !== true) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /^(?:<@[!&]?[A-Za-z0-9._:-]+>|<!(?:here|channel|everyone)>|[:,.!?-]|\s)+$/u.test(trimmed);
}

/** Result of attempting to handle an inbound message as an inline action. */
type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
      cleanedBody: string;
    };

function extractTextFromToolResult(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }
  const parts = collectTextContentBlocks(content);
  const out = parts.join("");
  const trimmed = out.trim();
  return trimmed ? trimmed : null;
}

function extractBlockedToolReason(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const status = (details as { status?: unknown }).status;
  if (status !== "blocked") {
    return null;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

/** Handles inline actions or returns continue when the message should become a model turn. */
export async function handleInlineActions(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  initialSessionEntry?: SessionEntry;
  allowCreateSessionEntry?: boolean;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
  workspaceDir: string;
  isGroup: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  allowTextCommands: boolean;
  inlineStatusRequested: boolean;
  command: Parameters<typeof handleCommands>[0]["command"];
  skillCommands?: SkillCommandSpec[];
  directives: InlineDirectives;
  cleanedBody: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultActivation: Parameters<typeof buildStatusReply>[0]["defaultGroupActivation"];
  thinkingCatalog?: ThinkingCatalogEntry[];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecPolicyOverrides;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["resolveDefaultThinkingLevel"];
  provider: string;
  model: string;
  contextTokens: number;
  directiveAck?: ReplyPayload;
  abortedLastRun: boolean;
  skillFilter?: string[];
}): Promise<InlineActionResult> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    initialSessionEntry,
    allowCreateSessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    directives: initialDirectives,
    cleanedBody: initialCleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    thinkingCatalog,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun: initialAbortedLastRun,
    skillFilter,
  } = params;
  const internalOpts = opts as InternalGetReplyOptions | undefined;
  const notifyInlineCommandSessionMetadataChanges = () => {
    const changes = takeCommandSessionMetadataChangesFromTargets([sessionCtx, ctx]);
    if (changes) {
      internalOpts?.onSessionMetadataChanges?.(changes);
    }
  };

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;
  const targetSessionEntry = sessionStore?.[sessionKey] ?? sessionEntry;

  const isStopLikeInbound = isAbortRequestText(command.rawBodyNormalized);
  if (!isStopLikeInbound && targetSessionEntry) {
    const cutoff = readAbortCutoffFromSessionEntry(targetSessionEntry);
    const incoming = resolveAbortCutoffFromContext(ctx);
    const shouldSkip = cutoff
      ? shouldSkipMessageByAbortCutoff({
          cutoffMessageSid: cutoff.messageSid,
          cutoffTimestamp: cutoff.timestamp,
          messageSid: incoming?.messageSid,
          timestamp: incoming?.timestamp,
        })
      : false;
    if (shouldSkip) {
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }
    if (cutoff) {
      await (
        await loadAbortCutoffRuntime()
      ).clearAbortCutoffInSessionRuntime({
        sessionEntry: targetSessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  const isEmptyConfig = Object.keys(cfg).length === 0;
  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelPlugin(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    isEmptyConfig &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    typing.cleanup();
    return { kind: "reply", reply: undefined };
  }

  const slashCommandName = resolveSlashCommandName(command.commandBodyNormalized);
  const shouldLoadSkillCommands =
    allowTextCommands &&
    slashCommandName !== null &&
    // `/skill …` needs the full skill command list.
    (slashCommandName === "skill" || !getBuiltinSlashCommands().has(slashCommandName));
  const canReusePreloadedSkillCommands = execOverrides === undefined;
  const skillCommands =
    shouldLoadSkillCommands &&
    canReusePreloadedSkillCommands &&
    params.skillCommands &&
    params.skillCommands.length > 0
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? (await loadSkillCommandsRuntime()).listSkillCommandsForWorkspace({
            workspaceDir,
            cfg,
            agentId,
            skillFilter,
            sessionEntry: targetSessionEntry,
            sessionKey,
            execOverrides,
          })
        : [];

  const skillInvocation =
    allowTextCommands && skillCommands.length > 0
      ? resolveSkillCommandInvocation({
          commandBodyNormalized: command.commandBodyNormalized,
          skillCommands,
        })
      : null;
  if (skillInvocation) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /${skillInvocation.command.name} from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }

    const dispatch = skillInvocation.command.dispatch;
    if (dispatch?.kind === "tool") {
      const rawArgs = (skillInvocation.args ?? "").trim();
      const { resolveSkillDispatchTools } = await loadSkillToolDispatchRuntime();
      const authorizedTools = resolveSkillDispatchTools({
        message: {
          surface: ctx.Surface,
          provider: ctx.Provider,
          accountId: ctx.AccountId,
          senderId: ctx.SenderId,
          senderName: ctx.SenderName,
          senderUsername: ctx.SenderUsername,
          senderE164: ctx.SenderE164,
          originatingTo: ctx.OriginatingTo,
          to: ctx.To,
          nativeChannelId: ctx.NativeChannelId,
          messageThreadId: ctx.MessageThreadId,
          memberRoleIds: ctx.MemberRoleIds,
        },
        cfg,
        agentId,
        agentDir,
        sessionEntry: targetSessionEntry,
        sessionKey,
        workspaceDir,
        provider,
        model,
        senderId: command.senderId,
        currentChannelId: command.channelId,
        groupId: extractExplicitGroupId(ctx.From),
        skillCommand: {
          name: skillInvocation.command.name,
          ...(skillInvocation.command.skillFile
            ? { skillFile: skillInvocation.command.skillFile }
            : {}),
          skillName: skillInvocation.command.skillName,
          ...(skillInvocation.command.skillSource
            ? { skillSource: skillInvocation.command.skillSource }
            : {}),
          toolName: dispatch.toolName,
        },
      });

      const tool = authorizedTools.find((candidate) => candidate.name === dispatch.toolName);
      if (!tool) {
        typing.cleanup();
        return {
          kind: "reply",
          reply: markCommandReplyForDelivery({
            text: `❌ Tool not available: ${dispatch.toolName}`,
          }),
        };
      }

      const toolCallId = `cmd_${generateSecureToken(8)}`;
      try {
        const toolArgs: Parameters<NonNullable<typeof tool.execute>>[1] = {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
        };
        const result = await tool.execute(toolCallId, toolArgs, opts?.abortSignal);
        const blockedReason = extractBlockedToolReason(result);
        if (blockedReason) {
          typing.cleanup();
          return {
            kind: "reply",
            reply: markCommandReplyForDelivery({ text: `❌ Tool call blocked: ${blockedReason}` }),
          };
        }
        const text = extractTextFromToolResult(result) ?? "✅ Done.";
        typing.cleanup();
        return { kind: "reply", reply: markCommandReplyForDelivery({ text }) };
      } catch (err) {
        const message = formatErrorMessage(err);
        typing.cleanup();
        return {
          kind: "reply",
          reply: markCommandReplyForDelivery({ text: `❌ ${message}` }),
        };
      }
    }

    const rewrittenBody = skillInvocation.command.promptTemplate
      ? expandBundleCommandPromptTemplate(
          skillInvocation.command.promptTemplate,
          skillInvocation.args,
        )
      : [
          `Use the "${skillInvocation.command.skillName}" skill for this request.`,
          skillInvocation.args ? `User input:\n${skillInvocation.args}` : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n\n");
    ctx.Body = rewrittenBody;
    ctx.BodyForAgent = rewrittenBody;
    sessionCtx.Body = rewrittenBody;
    sessionCtx.BodyForAgent = rewrittenBody;
    sessionCtx.BodyStripped = rewrittenBody;
    cleanedBody = rewrittenBody;
  }

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply) {
      return;
    }
    if (!opts?.onBlockReply) {
      return;
    }
    await opts.onBlockReply(reply);
  };

  const inlineCommand =
    allowTextCommands && command.isAuthorizedSender
      ? extractInlineSimpleCommand(cleanedBody)
      : null;
  if (inlineCommand) {
    cleanedBody = inlineCommand.cleaned;
    sessionCtx.Body = cleanedBody;
    sessionCtx.BodyForAgent = cleanedBody;
    sessionCtx.BodyStripped = cleanedBody;
  }

  const handleInlineStatus =
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) && inlineStatusRequested;
  let didSendInlineStatus = false;
  if (handleInlineStatus) {
    const { buildStatusReply } = await loadCommandsRuntime();
    const inlineStatusReply = await buildStatusReply({
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
      workspaceDir,
      thinkingCatalog,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: defaultActivation,
      mediaDecisions: ctx.MediaUnderstandingDecisions,
    });
    await sendInlineReply(inlineStatusReply);
    didSendInlineStatus = true;
    directives = { ...directives, hasStatusDirective: false };
  }

  const runCommands = async (commandInput: typeof command) => {
    const { handleCommands } = await loadCommandsRuntime();
    return handleCommands({
      // Pass sessionCtx so command handlers can mutate stripped body for same-turn continuation.
      ctx: sessionCtx,
      // Keep original finalized context in sync when command handlers need outer-dispatch side effects.
      rootCtx: ctx,
      cfg,
      command: commandInput,
      agentId,
      agentDir,
      directives,
      elevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        failures: elevatedFailures,
      },
      sessionEntry: targetSessionEntry,
      initialSessionEntry,
      allowCreateSessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      opts,
      defaultGroupActivation: defaultActivation,
      thinkingCatalog,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
      skillCommands,
      typing,
    });
  };

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand.command,
      commandBodyNormalized: inlineCommand.command,
    };
    const inlineResult = await runCommands(inlineCommandContext);
    notifyInlineCommandSessionMetadataChanges();
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return { kind: "reply", reply: markCommandReplyForDelivery(inlineResult.reply) };
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
  }

  let abortedLastRun = initialAbortedLastRun;
  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const shouldRunCommandHandlers =
    inlineCommand !== null ||
    directiveAck !== undefined ||
    inlineStatusRequested ||
    command.commandBodyNormalized.trim().startsWith("/");
  if (!shouldRunCommandHandlers) {
    return {
      kind: "continue",
      directives,
      abortedLastRun,
      cleanedBody,
    };
  }
  const remainingBodyAfterInlineStatus = (() => {
    const stripped = stripStructuralPrefixes(cleanedBody);
    if (!isGroup) {
      return stripped.trim();
    }
    return stripMentions(stripped, ctx, cfg, agentId).trim();
  })();
  if (
    didSendInlineStatus &&
    (remainingBodyAfterInlineStatus.length === 0 ||
      isMentionOnlyResidualText(remainingBodyAfterInlineStatus, ctx.WasMentioned))
  ) {
    typing.cleanup();
    return { kind: "reply", reply: undefined };
  }

  const commandBodyBeforeRun = command.commandBodyNormalized;
  const bodyBeforeRun = sessionCtx.BodyStripped ?? sessionCtx.BodyForAgent;
  const commandResult = await runCommands(command);
  notifyInlineCommandSessionMetadataChanges();
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return { kind: "reply", reply: markCommandReplyForDelivery(commandResult.reply) };
  }
  if (command.commandBodyNormalized !== commandBodyBeforeRun) {
    cleanedBody = command.commandBodyNormalized;
  } else {
    const bodyAfterRun = sessionCtx.BodyStripped ?? sessionCtx.BodyForAgent;
    if (bodyAfterRun !== undefined && bodyAfterRun !== bodyBeforeRun) {
      cleanedBody = bodyAfterRun;
    }
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
    cleanedBody,
  };
}
