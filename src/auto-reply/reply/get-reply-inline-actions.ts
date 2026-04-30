import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import type { BlockReplyChunking } from "../../agents/pi-embedded-block-chunker.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import { applyOwnerOnlyToolPolicy } from "../../agents/tool-policy.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import {
  listReservedChatSlashCommandNames,
  resolveSkillCommandInvocation,
} from "../skill-commands-base.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  readAbortCutoffFromSessionEntry,
  resolveAbortCutoffFromContext,
  shouldSkipMessageByAbortCutoff,
} from "./abort-cutoff.js";
import { getAbortMemory, isAbortRequestText } from "./abort-primitives.js";
import type { buildStatusReply, handleCommands } from "./commands.runtime.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { extractExplicitGroupId } from "./group-id.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import type { createModelSelectionState } from "./model-selection.js";
import { extractInlineSimpleCommand } from "./reply-inline.js";
import type { TypingController } from "./typing.js";

type SkillCommandsRuntime = typeof import("../skill-commands.runtime.js");
type OpenClawToolsRuntime = typeof import("../../agents/openclaw-tools.runtime.js");
type AbortCutoffRuntime = typeof import("./abort-cutoff.runtime.js");
type CommandsRuntime = typeof import("./commands.runtime.js");

let skillCommandsRuntimePromise: Promise<SkillCommandsRuntime> | undefined;
let openClawToolsRuntimePromise: Promise<OpenClawToolsRuntime> | undefined;
let abortCutoffRuntimePromise: Promise<AbortCutoffRuntime> | undefined;
let commandsRuntimePromise: Promise<CommandsRuntime> | undefined;
let builtinSlashCommands: Set<string> | null = null;

function loadSkillCommandsRuntime(): Promise<SkillCommandsRuntime> {
  skillCommandsRuntimePromise ??= import("../skill-commands.runtime.js");
  return skillCommandsRuntimePromise;
}

function loadOpenClawToolsRuntime(): Promise<OpenClawToolsRuntime> {
  openClawToolsRuntimePromise ??= import("../../agents/openclaw-tools.runtime.js");
  return openClawToolsRuntimePromise;
}

function loadAbortCutoffRuntime(): Promise<AbortCutoffRuntime> {
  abortCutoffRuntimePromise ??= import("./abort-cutoff.runtime.js");
  return abortCutoffRuntimePromise;
}

function loadCommandsRuntime(): Promise<CommandsRuntime> {
  commandsRuntimePromise ??= import("./commands.runtime.js");
  return commandsRuntimePromise;
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

export type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
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

export async function handleInlineActions(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
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
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
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
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
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

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;

  const slashCommandName = resolveSlashCommandName(command.commandBodyNormalized);
  const shouldLoadSkillCommands =
    allowTextCommands &&
    slashCommandName !== null &&
    // `/skill …` needs the full skill command list.
    (slashCommandName === "skill" || !getBuiltinSlashCommands().has(slashCommandName));
  const skillCommands =
    shouldLoadSkillCommands && params.skillCommands
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? (await loadSkillCommandsRuntime()).listSkillCommandsForWorkspace({
            workspaceDir,
            cfg,
            agentId,
            skillFilter,
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
      const channel =
        resolveGatewayMessageChannel(ctx.Surface) ??
        resolveGatewayMessageChannel(ctx.Provider) ??
        undefined;

      const { createOpenClawTools } = await loadOpenClawToolsRuntime();
      const tools = createOpenClawTools({
        agentSessionKey: sessionKey,
        agentChannel: channel,
        agentAccountId: (ctx as { AccountId?: string }).AccountId,
        agentTo: ctx.OriginatingTo ?? ctx.To,
        agentThreadId: ctx.MessageThreadId ?? undefined,
        agentGroupId: extractExplicitGroupId(ctx.From),
        requesterAgentIdOverride: agentId,
        agentDir,
        workspaceDir,
        config: cfg,
        allowGatewaySubagentBinding: true,
        senderIsOwner: command.senderIsOwner,
      });
      const authorizedTools = applyOwnerOnlyToolPolicy(tools, command.senderIsOwner);

      const tool = authorizedTools.find((candidate) => candidate.name === dispatch.toolName);
      if (!tool) {
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ Tool not available: ${dispatch.toolName}` } };
      }

      const toolCallId = `cmd_${generateSecureToken(8)}`;
      try {
        const toolArgs: Parameters<NonNullable<typeof tool.execute>>[1] = {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
        };
        const result = await tool.execute(toolCallId, toolArgs);
        const text = extractTextFromToolResult(result) ?? "✅ Done.";
        typing.cleanup();
        return { kind: "reply", reply: { text } };
      } catch (err) {
        const message = formatErrorMessage(err);
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ ${message}` } };
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

  const isStopLikeInbound = isAbortRequestText(command.rawBodyNormalized);
  const targetSessionEntry = sessionStore?.[sessionKey] ?? sessionEntry;
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
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      opts,
      defaultGroupActivation: defaultActivation,
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
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return { kind: "reply", reply: inlineResult.reply };
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
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

  const commandResult = await runCommands(command);
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return { kind: "reply", reply: commandResult.reply };
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
  };
}
