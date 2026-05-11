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
  queueEmbeddedPiMessageWithOutcome,
  resolveActiveEmbeddedRunSessionId,
} from "./commands-steer.runtime.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const STEER_USAGE = "Usage: /steer <message>";

function formatSteerQueueFailureReply(reason: string): string {
  if (reason === "no_active_run") {
    return "⚠️ This session no longer has an active run to steer.";
  }
  if (reason === "not_streaming") {
    return "⚠️ Current run is active but not accepting steering right now.";
  }
  if (reason === "compacting") {
    return "⚠️ Current run is compacting; retry after compaction finishes.";
  }
  return "⚠️ Current run is active but not accepting steering right now.";
}

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
    return { shouldContinue: false, reply: { text: "⚠️ No current session to steer." } };
  }

  const sessionId = resolveSteerSessionId({ commandParams: params, targetSessionKey });
  if (!sessionId) {
    return { shouldContinue: false, reply: { text: "⚠️ No active run to steer in this session." } };
  }

  const queueOutcome = queueEmbeddedPiMessageWithOutcome(sessionId, message, {
    steeringMode: "all",
    debounceMs: 0,
  });
  if (!queueOutcome.queued) {
    const summary = formatEmbeddedPiQueueFailureSummary(queueOutcome);
    logVerbose(`steer: active session ${sessionId} rejected steering injection: ${summary}`);
    return {
      shouldContinue: false,
      reply: { text: formatSteerQueueFailureReply(queueOutcome.reason) },
    };
  }

  return { shouldContinue: false, reply: { text: "steered current session." } };
};
