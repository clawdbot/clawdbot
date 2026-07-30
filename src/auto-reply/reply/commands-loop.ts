// Handles /loop by rewriting chat sugar into a cron-tool work order.
import { createHash } from "node:crypto";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { truncateUtf16Safe } from "../../utils.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const LOOP_COMMAND_PREFIX = "/loop";
const LOOP_MIN_INTERVAL_MS = 30_000;
const LOOP_DEFAULT_INTERVAL_MS = 15 * 60_000;
const LOOP_NAME_MAX_LENGTH = 40;
const LOOP_USAGE =
  "Usage: /loop [interval] <prompt> — repeat a prompt in this chat (e.g. /loop 5m check deploy status). Without interval the loop self-paces between 1m and 1h. /loop status lists loops; /loop stop [name] stops.";

function directReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function loopShortName(prompt: string): string {
  return truncateUtf16Safe(prompt.trim(), LOOP_NAME_MAX_LENGTH).trimEnd();
}

// Conversation tag baked into the job name at create time. Status/stop match by
// this same tag, so loop discovery never depends on how the cron side resolves
// session keys (which can differ from the command pipeline's sessionKey and
// made stored-binding checks misfire in live testing). 48 bits keeps accidental
// cross-conversation prefix collisions negligible; all matched jobs are still
// the owner's own agent jobs.
function loopConversationTag(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

function loopNamePrefix(sessionKey: string): string {
  return `loop[${loopConversationTag(sessionKey)}]`;
}

const LOOP_FINAL_REPLY_ONLY =
  "Reply with your normal final message only; do not use the message tool.";

function buildLoopPayloadMessage(params: {
  prompt: string;
  shortName: string;
  selfPaced: boolean;
}): string {
  const lines = [
    `[loop ${params.shortName}] ${params.prompt}`,
    "Do the task and reply concisely. If nothing changed since the last run, reply briefly.",
  ];
  if (params.selfPaced) {
    lines.push(
      'Before replying, ALWAYS call the cron tool action:"next_check" with in:"<duration>" — pick the next check interval from how active the task is; back off toward 1h when quiet.',
    );
  }
  return lines.join("\n");
}

function buildFixedLoopWorkOrder(prompt: string, everyMs: number, sessionKey: string): string {
  const shortName = loopShortName(prompt);
  const jobName = `${loopNamePrefix(sessionKey)} ${shortName}`;
  const message = buildLoopPayloadMessage({ prompt, shortName, selfPaced: false });
  return `Create a recurring loop with the cron tool, then confirm in one short line (name + cadence + '/loop stop' hint). ${LOOP_FINAL_REPLY_ONLY} action:"add", job:{name:${JSON.stringify(jobName)},schedule:{kind:"every",everyMs:${everyMs}},sessionTarget:"current",payload:{kind:"agentTurn",message:${JSON.stringify(message)}}}.`;
}

function buildSelfPacedLoopWorkOrder(prompt: string, sessionKey: string): string {
  const shortName = loopShortName(prompt);
  const jobName = `${loopNamePrefix(sessionKey)} ${shortName}`;
  const message = buildLoopPayloadMessage({ prompt, shortName, selfPaced: true });
  return `Create a recurring loop with the cron tool, then confirm in one short line (name + cadence + '/loop stop' hint). ${LOOP_FINAL_REPLY_ONLY} action:"add", job:{name:${JSON.stringify(jobName)},schedule:{kind:"every",everyMs:${LOOP_DEFAULT_INTERVAL_MS}},pacing:{min:"1m",max:"1h"},sessionTarget:"current",payload:{kind:"agentTurn",message:${JSON.stringify(message)}}}.`;
}

function buildLoopStatusWorkOrder(sessionKey: string): string {
  const prefix = loopNamePrefix(sessionKey);
  return `Use the cron tool (action:"list", includeDisabled:true) and report this conversation's loop jobs — exactly those whose name starts with ${JSON.stringify(prefix)}: name, schedule/pacing, enabled, last run, next run. If none, say so. ${LOOP_FINAL_REPLY_ONLY}`;
}

function buildLoopStopWorkOrder(name: string, sessionKey: string): string {
  const prefix = loopNamePrefix(sessionKey);
  const matchInstruction = name
    ? ` Among those, match ${JSON.stringify(name)} against the job name.`
    : "";
  return `List cron jobs (action:"list", includeDisabled:true) and find this conversation's loops — exactly those whose name starts with ${JSON.stringify(prefix)}.${matchInstruction} Remove the matching jobs with action:"remove" and confirm the removed names. If none matched, say so and list this conversation's active loop names. Never remove a job whose name does not start with ${JSON.stringify(prefix)}. ${LOOP_FINAL_REPLY_ONLY}`;
}

/** Command handler for conversation-bound recurring loops. */
export const handleLoopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const trimmed = params.command.commandBodyNormalized.trim();
  const commandEnd = trimmed.search(/\s/u);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (commandToken.toLowerCase() !== LOOP_COMMAND_PREFIX) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, LOOP_COMMAND_PREFIX);
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, LOOP_COMMAND_PREFIX);
  if (nonOwner) {
    return nonOwner;
  }

  const spec = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  if (!spec || spec.toLowerCase() === "help") {
    return directReply(LOOP_USAGE);
  }
  if (spec.toLowerCase() === "status") {
    applyCommandTextToParams(params, buildLoopStatusWorkOrder(params.sessionKey));
    return { shouldContinue: true };
  }

  const [firstToken = ""] = spec.split(/\s+/u);
  if (firstToken.toLowerCase() === "stop") {
    const name = spec.slice(firstToken.length).trim();
    applyCommandTextToParams(params, buildLoopStopWorkOrder(name, params.sessionKey));
    return { shouldContinue: true };
  }

  let everyMs: number | undefined;
  // Preserve parseDurationMs semantics: bare numbers are milliseconds.
  // The 30s floor rejects hot-loop values instead of reinterpreting them as prompt text.
  try {
    everyMs = parseDurationMs(firstToken);
  } catch {
    everyMs = undefined;
  }
  if (everyMs !== undefined) {
    if (everyMs < LOOP_MIN_INTERVAL_MS) {
      return directReply(`${LOOP_USAGE} Minimum interval 30s.`);
    }
    const prompt = spec.slice(firstToken.length).trim();
    if (!prompt) {
      return directReply(LOOP_USAGE);
    }
    applyCommandTextToParams(params, buildFixedLoopWorkOrder(prompt, everyMs, params.sessionKey));
    return { shouldContinue: true };
  }

  applyCommandTextToParams(params, buildSelfPacedLoopWorkOrder(spec, params.sessionKey));
  return { shouldContinue: true };
};
