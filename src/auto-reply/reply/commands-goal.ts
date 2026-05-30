import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionEntry,
  getSessionGoal,
  updateSessionGoalStatus,
} from "../../config/sessions.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const GOAL_COMMAND_PREFIX = "/goal";
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

function goalErrorReply(error: unknown): CommandHandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  return goalReply(`Goal error: ${message}`);
}

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
        return goalReply(`Goal started: ${goal.objective}`);
      }
      case "pause": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "paused",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        return goalReply(`Goal paused: ${goal.objective}`);
      }
      case "resume": {
        const goal = await updateSessionGoalStatus({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          status: "active",
          ...(parsed.text ? { note: parsed.text } : {}),
        });
        syncGoalSessionEntry(params);
        return goalReply(`Goal resumed: ${goal.objective}`);
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
        return goalReply(`Goal blocked: ${goal.objective}`);
      }
      case "clear": {
        const removed = await clearSessionGoal({
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
        syncGoalSessionEntry(params);
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
