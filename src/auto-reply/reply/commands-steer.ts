// Implements steer commands that persist per-session agent guidance.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
  type ReplyMessageInjectionTarget,
} from "./reply-run-registry.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority.js";

const STEER_USAGE = "Usage: /steer <message>";

function parseSteerMessage(raw: string): string | null {
  const match = raw.trim().match(/^\/(?:steer|tell)(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

function resolveSteerTargetSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
  const commandSession = normalizeOptionalString(params.sessionKey);
  const raw = isNativeCommandTurn(resolveCommandTurnContext(params.ctx))
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }

  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

function listSteerCandidateSessionKeys(targetSessionKey: string): string[] {
  const candidates = [targetSessionKey];
  // Text slash turns still arrive on a source-only :slash: lane while the
  // direct conversation owns the reply operation (#104844, #116763).
  if (targetSessionKey.includes(":slash:")) {
    candidates.push(
      targetSessionKey.replace(":slash:", ":direct:"),
      targetSessionKey.replace(":slash:", ":dm:"),
    );
  }
  return [...new Set(candidates)];
}

function resolveSteerTarget(
  targetSessionKey: string,
): { sessionId: string; sessionKey: string; target: ReplyMessageInjectionTarget } | undefined {
  const candidateKeys = listSteerCandidateSessionKeys(targetSessionKey);
  for (const candidateKey of candidateKeys) {
    const operation = replyRunRegistry.get(candidateKey);
    const target = operation
      ? replyRunRegistry.resolveCurrentMessageInjectionTarget(candidateKey)
      : undefined;
    if (operation && target) {
      return { sessionId: operation.sessionId, sessionKey: candidateKey, target };
    }
  }

  return undefined;
}

function continueWithSteerFallback(
  params: HandleCommandsParams,
  message: string,
  logMessage: string,
): CommandHandlerResult {
  logVerbose(logMessage);
  applyCommandTextToParams(params, message);
  return { shouldContinue: true };
}

export const handleSteerCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/steer", match: parseSteerMessage },
  async (params, message) => {
    if (!message) {
      return commandReply(STEER_USAGE);
    }

    const targetSessionKey = resolveSteerTargetSessionKey(params);
    if (!targetSessionKey) {
      return continueWithSteerFallback(
        params,
        message,
        "steer: no current session; continuing with /steer payload as a normal prompt",
      );
    }

    const steerTarget = resolveSteerTarget(targetSessionKey);
    if (!steerTarget) {
      return continueWithSteerFallback(
        params,
        message,
        `steer: no active run for ${targetSessionKey}; continuing with /steer payload as a normal prompt`,
      );
    }

    const finalization = await finalizeReplyMessageInjectionAttempt({
      target: steerTarget.target,
      attempt: beginReplyMessageInjectionTarget(steerTarget.target, message, {
        steeringMode: "all",
        isInboundUserMessage: true,
        toolAuthorityOverlay: resolveInboundReplyToolAuthorityOverlay({
          ctx: params.ctx,
          sessionEntry:
            params.sessionStore?.[steerTarget.sessionKey] ??
            (params.sessionKey === steerTarget.sessionKey ? params.sessionEntry : undefined),
          senderIsOwner: params.command.senderIsOwner,
          toolsAllow: params.opts?.toolsAllow,
          disableTools: params.opts?.disableTools === true,
        }),
        debounceMs: 0,
        ...(params.opts?.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: params.opts.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: params.opts?.taskSuggestionDeliveryMode,
      }),
    }).catch((err: unknown): CommandHandlerResult => {
      return continueWithSteerFallback(
        params,
        message,
        `steer: active session ${steerTarget.sessionId} threw while steering: ${formatErrorMessage(err)}; continuing with /steer payload as a normal prompt`,
      );
    });
    if ("shouldContinue" in finalization) {
      return finalization;
    }
    if (finalization.status === "rejected") {
      return continueWithSteerFallback(
        params,
        message,
        `steer: active session ${steerTarget.sessionId} rejected steering injection (${finalization.outcome.reason}); continuing with /steer payload as a normal prompt`,
      );
    }

    return commandReply("steered current session.");
  },
);
