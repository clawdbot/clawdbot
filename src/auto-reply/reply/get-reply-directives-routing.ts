// Resolves directive interpretation and prompt projection at the text-command boundary.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { type InlineDirectives, parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { clearExecInlineDirectives, clearInlineDirectives } from "./get-reply-directives-utils.js";
import { HISTORY_CONTEXT_MARKER } from "./history.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { stripInlineStatus } from "./reply-inline.js";

type NativeDirectiveCommand = NonNullable<
  Parameters<typeof parseInlineSessionDirectives>[1]
>["nativeCommand"];

function hasInlineDirective(directives: InlineDirectives): boolean {
  return (
    directives.hasThinkDirective ||
    directives.hasVerboseDirective ||
    directives.hasTraceDirective ||
    directives.hasFastDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasExecDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective
  );
}

function preserveMixedModelDirective(
  directives: InlineDirectives,
  cleaned: string,
): InlineDirectives {
  return {
    ...clearInlineDirectives(cleaned),
    hasModelDirective: directives.hasModelDirective,
    rawModelDirective: directives.rawModelDirective,
    rawModelProfile: directives.rawModelProfile,
    rawModelRuntime: directives.rawModelRuntime,
    modelDirectiveSource: directives.modelDirectiveSource,
    modelScope: directives.modelScope,
    modelScopeConflict: directives.modelScopeConflict,
  };
}

function isModelSelectionDirective(directives: InlineDirectives): boolean {
  const rawModelDirective = directives.rawModelDirective?.trim().toLowerCase();
  return (
    directives.hasModelDirective &&
    Boolean(rawModelDirective) &&
    (directives.modelDirectiveSource === "alias" ||
      (rawModelDirective !== "list" && rawModelDirective !== "status"))
  );
}

export function resolveReplyDirectiveRouting(params: {
  commandText: string;
  agentText: string;
  modelAliases: string[];
  nativeCommand?: NativeDirectiveCommand;
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
  hasInlineStatus: boolean;
  unauthorizedReasoningDirectiveAttempt: boolean;
} {
  const allowStatusDirective = params.canInterpretTextDirectives;
  let parsed = parseInlineSessionDirectives(params.commandText, {
    modelAliases: params.modelAliases,
    allowStatusDirective,
    nativeCommand: params.nativeCommand,
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

  if (params.canInterpretTextDirectives && hasInlineDirective(parsed) && !parsed.nativeCommand) {
    const stripped = stripStructuralPrefixes(parsed.cleaned);
    const noMentions = params.isGroup
      ? stripMentions(stripped, params.ctx, params.cfg, params.agentId)
      : stripped;
    if (
      noMentions.trim() &&
      parseInlineSessionDirectives(noMentions, { modelAliases: params.modelAliases }).cleaned.trim()
    ) {
      parsed = isModelSelectionDirective(parsed)
        ? preserveMixedModelDirective(parsed, parsed.cleaned)
        : clearInlineDirectives(parsed.cleaned);
    }
  }

  const unauthorizedReasoningDirectiveAttempt =
    !params.isAuthorizedSender && parsed.hasReasoningDirective;
  const canInterpretDirectives =
    params.canInterpretTextDirectives || parsed.nativeCommand !== undefined;
  if (!canInterpretDirectives) {
    return {
      directives: clearInlineDirectives(params.commandText),
      cleanedBody: params.agentText,
      hasInlineStatus,
      unauthorizedReasoningDirectiveAttempt,
    };
  }

  const hasLegacyHistoryEnvelope = params.agentText.trimStart().startsWith(HISTORY_CONTEXT_MARKER);
  const preserveAgentText = params.commandText === "" || hasLegacyHistoryEnvelope;
  let cleanedBody = preserveAgentText
    ? params.agentText
    : params.agentText
      ? parseInlineSessionDirectives(params.agentText, {
          modelAliases: params.modelAliases,
          allowStatusDirective,
        }).cleaned
      : params.resetTriggered
        ? ""
        : parsed.cleaned;
  if (allowStatusDirective && !preserveAgentText) {
    cleanedBody = stripInlineStatus(cleanedBody).cleaned;
  }

  return {
    directives: parsed,
    cleanedBody,
    hasInlineStatus,
    unauthorizedReasoningDirectiveAttempt,
  };
}
