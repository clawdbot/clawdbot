import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import {
  formatEmbeddedPiQueueFailureSummary,
  isEmbeddedPiRunActive,
  queueEmbeddedPiMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "./commands-steer.runtime.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

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
  const raw =
    params.ctx.CommandSource === "native"
      ? commandTarget || commandSession
      : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }

  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

function resolveStoredSessionEntry(
  params: HandleCommandsParams,
  targetSessionKey: string,
): SessionEntry | undefined {
  if (params.sessionStore?.[targetSessionKey]) {
    return params.sessionStore[targetSessionKey];
  }
  if (params.sessionKey === targetSessionKey) {
    return params.sessionEntry;
  }
  return undefined;
}

function resolveSteerSessionId(params: {
  commandParams: HandleCommandsParams;
  targetSessionKey: string;
}): string | undefined {
  const activeSessionId = resolveActiveEmbeddedRunSessionId(params.targetSessionKey);
  if (activeSessionId) {
    return activeSessionId;
  }

  const entry = resolveStoredSessionEntry(params.commandParams, params.targetSessionKey);
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!sessionId || !isEmbeddedPiRunActive(sessionId)) {
    return undefined;
  }
  return sessionId;
}

function applySteerFallbackPrompt(ctx: HandleCommandsParams["ctx"], message: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = message;
  mutableCtx.RawBody = message;
  mutableCtx.CommandBody = message;
  mutableCtx.BodyForCommands = message;
  mutableCtx.BodyForAgent = message;
  mutableCtx.BodyStripped = message;
}

function formatSteerError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function continueWithSteerFallback(
  params: HandleCommandsParams,
  message: string,
  logMessage: string,
): CommandHandlerResult {
  logVerbose(logMessage);
  applySteerFallbackPrompt(params.ctx, message);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applySteerFallbackPrompt(params.rootCtx, message);
  }
  params.command.rawBodyNormalized = message;
  params.command.commandBodyNormalized = message;
  return { shouldContinue: true };
}

export const handleSteerCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const message = parseSteerMessage(params.command.commandBodyNormalized);
  if (message === null) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/steer");
  if (unauthorized) {
    return unauthorized;
  }

  if (!message) {
    return { shouldContinue: false, reply: { text: STEER_USAGE } };
  }

  const targetSessionKey = resolveSteerTargetSessionKey(params);
  if (!targetSessionKey) {
    return continueWithSteerFallback(
      params,
      message,
      "steer: no current session; continuing with /steer payload as a normal prompt",
    );
  }

  const sessionId = resolveSteerSessionId({ commandParams: params, targetSessionKey });
  if (!sessionId) {
    return continueWithSteerFallback(
      params,
      message,
      `steer: no active run for ${targetSessionKey}; continuing with /steer payload as a normal prompt`,
    );
  }

  const queueOutcome = await queueEmbeddedPiMessageWithOutcomeAsync(sessionId, message, {
    steeringMode: "all",
    debounceMs: 0,
  }).catch((err: unknown): CommandHandlerResult => {
    return continueWithSteerFallback(
      params,
      message,
      `steer: active session ${sessionId} threw while steering: ${formatSteerError(err)}; continuing with /steer payload as a normal prompt`,
    );
  });
  if ("shouldContinue" in queueOutcome) {
    return queueOutcome;
  }
  if (!queueOutcome.queued) {
    const summary = formatEmbeddedPiQueueFailureSummary(queueOutcome);
    return continueWithSteerFallback(
      params,
      message,
      `steer: active session ${sessionId} rejected steering injection: ${summary}; continuing with /steer payload as a normal prompt`,
    );
  }

  return { shouldContinue: false, reply: { text: "steered current session." } };
};
