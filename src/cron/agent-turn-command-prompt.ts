import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";

type UnknownRecord = Record<string, unknown>;

export type CronAgentTurnCommandPrompt = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
};

export type CronAgentTurnShellPromptKind = "commandPromptWithoutShellAccess" | "shellToolPrompt";

const COMMAND_MARKER_RE = /\bCommand to run\s*:/iu;
const COMMAND_FIELD_RE = /^\s*-\s*(command|workdir|timeout)\s*:\s*(.*?)\s*$/iu;
const SHELL_COMMAND_MESSAGE_RE =
  /\b(?:bash|command|execute|exec|process|run|shell)\b[\s\S]{0,240}\b(?:python3?|node|bun|pnpm|npm|npx|yarn|sh|bash|sudo|cd|\.\/|\/[A-Za-z0-9._/-]+)\b/iu;

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parses the legacy structured command block used by isolated agent prompts. */
export function parseCronAgentTurnCommandPrompt(value: unknown): CronAgentTurnCommandPrompt | null {
  const message = normalizeOptionalString(value);
  if (!message || !COMMAND_MARKER_RE.test(message)) {
    return null;
  }

  let command = "";
  let cwd: string | undefined;
  let timeoutSeconds: number | undefined;
  for (const line of message.split(/\r?\n/u)) {
    const match = COMMAND_FIELD_RE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]?.toLowerCase();
    const fieldValue = match[2]?.trim() ?? "";
    if (key === "command" && fieldValue && !command) {
      command = fieldValue;
    } else if (key === "workdir" && fieldValue && !cwd) {
      cwd = fieldValue;
    } else if (key === "timeout" && fieldValue && timeoutSeconds === undefined) {
      timeoutSeconds = parsePositiveInteger(fieldValue);
    }
  }
  return command
    ? { command, ...(cwd ? { cwd } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) }
    : null;
}

/** Returns whether an agent-turn cap explicitly permits a shell/process tool. */
export function hasCronShellToolAccess(toolsAllow: unknown): boolean {
  if (toolsAllow === undefined) {
    return true;
  }
  if (!Array.isArray(toolsAllow)) {
    return false;
  }
  if (!toolsAllow.every((tool): tool is string => typeof tool === "string")) {
    return false;
  }
  if (toolsAllow.some((tool) => tool.trim().length === 0)) {
    return false;
  }
  return isRuntimeToolAllowed("exec", toolsAllow) || isRuntimeToolAllowed("process", toolsAllow);
}

/** Classifies only command-like agent turns that need cron operator attention. */
export function classifyCronAgentTurnShellPrompt(
  payload: UnknownRecord,
): CronAgentTurnShellPromptKind | null {
  if (payload.kind !== "agentTurn") {
    return null;
  }
  const message = normalizeOptionalString(payload.message);
  if (!message) {
    return null;
  }
  const parsed = parseCronAgentTurnCommandPrompt(message);
  const shellToolAccess = hasCronShellToolAccess(payload.toolsAllow);
  if (parsed && !shellToolAccess) {
    return "commandPromptWithoutShellAccess";
  }
  if (shellToolAccess && SHELL_COMMAND_MESSAGE_RE.test(message)) {
    return "shellToolPrompt";
  }
  return null;
}
