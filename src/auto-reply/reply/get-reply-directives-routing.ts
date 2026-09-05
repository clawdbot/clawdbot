// Resolves directive interpretation and prompt projection at the text-command boundary.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { type InlineDirectives, parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { clearExecInlineDirectives, clearInlineDirectives } from "./get-reply-directives-utils.js";
import { HISTORY_CONTEXT_MARKER } from "./history.js";
import { stripInlineStatus } from "./reply-inline.js";

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
