import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_RESET_TRIGGERS } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isResetAuthorizedForContext } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry.js";
import type { MsgContext } from "../templating.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import { CURRENT_MESSAGE_MARKER, HISTORY_CONTEXT_MARKER } from "./history.js";
import { stripMentions } from "./mentions.js";

type ResolvedSessionResetCommand = {
  matchedResetTriggerLower?: string;
  normalizedResetBody: string;
  payload?: string;
  softResetMatched: boolean;
  triggerBodyNormalized: string;
};

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function skipHorizontalWhitespace(source: string, start: number): number {
  let cursor = start;
  while (source[cursor] === " " || source[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function startsWithHistoryMarker(source: string, start: number): boolean {
  return (
    source.startsWith(HISTORY_CONTEXT_MARKER, start) ||
    source.startsWith(CURRENT_MESSAGE_MARKER, start)
  );
}

function matchesKnownSenderPrefix(prefix: string, ctx: MsgContext): boolean {
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  if (!normalizedPrefix) {
    return false;
  }
  const senderUsername = ctx.SenderUsername?.trim().replace(/^@/, "");
  const candidates = [
    ctx.SenderName,
    ctx.SenderTag,
    senderUsername,
    senderUsername ? `@${senderUsername}` : undefined,
    ctx.SenderName && senderUsername ? `${ctx.SenderName} (@${senderUsername})` : undefined,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      normalizeLowercaseStringOrEmpty(candidate) === normalizedPrefix,
  );
}

function resolveExplicitMessageStart(source: string, ctx: MsgContext): number | undefined {
  let cursor = skipWhitespace(source, 0);
  if (startsWithHistoryMarker(source, cursor)) {
    return undefined;
  }

  while (source[cursor] === "[") {
    const lineEnd = source.indexOf("\n", cursor);
    const envelopeEnd = source.indexOf("]", cursor + 1);
    if (envelopeEnd === -1 || (lineEnd !== -1 && envelopeEnd > lineEnd)) {
      break;
    }
    if (startsWithHistoryMarker(source, cursor)) {
      return undefined;
    }
    cursor = skipHorizontalWhitespace(source, envelopeEnd + 1);
  }

  const lineEnd = source.indexOf("\n", cursor);
  const effectiveLineEnd = lineEnd === -1 ? source.length : lineEnd;
  const senderPrefixEnd = source.indexOf(":", cursor);
  if (senderPrefixEnd !== -1 && senderPrefixEnd < effectiveLineEnd) {
    const senderPrefix = source.slice(cursor, senderPrefixEnd).trim();
    if (senderPrefix && senderPrefix.length <= 120 && matchesKnownSenderPrefix(senderPrefix, ctx)) {
      cursor = skipHorizontalWhitespace(source, senderPrefixEnd + 1);
    }
  }

  return cursor;
}

function stripLeadingMention(params: {
  source: string;
  start: number;
  trigger: string;
  commandText: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  isGroup: boolean;
}): number | undefined {
  const triggerLower = normalizeLowercaseStringOrEmpty(params.trigger);
  if (
    normalizeLowercaseStringOrEmpty(
      params.source.slice(params.start, params.start + params.trigger.length),
    ) === triggerLower
  ) {
    return params.start;
  }
  if (!params.isGroup) {
    return undefined;
  }

  let triggerStart = -1;
  for (let index = params.start; index < params.source.length; index += 1) {
    if (
      normalizeLowercaseStringOrEmpty(params.source.slice(index, index + params.trigger.length)) ===
      triggerLower
    ) {
      triggerStart = index;
      break;
    }
  }
  if (triggerStart === -1) {
    return undefined;
  }
  const prefix = params.source.slice(params.start, triggerStart);
  if (prefix.includes("\n")) {
    return undefined;
  }
  if (!stripMentions(prefix, params.ctx, params.cfg, params.agentId).trim()) {
    return triggerStart;
  }
  // Some channels remove a provider-native mention from commandText before
  // core sees it. Accept that projection only when the remaining raw suffix is exact.
  return params.ctx.WasMentioned === true &&
    params.source.slice(triggerStart).trimEnd() === params.commandText.trim()
    ? triggerStart
    : undefined;
}

function isRecognizedCommandSuffix(params: {
  suffix: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  isGroup: boolean;
}): boolean {
  const botUsername = params.ctx.BotUsername?.trim().replace(/^@/, "");
  if (
    botUsername &&
    normalizeLowercaseStringOrEmpty(params.suffix) === normalizeLowercaseStringOrEmpty(botUsername)
  ) {
    return true;
  }
  if (!params.isGroup) {
    return false;
  }
  return !stripMentions(`@${params.suffix}`, params.ctx, params.cfg, params.agentId).trim();
}

function resolveAnchoredResetPayload(params: {
  source: string;
  trigger: string;
  commandText: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  isGroup: boolean;
}): string | undefined {
  if (params.source === "") {
    return undefined;
  }
  const messageStart = resolveExplicitMessageStart(params.source, params.ctx);
  if (messageStart === undefined) {
    return undefined;
  }
  const triggerStart = stripLeadingMention({ ...params, start: messageStart });
  if (triggerStart === undefined) {
    return undefined;
  }

  let payloadStart = triggerStart + params.trigger.length;
  if (params.source[payloadStart] === "@") {
    const suffixStart = payloadStart + 1;
    payloadStart = suffixStart;
    while (
      params.source[payloadStart] !== undefined &&
      params.source[payloadStart] !== ":" &&
      !/\s/.test(params.source[payloadStart] ?? "")
    ) {
      payloadStart += 1;
    }
    const suffix = params.source.slice(suffixStart, payloadStart);
    if (
      !suffix ||
      !isRecognizedCommandSuffix({
        suffix,
        ctx: params.ctx,
        cfg: params.cfg,
        agentId: params.agentId,
        isGroup: params.isGroup,
      })
    ) {
      return undefined;
    }
  }

  const delimiter = params.source[payloadStart];
  if (delimiter === undefined) {
    return "";
  }
  if (delimiter === ":") {
    payloadStart += 1;
  } else if (!/\s/.test(delimiter)) {
    return undefined;
  }
  return params.source.slice(payloadStart).trimStart();
}

function resolveCommandTextForSession(params: {
  commandText: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  isGroup: boolean;
}): string {
  const messageStart = resolveExplicitMessageStart(params.commandText, params.ctx);
  const anchored =
    messageStart === undefined ? params.commandText.trim() : params.commandText.slice(messageStart);
  const withoutMentions = params.isGroup
    ? stripMentions(anchored, params.ctx, params.cfg, params.agentId)
    : anchored;
  return withoutMentions.replace(/\\n/g, " ").trim();
}

function isTranscriptOnlyCommand(ctx: MsgContext, commandText: string): boolean {
  return (
    typeof ctx.Transcript === "string" && commandText === ctx.Transcript.replace(/\\n/g, " ").trim()
  );
}

export function resolveSessionResetCommand(params: {
  commandText: string;
  rawText: string;
  resetTriggers: readonly string[];
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  isGroup: boolean;
  resetAuthorized: boolean;
}): ResolvedSessionResetCommand {
  const triggerBodyNormalized = resolveCommandTextForSession(params);
  const normalizedResetBody = normalizeCommandBody(triggerBodyNormalized, {
    botUsername: params.ctx.BotUsername,
  });
  const softResetMatched = parseSoftResetCommand(normalizedResetBody).matched;
  const result = {
    normalizedResetBody,
    softResetMatched,
    triggerBodyNormalized,
  } satisfies ResolvedSessionResetCommand;

  if (
    !params.resetAuthorized ||
    softResetMatched ||
    isTranscriptOnlyCommand(params.ctx, params.commandText)
  ) {
    return result;
  }

  const normalizedResetBodyLower = normalizeLowercaseStringOrEmpty(normalizedResetBody);
  for (const trigger of params.resetTriggers) {
    const triggerLower = normalizeLowercaseStringOrEmpty(trigger);
    if (
      !triggerLower ||
      (normalizedResetBodyLower !== triggerLower &&
        !normalizedResetBodyLower.startsWith(`${triggerLower} `))
    ) {
      continue;
    }
    const payload = resolveAnchoredResetPayload({
      source: params.rawText,
      trigger,
      commandText: params.commandText,
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
      isGroup: params.isGroup,
    });
    if (payload === undefined) {
      continue;
    }
    return {
      ...result,
      matchedResetTriggerLower: triggerLower,
      payload,
    };
  }

  return result;
}

export function resolveAuthorizedSessionResetCommand(params: {
  agentId: string;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
  ctx: MsgContext;
  isGroup: boolean;
}): { resetAuthorized: boolean; resetCommand: ResolvedSessionResetCommand } {
  const resetAuthorized = isResetAuthorizedForContext(params);
  return {
    resetAuthorized,
    resetCommand: resolveSessionResetCommand({
      commandText: params.ctx.commandText ?? "",
      rawText: params.ctx.rawText ?? "",
      resetTriggers: params.cfg.session?.resetTriggers?.length
        ? params.cfg.session.resetTriggers
        : DEFAULT_RESET_TRIGGERS,
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
      isGroup: params.isGroup,
      resetAuthorized,
    }),
  };
}
