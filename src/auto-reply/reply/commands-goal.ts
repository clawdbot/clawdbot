/** Handles /goal session objective commands and continuation prompt formatting. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionEntry,
  getSessionGoal,
  updateSessionGoalStatus,
} from "../../config/sessions.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const GOAL_COMMAND_PREFIX = "/goal";
const GOAL_CONTINUATION_PROMPT_PREFIX =
  "Pursue this goal exactly as written from this JSON string:";
const GOAL_RESUME_NOTE_PROMPT_PREFIX =
  "Continue pursuing the current goal. Interpret this JSON string as the resume note:";
const GOAL_ACTIONS = new Set([
  "block",
  "blocked",
  "clear",
  "complete",
  "create",
  "done",
  "pause",
  "resume",
  "set",
  "start",
  "status",
]);

/** Parses /goal action text, defaulting unknown actions to goal creation. */
export function parseGoalCommand(raw: string): { action: string; text: string } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== GOAL_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  if (!argText) {
    return { action: "status", text: "" };
  }
  const [actionRaw = "", ...rest] = argText.split(/\s+/);
  const action = normalizeOptionalLowercaseString(actionRaw) ?? "status";
  if (!GOAL_ACTIONS.has(action)) {
    return { action: "start", text: argText };
  }
  return {
    action,
    text: rest.join(" ").trim(),
  };
}

function syncGoalSessionEntry(params: HandleCommandsParams): void {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  const entry = getSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    return;
  }
  params.sessionStore[params.sessionKey] = entry;
  params.sessionEntry = entry;
}

function goalReply(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}

function hasCommandLikeGoalText(trimmed: string): boolean {
  return /(?:^|\s)\//.test(trimmed) || trimmed.startsWith("!");
}

function encodeGoalJsonString(trimmed: string): string {
  return JSON.stringify(trimmed).replaceAll("/", "\\/");
}

/** Formats the model prompt used to continue a newly started goal. */
export function formatGoalContinuationPrompt(objective: string): string {
  const trimmed = objective.trim();
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_CONTINUATION_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : trimmed;
}

/** Formats the model prompt used when resuming a paused goal. */
export function formatGoalResumeContinuationPrompt(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) {
    return "Continue pursuing the current goal.";
  }
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_RESUME_NOTE_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : `Continue pursuing the current goal. Note: ${trimmed}`;
}

/** Returns true for internally generated goal continuation prompts. */
export function isFormattedGoalContinuationPrompt(message: string): boolean {
  const trimmed = message.trim();
  return (
    trimmed.startsWith(GOAL_CONTINUATION_PROMPT_PREFIX) ||
    trimmed.startsWith(GOAL_RESUME_NOTE_PROMPT_PREFIX)
  );
}

function applyGoalPromptToContext(ctx: HandleCommandsParams["ctx"], message: string): void {
  const mutableCtx = ctx as HandleCommandsParams["ctx"] & {
    Body?: string;
    RawBody?: string;
    CommandBody?: string;
    BodyForCommands?: string;
    BodyForAgent?: string;
    BodyStripped?: string;
  };
  mutableCtx.Body = message;
  mutableCtx.RawBody = message;
  mutableCtx.CommandBody = message;
  mutableCtx.BodyForCommands = message;
  mutableCtx.BodyForAgent = message;
  mutableCtx.BodyStripped = message;
}

function applyGoalContinuationPrompt(params: HandleCommandsParams, message: string): void {
  applyGoalPromptToContext(params.ctx, message);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyGoalPromptToContext(params.rootCtx, message);
  }
  params.command.rawBodyNormalized = message;
  params.command.commandBodyNormalized = message;
}

function goalContinuation(): CommandHandlerResult {
  return { shouldContinue: true };
}

function goalErrorReply(error: unknown): CommandHandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  return goalReply(`Goal error: ${message}`);
}

/** Command handler for /goal lifecycle commands. */
export const handleGoalCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseGoalCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/goal");
  if (unauthorized) {
    return unauthorized;
  }

  try {
    switch (parsed.action) {
      case "status": {
        const snapshot = await getSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          fallbackEntry: params.sessionEntry,
          persist: false,
        });
        syncGoalSessionEntry(params);
        return goalReply(formatSessionGoalStatus(snapshot.goal));
      }
      case "start":
      case "set":
      case "create": {
        const objective = normalizeOptionalString(parsed.text);
        if (!objective) {
          return goalReply("Usage: /goal start <objective>");
        }
        const goal = await createSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          objective,
          fallbackEntry: params.sessionEntry,
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        applyGoalContinuationPrompt(params, formatGoalContinuationPrompt(goal.objective));
        return goalContinuation();
      }
      case "pause": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "paused",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal paused: ${goal.objective}`);
      }
      case "resume": {
        await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "active",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        const message = formatGoalResumeContinuationPrompt(parsed.text);
        applyGoalContinuationPrompt(params, message);
        return goalContinuation();
      }
      case "complete":
      case "done": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "complete",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal complete: ${goal.objective}\nTokens used: ${goal.tokensUsed}`);
      }
      case "block":
      case "blocked": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "blocked",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        markCommandSessionMetadataChanged(params);
        return goalReply(`Goal blocked: ${goal.objective}`);
      }
      case "clear": {
        const removed = await clearSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
        syncGoalSessionEntry(params);
        if (removed) {
          markCommandSessionMetadataChanged(params);
        }
        return goalReply(removed ? "Goal cleared." : "No goal to clear.");
      }
      default:
        return goalReply(
          "Usage: /goal <objective> | /goal [status] | /goal start <objective> | /goal pause|resume|complete|block|clear",
        );
    }
  } catch (error) {
    return goalErrorReply(error);
  }
};
