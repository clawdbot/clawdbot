/** Model tools for proposing and withdrawing operator-approved follow-up work. */
import path from "node:path";
import { Type } from "typebox";
import type {
  TaskSuggestionsCreateResult,
  TaskSuggestionsDismissResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
  SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, jsonResult, readToolStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const SuggestTaskToolSchema = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: 60,
      description:
        "Imperative task title under 60 characters (start with a verb); shown as the card title and the started session's name.",
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 32_768,
      description:
        "Self-contained task prompt with file paths and enough context to act without this conversation.",
    }),
    tldr: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description:
        "One or two plain-language sentences shown on the card explaining the value; no code or paths.",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_096,
        description: "Absolute path inside a git checkout; defaults to the current project.",
      }),
    ),
  },
  { additionalProperties: false },
);

const SuggestTaskOutputSchema = Type.Object(
  { task_id: Type.String() },
  { additionalProperties: false },
);

const DismissTaskToolSchema = Type.Object(
  {
    task_id: Type.String({
      minLength: 1,
      maxLength: 128,
      description: "ID returned by the pending suggestion.",
    }),
    reason: Type.Optional(
      Type.String({ maxLength: 1_024, description: "Short reason the suggestion is stale." }),
    ),
  },
  { additionalProperties: false },
);

type GatewayCaller = typeof callGatewayTool;

export function createTaskSuggestionTools(params: {
  sessionKey: string;
  agentId?: string;
  cwd: string;
  callGateway?: GatewayCaller;
}): AnyAgentTool[] {
  const gatewayCall = params.callGateway ?? callGatewayTool;
  return [
    {
      label: "Suggest Task",
      name: "suggest_task",
      displaySummary: SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
      description: [
        "Flag an out-of-scope issue as a separate follow-up task instead of ignoring it, fixing it inline, or only mentioning it in your reply — a follow-up described in prose is lost; recording it here is what surfaces it to the operator.",
        "Nothing is spawned or started: this only records a card.",
        "This is the tool behind requests like 'flag it as a follow-up', 'note that for later', or 'make a task for that'; whenever you would write 'Follow-up:' in a reply, call this instead.",
        "Use this whenever work you were not asked to do surfaces along the way: dead code, stale docs, missing coverage, a confirmed TODO, or a security issue spotted in passing.",
        "Requests to stay scoped or skip cleanup apply to doing the work, not to flagging it: this only records a suggestion card in the operator's UI; nothing runs unless they accept it, and your current turn continues uninterrupted.",
        "Do not flag vague code-smell observations or low-confidence hunches.",
        "The prompt must stand alone: the started task sees only that text, never this conversation.",
        "cwd must be an absolute path inside a git checkout.",
        "Suggestions are ephemeral; ids do not survive a gateway restart.",
      ].join(" "),
      parameters: SuggestTaskToolSchema,
      outputSchema: SuggestTaskOutputSchema,
      execute: async (_toolCallId, args) => {
        const input = args as Record<string, unknown>;
        const title = readToolStringParam(input, "title", { required: true });
        const prompt = readToolStringParam(input, "prompt", { required: true });
        const tldr = readToolStringParam(input, "tldr", { required: true });
        const cwd = readToolStringParam(input, "cwd") ?? params.cwd;
        if (title.length > 60) {
          throw new ToolInputError("title must be at most 60 characters");
        }
        if (!path.isAbsolute(cwd)) {
          throw new ToolInputError("cwd must be an absolute path");
        }
        const result = await gatewayCall<TaskSuggestionsCreateResult>(
          "taskSuggestions.create",
          {},
          {
            title,
            prompt,
            tldr,
            cwd,
            sessionKey: params.sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          },
        );
        return jsonResult({ task_id: result.taskId });
      },
    },
    {
      label: "Dismiss Task",
      name: "dismiss_task",
      displaySummary: DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
      description: [
        "Withdraw a pending suggestion card you created when it is now stale, superseded, or already handled in this session.",
        "To replace a card, record the better suggestion first, then dismiss the old task_id.",
        "Only cards the operator has not acted on can be withdrawn; accepted ones cannot.",
      ].join(" "),
      parameters: DismissTaskToolSchema,
      execute: async (_toolCallId, args) => {
        const input = args as Record<string, unknown>;
        const taskId = readToolStringParam(input, "task_id", { required: true });
        const reason = readToolStringParam(input, "reason");
        const result = await gatewayCall<TaskSuggestionsDismissResult>(
          "taskSuggestions.dismiss",
          {},
          {
            taskId,
            ...(reason ? { reason } : {}),
          },
        );
        return jsonResult({ task_id: taskId, dismissed: result.dismissed });
      },
    },
  ];
}
