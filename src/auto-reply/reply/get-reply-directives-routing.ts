// Resolves directive interpretation and prompt projection at the text-command boundary.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { type InlineDirectives, parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { clearExecInlineDirectives, clearInlineDirectives } from "./get-reply-directives-utils.js";
import { HISTORY_CONTEXT_MARKER } from "./history.js";
import { stripMentions } from "./mentions.js";
import { extractInlineSimpleCommand, stripInlineStatus } from "./reply-inline.js";

type DirectiveCommand = NonNullable<Parameters<typeof parseInlineSessionDirectives>[1]>["command"];

export function resolveReplyDirectiveRouting(params: {
  commandText: string;
  agentText: string;
  modelAliases: string[];
  command?: DirectiveCommand;
  canInterpretTextDirectives: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  wasMentioned: boolean;
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  resetTriggered: boolean;
}): {
  directives: InlineDirectives;
  cleanedBody: string;
  inlineCommand?: string;
  hasInlineStatus: boolean;
  unauthorizedReasoningDirectiveAttempt: boolean;
} {
  const allowStatusDirective = params.canInterpretTextDirectives;
  let parsed = parseInlineSessionDirectives(params.commandText, {
    modelAliases: params.modelAliases,
    allowStatusDirective,
    command: params.command,
  });
  const hasInlineStatus = parsed.hasStatusDirective && parsed.cleaned.trim().length > 0;
  if (hasInlineStatus) {
    parsed = { ...parsed, hasStatusDirective: false };
  }
  if (
    params.isGroup &&
    !params.wasMentioned &&
    parsed.hasElevatedDirective &&
    parsed.elevatedLevel !== "off"
  ) {
    parsed = {
      ...parsed,
      hasElevatedDirective: false,
      elevatedLevel: undefined,
      rawElevatedLevel: undefined,
    };
  }
  if (
    params.isGroup &&
    !params.wasMentioned &&
    parsed.hasExecDirective &&
    parsed.execSecurity !== "deny"
  ) {
    parsed = clearExecInlineDirectives(parsed);
  }

  if (
    params.canInterpretTextDirectives &&
    !isDirectiveOnly({
      directives: parsed,
      cleanedBody: parsed.cleaned,
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
      isGroup: params.isGroup,
    })
  ) {
    // Model browsing and exec placement remain command-only; runtime hints stay on the turn.
    const modelInfo =
      parsed.modelDirectiveSource !== "alias" &&
      ["", "list", "status"].includes(parsed.rawModelDirective?.trim().toLowerCase() ?? "");
    const hasExecPolicy = parsed.rawExecSecurity !== undefined || parsed.rawExecAsk !== undefined;
    parsed = {
      ...parsed,
      ...(modelInfo
        ? {
            hasModelDirective: false,
            rawModelDirective: undefined,
            rawModelProfile: undefined,
            rawModelRuntime: undefined,
            modelDirectiveSource: undefined,
            modelScope: undefined,
            modelScopeConflict: false,
          }
        : {}),
      hasExecDirective: hasExecPolicy,
      hasExecOptions: hasExecPolicy,
      execHost: undefined,
      execNode: undefined,
      rawExecHost: undefined,
      rawExecNode: undefined,
      invalidExecHost: false,
      invalidExecNode: false,
    };
  }

  const unauthorizedReasoningDirectiveAttempt =
    !params.isAuthorizedSender && parsed.hasReasoningDirective;
  const canInterpretDirectives = params.canInterpretTextDirectives || parsed.command !== undefined;
  if (!canInterpretDirectives) {
    return {
      directives: clearInlineDirectives(params.commandText),
      cleanedBody: params.agentText,
      hasInlineStatus,
      unauthorizedReasoningDirectiveAttempt,
    };
  }

  const cleanedCommand = allowStatusDirective
    ? stripInlineStatus(parsed.cleaned).cleaned
    : parsed.cleaned;
  const requestedInlineCommand =
    params.canInterpretTextDirectives &&
    params.isAuthorizedSender &&
    !params.command &&
    params.ctx.CommandSource !== "native"
      ? extractInlineSimpleCommand(cleanedCommand)
      : null;
  let cleanedBody = params.agentText;
  let inlineCommand: string | undefined;
  if (
    params.commandText !== "" &&
    (cleanedCommand !== params.commandText || requestedInlineCommand)
  ) {
    const preparedCommandSource = params.ctx.ChannelContext?.chat?.commandSourceText;
    const preparedSource =
      typeof preparedCommandSource === "string" ? preparedCommandSource : undefined;
    // Reset already projected its payload from rawText; otherwise retain the channel's raw source.
    const fallbackRawText =
      params.resetTriggered || params.agentText === params.commandText
        ? params.agentText
        : params.ctx.rawText;
    const normalizeSource = (text: string, stripProviderMentions = params.isGroup) =>
      normalizeCommandBody(
        stripProviderMentions ? stripMentions(text, params.ctx, params.cfg, params.agentId) : text,
        { botUsername: params.ctx.BotUsername },
      );
    const preparedSourceMatches =
      preparedSource !== undefined &&
      normalizeSource(preparedSource, true) === params.commandText.trim();
    // A channel may identify its exact sender span after provider rendering. Accept it only when
    // provider-owned mention stripping reconstructs the same command body; supplemental context
    // and arbitrary channel metadata must never become a command source.
    const rawText = preparedSourceMatches ? preparedSource : fallbackRawText;
    const contentStart = rawText.length - rawText.trimStart().length;
    const lineEnd = rawText.indexOf("\n", contentStart);
    const firstLine = lineEnd < 0 ? rawText : rawText.slice(0, lineEnd);
    // Normalized commands may omit multiline tails. Those bytes remain prompt content.
    const commandSource =
      preparedSourceMatches || params.resetTriggered || rawText.trim() === params.commandText.trim()
        ? rawText
        : normalizeSource(firstLine) === params.commandText.trim()
          ? firstLine
          : normalizeSource(rawText) === params.commandText.trim()
            ? rawText
            : undefined;
    if (commandSource !== undefined) {
      const leadingSender =
        rawText !== "" &&
        (params.agentText === rawText || params.agentText.startsWith(`${rawText}\n`));
      // A directive-only final line owns its newline, never the following content.
      const source =
        commandSource +
        (rawText[commandSource.length] === "\n" ||
        (leadingSender && params.agentText[commandSource.length] === "\n")
          ? "\n"
          : "");
      const parsedSender = parseInlineSessionDirectives(source, {
        modelAliases: params.modelAliases,
        allowStatusDirective,
        command: params.command,
      });
      let cleanedSender = allowStatusDirective
        ? stripInlineStatus(parsedSender.cleaned).cleaned
        : parsedSender.cleaned;
      const shortcut = requestedInlineCommand ? extractInlineSimpleCommand(cleanedSender) : null;
      // Normalized aliases may select a command; cleanup still needs the corresponding raw token.
      if (shortcut && shortcut.command === requestedInlineCommand?.command) {
        inlineCommand = shortcut.command;
        cleanedSender = shortcut.cleaned;
      }
      // Only the whole body or demonstrated leading sender block can be projected.
      // Non-leading, encoded, and flat-history bodies stay opaque; never search quoted context.
      if (leadingSender && !params.agentText.trimStart().startsWith(HISTORY_CONTEXT_MARKER)) {
        cleanedBody = cleanedSender + params.agentText.slice(source.length);
      }
    }
    if (!params.agentText && !params.resetTriggered) {
      cleanedBody =
        inlineCommand && requestedInlineCommand ? requestedInlineCommand.cleaned : cleanedCommand;
    }
  }

  return {
    directives: parsed,
    cleanedBody,
    ...(inlineCommand ? { inlineCommand } : {}),
    hasInlineStatus,
    unauthorizedReasoningDirectiveAttempt,
  };
}
