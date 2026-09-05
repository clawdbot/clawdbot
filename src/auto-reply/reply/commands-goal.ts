/** Handles /goal session objective commands and continuation prompt formatting. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  clearSessionGoal,
  createSessionGoal,
  formatSessionGoalStatus,
  getSessionGoal,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../../config/sessions.js";
import { loadSessionEntry as getSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply as goalReply, defineAuthorizedTextCommand } from "./command-gates.js";
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
  "edit",
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

function hasCommandLikeGoalText(trimmed: string): boolean {
  return /(?:^|\s)\//.test(trimmed) || trimmed.startsWith("!");
}

function encodeGoalJsonString(trimmed: string): string {
  return JSON.stringify(trimmed).replaceAll("/", "\\/");
}

function formatGoalContinuationPrompt(objective: string): string {
  const trimmed = objective.trim();
  return hasCommandLikeGoalText(trimmed)
    ? `${GOAL_CONTINUATION_PROMPT_PREFIX} ${encodeGoalJsonString(trimmed)}`
    : trimmed;
}

function formatGoalResumeContinuationPrompt(note: string): string {
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

function goalContinuation(): CommandHandlerResult {
  return { shouldContinue: true };
}

function goalErrorReply(error: unknown): CommandHandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  return goalReply(`Goal error: ${message}`);
}

type ParsedGoalCommand = NonNullable<ReturnType<typeof parseGoalCommand>>;

type SessionGoalCommandResult = {
  text: string;
  continuationPrompt?: string;
  changed: boolean;
};

/** Execute goal storage policy once for auto-reply, Gateway, and embedded callers. */
export async function executeSessionGoalCommand(params: {
  parsed: ParsedGoalCommand;
  sessionKey: string;
  storePath?: string;
  fallbackEntry?: SessionEntry;
  agentId?: string;
  readOnlyStatus?: boolean;
}): Promise<SessionGoalCommandResult> {
  const common = {
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    actor: { type: "human" as const },
    agentId: params.agentId,
  };
  const note = params.parsed.text ? { note: params.parsed.text } : {};

  switch (params.parsed.action) {
    case "status": {
      const snapshot = await getSessionGoal({
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        ...(params.readOnlyStatus ? { fallbackEntry: params.fallbackEntry, persist: false } : {}),
      });
      return { text: formatSessionGoalStatus(snapshot.goal), changed: false };
    }
    case "start":
    case "set":
    case "create": {
      const objective = normalizeOptionalString(params.parsed.text);
      if (!objective) {
        return { text: "Usage: /goal start <objective>", changed: false };
      }
      const goal = await createSessionGoal({
        ...common,
        objective,
        fallbackEntry: params.fallbackEntry,
      });
      return {
        text: `Goal started: ${goal.objective}`,
        continuationPrompt: formatGoalContinuationPrompt(goal.objective),
        changed: true,
      };
    }
    case "edit": {
      const objective = normalizeOptionalString(params.parsed.text);
      if (!objective) {
        return { text: "Usage: /goal edit <objective>", changed: false };
      }
      const goal = await updateSessionGoalObjective({ ...common, objective });
      return { text: `Goal updated: ${goal.objective}`, changed: true };
    }
    case "pause": {
      const goal = await updateSessionGoalStatus({ ...common, status: "paused", ...note });
      return { text: `Goal paused: ${goal.objective}`, changed: true };
    }
    case "resume": {
      const goal = await updateSessionGoalStatus({ ...common, status: "active", ...note });
      return {
        text: `Goal resumed: ${goal.objective}`,
        continuationPrompt: formatGoalResumeContinuationPrompt(params.parsed.text),
        changed: true,
      };
    }
    case "complete":
    case "done": {
      const goal = await updateSessionGoalStatus({ ...common, status: "complete", ...note });
      return {
        text: `Goal complete: ${goal.objective}\nTokens used: ${goal.tokensUsed}`,
        changed: true,
      };
    }
    case "block":
    case "blocked": {
      const goal = await updateSessionGoalStatus({ ...common, status: "blocked", ...note });
      return { text: `Goal blocked: ${goal.objective}`, changed: true };
    }
    case "clear": {
      const removed = await clearSessionGoal(common);
      return {
        text: removed ? "Goal cleared." : "No goal to clear.",
        changed: removed,
      };
    }
    default:
      return {
        text: "Usage: /goal <objective> | /goal [status] | /goal start <objective> | /goal edit <objective> | /goal pause|resume|complete|block|clear",
        changed: false,
      };
  }
}

/** Command handler for /goal lifecycle commands. */
export const handleGoalCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/goal", match: parseGoalCommand },
  async (params, parsed) => {
    try {
      const result = await executeSessionGoalCommand({
        parsed,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        fallbackEntry: params.sessionEntry,
        agentId: params.agentId,
        readOnlyStatus: true,
      });
      if (result.changed || parsed.action === "status" || parsed.action === "clear") {
        syncGoalSessionEntry(params);
      }
      if (result.changed) {
        markCommandSessionMetadataChanged(params);
      }
      if (result.continuationPrompt) {
        applyCommandTextToParams(params, result.continuationPrompt);
        return goalContinuation();
      }
      return goalReply(result.text);
    } catch (error) {
      return goalErrorReply(error);
    }
  },
);
