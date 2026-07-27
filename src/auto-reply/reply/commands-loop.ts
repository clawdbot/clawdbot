// Handles /loop by rewriting chat sugar into a cron-tool work order.
import { parseDurationMs } from "../../cli/parse-duration.js";
import { truncateUtf16Safe } from "../../utils.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const LOOP_COMMAND_PREFIX = "/loop";
const LOOP_MIN_INTERVAL_MS = 30_000;
const LOOP_DEFAULT_INTERVAL_MS = 15 * 60_000;
const LOOP_NAME_MAX_LENGTH = 40;
const LOOP_USAGE =
  "Usage: /loop [interval] <prompt> — repeat a prompt in this chat (e.g. /loop 5m check deploy status). Without interval the loop self-paces between 1m and 1h. /loop status lists loops; /loop stop [name] stops.";

function directReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function applyLoopWorkOrderToContext(ctx: HandleCommandsParams["ctx"], instruction: string): void {
  const mutableCtx = ctx as HandleCommandsParams["ctx"] & {
    Body?: string;
    RawBody?: string;
    CommandBody?: string;
    BodyForCommands?: string;
    BodyForAgent?: string;
    BodyStripped?: string;
    commandText?: string;
    agentText?: string;
    rawText?: string;
  };
  mutableCtx.commandText = instruction;
  mutableCtx.agentText = instruction;
  mutableCtx.rawText = instruction;
  mutableCtx.Body = instruction;
  mutableCtx.RawBody = instruction;
  mutableCtx.CommandBody = instruction;
  mutableCtx.BodyForCommands = instruction;
  mutableCtx.BodyForAgent = instruction;
  mutableCtx.BodyStripped = instruction;
}

function applyLoopWorkOrder(params: HandleCommandsParams, instruction: string): void {
  applyLoopWorkOrderToContext(params.ctx, instruction);
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    applyLoopWorkOrderToContext(params.rootCtx, instruction);
  }
  params.command.rawBodyNormalized = instruction;
  params.command.commandBodyNormalized = instruction;
}

function loopNameForPrompt(prompt: string): { jobName: string; shortName: string } {
  const shortName = truncateUtf16Safe(prompt.trim(), LOOP_NAME_MAX_LENGTH).trimEnd();
  return { jobName: `loop: ${shortName}`, shortName };
}

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
      'After finishing, call the cron tool action:"next_check" with in:"<duration>" — pick the next check interval yourself based on how active the task is; back off toward 1h when quiet.',
    );
  }
  return lines.join("\n");
}

function buildFixedLoopWorkOrder(prompt: string, everyMs: number): string {
  const { jobName, shortName } = loopNameForPrompt(prompt);
  const message = buildLoopPayloadMessage({ prompt, shortName, selfPaced: false });
  return `Create a recurring loop with the cron tool, then confirm in one short line (name + cadence + '/loop stop' hint). action:"add", job:{name:${JSON.stringify(jobName)},schedule:{kind:"every",everyMs:${everyMs}},sessionTarget:"current",payload:{kind:"agentTurn",message:${JSON.stringify(message)}}}.`;
}

function buildSelfPacedLoopWorkOrder(prompt: string): string {
  const { jobName, shortName } = loopNameForPrompt(prompt);
  const message = buildLoopPayloadMessage({ prompt, shortName, selfPaced: true });
  return `Create a recurring loop with the cron tool, then confirm in one short line (name + cadence + '/loop stop' hint). action:"add", job:{name:${JSON.stringify(jobName)},schedule:{kind:"every",everyMs:${LOOP_DEFAULT_INTERVAL_MS}},pacing:{min:"1m",max:"1h"},sessionTarget:"current",payload:{kind:"agentTurn",message:${JSON.stringify(message)}}}.`;
}

function buildLoopStatusWorkOrder(sessionKey: string): string {
  return `Use the cron tool (action:"list") and report the loop jobs bound to this conversation (names starting with "loop:"): name, schedule/pacing, last run, next run. If none, say so. The list is agent-wide, so call action:"get" for each "loop:" candidate and include it only when its full definition has sessionTarget:"current" and sessionKey exactly ${JSON.stringify(sessionKey)}.`;
}

function buildLoopStopWorkOrder(name: string, sessionKey: string): string {
  const matchInstruction = name ? ` Match ${JSON.stringify(name)} against the job name.` : "";
  return `List cron jobs, find jobs named starting "loop:" bound to this conversation.${matchInstruction} Remove them with action:"remove" and confirm the removed names. If none matched, say so and list active loop names. The list is agent-wide: immediately before each removal, call action:"get" and remove only a job whose full definition has sessionTarget:"current" and sessionKey exactly ${JSON.stringify(sessionKey)}.`;
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
    applyLoopWorkOrder(params, buildLoopStatusWorkOrder(params.sessionKey));
    return { shouldContinue: true };
  }

  const [firstToken = ""] = spec.split(/\s+/u);
  if (firstToken.toLowerCase() === "stop") {
    const name = spec.slice(firstToken.length).trim();
    applyLoopWorkOrder(params, buildLoopStopWorkOrder(name, params.sessionKey));
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
    applyLoopWorkOrder(params, buildFixedLoopWorkOrder(prompt, everyMs));
    return { shouldContinue: true };
  }

  applyLoopWorkOrder(params, buildSelfPacedLoopWorkOrder(spec));
  return { shouldContinue: true };
};
